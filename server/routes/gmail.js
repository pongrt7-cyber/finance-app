const express = require('express');
// Gmail transaction parser: bank-specific, strict amount detection.
const crypto = require('crypto');
const { google } = require('googleapis');
const db = require('../db');
const { dateText, TZ } = require('../utils/date');
const { findCrossSourceDuplicate } = require('../utils/duplicate');
const { createGmailPush } = require('../utils/gmail-push');

const router = express.Router();
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/api/gmail/oauth2callback';

function oauthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    REDIRECT_URI
  );
}

function encryptionKey() {
  return crypto.createHash('sha256').update(process.env.JWT_SECRET || 'finance-app-secret').digest();
}

function seal(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

function unseal(value) {
  const [iv, tag, data] = String(value).split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(data, 'base64url')),
    decipher.final()
  ]).toString('utf8');
}

function saveToken(token) {
  db.prepare("INSERT INTO settings(key,value) VALUES('gmail_oauth',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(seal(JSON.stringify(token)));
}

function loadToken() {
  const row = db.prepare("SELECT value FROM settings WHERE key='gmail_oauth'").get();
  return row ? JSON.parse(unseal(row.value)) : null;
}

function getSetting(key) {
  return db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value || null;
}

function setSetting(key, value) {
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(key, String(value));
}

function gmailPubSubTopic() {
  return String(process.env.GMAIL_PUBSUB_TOPIC || '').trim();
}

async function verifyPubSubRequest(req) {
  const auth = String(req.headers.authorization || '');
  if (!auth.startsWith('Bearer ')) throw new Error('missing_pubsub_auth');
  const token = auth.slice(7).trim();
  const audience = String(process.env.GMAIL_PUBSUB_AUDIENCE || '').trim();
  const serviceAccount = String(process.env.GMAIL_PUBSUB_SERVICE_ACCOUNT || '').trim();
  if (!audience || !serviceAccount) throw new Error('pubsub_auth_not_configured');

  const client = new google.auth.OAuth2();
  const ticket = await client.verifyIdToken({ idToken: token, audience });
  const payload = ticket.getPayload() || {};
  if (payload.email !== serviceAccount) throw new Error('unexpected_pubsub_service_account');
  return payload;
}

function header(headers, name) {
  return (headers || []).find(h => String(h.name || '').toLowerCase() === name.toLowerCase())?.value || '';
}

function decodePart(data = '') {
  return Buffer.from(String(data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function htmlText(input = '') {
  return String(input)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function bodyFromPayload(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) return decodePart(payload.body.data);
  if (payload.mimeType === 'text/html' && payload.body?.data) return htmlText(decodePart(payload.body.data));
  for (const part of payload.parts || []) {
    const text = bodyFromPayload(part);
    if (text) return text;
  }
  return '';
}

function normalizeText(text = '') {
  return String(text)
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b\u200c\u200d]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function numberFrom(value) {
  if (value == null) return null;
  const n = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(n) && n > 0 && n < 100000000 ? n : null;
}

// Deliberately strict: never take an arbitrary number from a bank email.
// Only numbers attached to transaction-amount labels or a very explicit
// transaction sentence are eligible. Balance/account/reference numbers are not.
function parseAmount(subject = '', body = '') {
  const text = normalizeText(`${subject} ${body}`);
  const lower = text.toLowerCase();
  if (/monthly statement|account statement|trade statement|order history|สรุปรายการลงทุน|ใบแจ้งยอด/i.test(lower)) return null;
  const n = '([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)';
  const labels = '(?:จำนวนเงิน|ยอดรายการ|ยอดธุรกรรม|ยอดชำระ|ยอดโอน|ยอดใช้จ่าย|ยอดเงินที่ทำรายการ|transaction amount|transaction value|payment amount|purchase amount|amount paid|amount|total paid|paid)';
  const m = text.match(new RegExp(labels + '\\s*[:：=]?\\s*(?:THB|฿|บาท)?\\s*' + n + '\\s*(?:THB|฿|บาท)?', 'i'));
  if (m) return numberFrom(m[1]);
  const fallback = text.match(new RegExp('(?:โอนเงิน|โอน|ชำระเงิน|ชำระ|จ่าย|ซื้อ|ถอนเงิน|ฝากเงิน|รับเงิน|เงินเข้า|เงินออก)[^0-9]{0,40}(?:THB|฿)?\\s*' + n + '(?:\\s*(?:THB|฿|บาท))?', 'i'));
  return fallback ? numberFrom(fallback[1]) : null;
}

function detectBank(from, subject, body) {
  const t = `${from} ${subject} ${body}`.toLowerCase();
  if (/ttbbank|ttb|tmbthanachart/.test(t)) return 'ttb';
  if (/kasikornbank|kbank|k-plus|k plus/.test(t)) return 'kplus';
  if (/scb\.co\.th|scb|ไทยพาณิชย์|siam commercial/.test(t)) return 'scb';
  return null;
}

function detectType(subject, body) {
  const t = normalizeText(`${subject} ${body}`).toLowerCase();

  const incomePatterns = [
    /เงินเข้า/, /รับเงิน/, /เงินโอนเข้า/, /โอนเข้าบัญชี/, /ฝากเงิน/, /ได้รับเงิน/, /credited/, /credit(?:ed)?\s+to/, /deposit(?:ed)?/, /received/, /incoming transfer/, /cashback/, /refund/,
    /เงินเดือน/, /salary/
  ];
  const expensePatterns = [
    /เงินออก/, /โอนออก/, /โอนเงินออก/, /โอนเงินไป/, /โอนไป/, /รายการโอน/, /โอน.*ธนาคารอื่น/, /ชำระเงิน/, /ชำระ/, /จ่าย/, /ซื้อสินค้า/, /ถอนเงิน/, /หักบัญชี/, /หักเงิน/, /payment/, /purchase/, /debit(?:ed)?/, /withdrawal/, /sent/, /outgoing transfer/, /bill payment/
  ];

  const income = incomePatterns.some(re => re.test(t));
  const expense = expensePatterns.some(re => re.test(t));
  if (income && !expense) return 'income';
  if (expense && !income) return 'expense';
  return null;
}

function learnedCategory(subject, body, merchantName = '') {
  const text = normalizeText(`${subject} ${body} ${merchantName}`).toLowerCase();
  try {
    const rules = db.prepare(`SELECT cr.pattern, c.name FROM category_rules cr JOIN categories c ON c.id=cr.category_id ORDER BY length(cr.pattern) DESC, cr.use_count DESC`).all();
    const hit = rules.find(rule => rule.pattern && text.includes(String(rule.pattern).toLowerCase()));
    return hit?.name || null;
  } catch {
    return null;
  }
}

function classify(subject, body, merchantName = '') {
  const learned = learnedCategory(subject, body, merchantName);
  if (learned) return learned;
  const t = normalizeText(`${subject} ${body}`).toLowerCase();
  // Transfers are not internet/IT expenses. Keep them neutral unless a real merchant is identified.
  if (/successfully\s+transfer|success transfer|รายการโอน|โอนเงินเสร็จสมบูรณ์|โอนเงินสำเร็จ/.test(t)) return 'อื่นๆ';
  if (/food|restaurant|cafe|coffee|grabfood|lineman|7-eleven|lotus|big c|makro|อาหาร|ร้านอาหาร|กาแฟ|เครื่องดื่ม|ของกิน/.test(t)) return 'ค่ากิน';
  if (/shopee|lazada|amazon|shopping|ของใช้|สินค้า|ช้อป/.test(t)) return 'ของใช้';
  if (/fuel|gas station|ptt|น้ำมัน|ปั๊ม/.test(t)) return 'ค่าน้ำมัน';
  if (/netflix|spotify|youtube premium|subscription|สมาชิก|สตรีม/.test(t)) return 'อื่นๆ';
  if (/phone|mobile|internet|ais|true|dtac|ค่าโทร|อินเทอร์เน็ต|โทรศัพท์/.test(t)) return 'ค่าเน็ต';
  if (/rent|ค่าเช่า|ค่าห้อง/.test(t)) return 'ค่าห้อง';
  if (/computer|laptop|iphone|ipad|it|อุปกรณ์ไอที/.test(t)) return 'อุปกรณ์ไอที';
  if (/shirt|clothes|เสื้อผ้า|เครื่องแต่งกาย/.test(t)) return 'เสื้อผ้า';
  if (/game|gaming|เกม/.test(t)) return 'เกม';
  return 'อื่นๆ';
}

function merchant(subject, body) {
  const t = normalizeText(`${subject} ${body}`);
  const known = [
    ['7-Eleven', /7-?eleven/i], ['Shopee', /shopee/i], ['Lazada', /lazada/i], ['Grab', /grab/i],
    ['LINE MAN', /line\s*man/i], ['Netflix', /netflix/i], ['Spotify', /spotify/i], ['AIS', /ais/i],
    ['True', /\btrue\b/i], ['dtac', /dtac/i], ['PTT', /\bptt\b/i], ['Lotus', /lotus/i],
    ['Big C', /big\s*c/i], ['Makro', /makro/i]
  ];
  for (const [name, re] of known) if (re.test(t)) return name;

  // ttb transfer emails: never use generic English "to/from" extraction.
  // Footer text can contain phrases such as "of this e-mail", which is not a merchant.
  const cleanTarget = value => value
    .trim()
    .split(/\s+(?:Favorite Nickname|ชื่อรายการโปรด|Amount|จำนวนเงิน|Fee|ค่าธรรมเนียม)\s*[:：-]?/i)[0]
    .trim();

  const toMobile = t.match(/(?:ToMobile\s*No|ไปยังเบอร์มือถือ)\s*[:：-]?\s*(.{2,80})/i);
  if (toMobile) return `โอนไป ${cleanTarget(toMobile[1])}`;

  const toCitizen = t.match(/(?:ToCitizen\s*ID\s*\/\s*Tax\s*ID|ไปยังเลขบัตรประชาชน)\s*[:：-]?\s*(.{2,80})/i);
  if (toCitizen) return `โอนไป ${cleanTarget(toCitizen[1])}`;

  const toAccount = t.match(/(?:To\s*Account|ไปยังบัญชี)\s*[:：-]?\s*(.{2,80})/i);
  if (toAccount) return `โอนไป ${cleanTarget(toAccount[1])}`;

  const biller = t.match(/(?:Biller\s*Name|ชื่อผู้รับชำระ|ผู้รับชำระ)\s*[:：-]?\s*([^|,]{2,80})/i);
  if (biller) return biller[1].trim().replace(/\s*\([^)]*\)\s*$/, '').trim();

  const pay = t.match(/(?:ชำระ|ชำระให้|จ่ายให้)\s*[:：-]?\s*([^|,]{2,80})/i);
  if (pay) return pay[1].trim().replace(/\s*\([^)]*\)\s*$/, '').trim();

  return '';
}

function parseTransactionDate(subject='', body='', fallback='') {
  const text=normalizeText(subject+' '+body);
  const months={'ม.ค.':0,'ก.พ.':1,'มี.ค.':2,'เม.ย.':3,'พ.ค.':4,'มิ.ย.':5,'ก.ค.':6,'ส.ค.':7,'ก.ย.':8,'ต.ค.':9,'พ.ย.':10,'ธ.ค.':11};
  const thai=text.match(/(\d{1,2})\s+(\S+)\s+(\d{2,4})\s*[-\u0e13]\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (thai && months[thai[2]] != null) { let year=Number(thai[3]);if(year<100)year+=2500;if(year>=2400)year-=543;const d=new Date(year,months[thai[2]],Number(thai[1]),Number(thai[4]),Number(thai[5]),Number(thai[6]||0));if(!Number.isNaN(d.getTime()))return d.toISOString();}
  const english=text.match(/(?:transaction date|transaction datetime|date\s+and\s+time)\s*[::]?\s*([^|\n]{6,60})/i);
  if(english){const d=new Date(english[1].trim());if(!Number.isNaN(d.getTime()))return d.toISOString();}
  return fallback;
}

function transactionScore(from, subject, body, amount, type, parsedDate, merchantName) {
  const t = normalizeText(`${from} ${subject} ${body}`).toLowerCase();
  let score = 0;
  if (amount != null) score += 3;
  if (type) score += 3;
  const bank = detectBank(from, subject, body);
  if (bank) score += 1;
  const transactionSignal = /payment|purchase|transfer|transaction|receipt|invoice|debit|credit|deposit|withdrawal|ชำระ|โอน|เงินเข้า|เงินออก|รายการ/.test(t);
  if (transactionSignal) score += 2;
  if (parsedDate && !/^[A-Za-z]{3},/.test(String(parsedDate))) score += 1;
  if (merchantName) score += 1;
  // Bank transaction emails often contain security/footer text such as "password"
  // or "login". Do not downgrade a message that already has strong transaction evidence.
  if (!transactionSignal && /otp|verification code|login|password|newsletter|unsubscribe|promotion|โปรโมชั่น|รหัส otp/.test(t)) score -= 6;
  if (/monthly statement|account statement|trade statement|order history|ใบแจ้งยอด|สรุปรายการลงทุน/.test(t)) score -= 10;
  return score;
}

function toCandidate(message) {
  const h = message.payload?.headers || [];
  const subject = header(h, 'Subject');
  const from = header(h, 'From');
  const headerDate = header(h, 'Date');
  const body = bodyFromPayload(message.payload);
  const date = parseTransactionDate(subject, body, headerDate);
  const bank = detectBank(from, subject, body);
  const amount = parseAmount(subject, body);
  const type = detectType(subject, body);
  const parsedMerchant = merchant(subject, body);
  const score = transactionScore(from, subject, body, amount, type, date, parsedMerchant);
  const statement = /monthly statement|account statement|trade statement|order history|ใบแจ้งยอด|สรุปรายการลงทุน/i.test(`${subject} ${body}`);

  return {
    id: message.id,
    threadId: message.threadId,
    subject,
    from,
    date,
    bank,
    amount,
    type,
    merchant: parsedMerchant,
    category: classify(subject, body, parsedMerchant),
    detail: normalizeText(body).slice(0, 1000),
    score,
    confidence: amount != null && type && !statement && score >= 8 ? 'high' : amount != null && type && !statement && score >= 6 ? 'medium' : 'low'
  };
}

function importFingerprint(candidate) {
  const merchantName = normalizeText(candidate.merchant || '').toLowerCase();
  // Require a precise transaction timestamp plus merchant/recipient. This avoids
  // merging two legitimate same-day purchases for the same amount and merchant.
  if (!merchantName || !candidate.date) return null;
  const parsed = new Date(candidate.date);
  if (Number.isNaN(parsed.getTime())) return null;
  const timestamp = parsed.toISOString().slice(0, 16);
  const raw = [candidate.type || '', timestamp, Number(candidate.amount || 0).toFixed(2), merchantName].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function normalizeGmailQuery(q = '') {
  const query = String(q).trim();
  if (!query) return query;
  // Accept the common UI form rom:(a) / from:(b) as Gmail OR syntax.
  return query.replace(/\s*\/\s*/g, ' OR ');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getMessageWithBackoff(gmail, id, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    } catch (error) {
      const reason = error?.errors?.[0]?.reason;
      const quota = error?.code === 429 || error?.status === 429 || reason === 'rateLimitExceeded';
      if (!quota || attempt >= maxRetries) throw error;
      await sleep(1000 * (2 ** attempt));
    }
  }
}

async function listMessages(gmail, q, maxResults = 100) {
  const ids = new Map();
  let pageToken;
  const hardCap = Math.max(100, Number(maxResults) || 100) * 10;
  do {
    const response = await gmail.users.messages.list({
      userId: 'me',
      q,
      maxResults: Math.min(100, Math.max(1, Number(maxResults) || 100)),
      pageToken
    });
    for (const m of response.data.messages || []) {
      ids.set(m.id, m);
      if (ids.size >= hardCap) break;
    }
    pageToken = response.data.nextPageToken;
  } while (pageToken && ids.size < hardCap);
  return ids;
}

const gmailPush = createGmailPush({
  db,
  google,
  oauthClient,
  topic: String(process.env.GMAIL_PUBSUB_TOPIC || '').trim(),
  loadToken,
  getMessageWithBackoff,
  listMessages,
  toCandidate
});

router.get('/status', (req, res) => {
  const row = db.prepare("SELECT value FROM settings WHERE key='gmail_email'").get();
  const expiration = Number(db.prepare("SELECT value FROM settings WHERE key='gmail_watch_expiration'").get()?.value || 0);
  const pushConfigured = !!String(process.env.GMAIL_PUBSUB_TOPIC || '').trim();
  res.json({
    connected: !!loadToken(),
    email: row?.value || null,
    push: { configured: pushConfigured, active: expiration > Date.now(), expiration: expiration || null }
  });
});

router.post('/pubsub', async (req, res) => {
  try {
    await verifyPubSubRequest(req);
    const encoded = req.body?.message?.data;
    if (!encoded) return res.status(204).end();
    const notification = JSON.parse(Buffer.from(String(encoded), 'base64').toString('utf8'));
    if (!notification.historyId) return res.status(204).end();
    const result = await gmailPush.processGmailHistory(String(notification.historyId));
    console.log('Gmail push processed:', result);
    return res.status(204).end();
  } catch (error) {
    const authError = /missing_pubsub_auth|pubsub_auth_not_configured|unexpected_pubsub_service_account/i.test(String(error.message || ''));
    if (authError) return res.status(401).json({ error: 'Pub/Sub authentication failed' });
    console.error('Gmail push webhook failed:', error);
    return res.status(500).json({ error: 'Gmail push processing failed' });
  }
});

router.get('/connect', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(500).json({ error: 'ยังไม่ได้ตั้งค่า GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET' });
  }
  res.redirect(oauthClient().generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES }));
});

router.get('/oauth2callback', async (req, res) => {
  try {
    if (!req.query.code) {
      return res.redirect('/?gmail=error&reason=' + encodeURIComponent(req.query.error || 'missing_code'));
    }
    const client = oauthClient();
    const { tokens } = await client.getToken(req.query.code);
    const existing = loadToken();
    const merged = { ...(existing || {}), ...(tokens || {}) };
    client.setCredentials(merged);
    saveToken(merged);

    let email = '';
    try {
      const gmail = google.gmail({ version: 'v1', auth: client });
      const profile = await gmail.users.getProfile({ userId: 'me' });
      email = profile.data.emailAddress || '';
    } catch (profileError) {
      console.error('Gmail profile check failed:', profileError.message);
    }
    db.prepare("INSERT INTO settings(key,value) VALUES('gmail_email',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(email);
    res.redirect('/?gmail=connected');
  } catch (error) {
    console.error('Gmail OAuth callback failed:', error.response?.data || error.message || error);
    res.redirect('/?gmail=error');
  }
});

router.post('/disconnect', (req, res) => {
  db.prepare("DELETE FROM settings WHERE key IN ('gmail_oauth','gmail_email')").run();
  res.json({ success: true });
});

const scanCache = new Map();
const scanInFlight = new Map();
const scanCooldown = new Map();
const scanProgress = new Map();
const SCAN_CACHE_MS = 5 * 60 * 1000;
const RATE_LIMIT_COOLDOWN_MS = 2 * 60 * 1000;
const SCAN_PROGRESS_TTL_MS = 10 * 60 * 1000;

function setScanProgress(scanId, patch) {
  if (!scanId) return;
  const prev = scanProgress.get(scanId) || {};
  scanProgress.set(scanId, { ...prev, ...patch, updatedAt: Date.now() });
}

function clearScanProgressLater(scanId) {
  if (!scanId) return;
  setTimeout(() => scanProgress.delete(scanId), SCAN_PROGRESS_TTL_MS).unref?.();
}

router.get('/scan-progress', (req, res) => {
  const scanId = String(req.query.scanId || '').trim();
  const progress = scanProgress.get(scanId);
  if (!progress) return res.status(404).json({ error: 'ไม่พบสถานะการสแกน' });
  res.json(progress);
});
router.get('/messages', async (req, res) => {
  let scanResolve = null;
  let scanCacheKey = null;
  const scanId = String(req.headers['x-scan-id'] || crypto.randomUUID());
  try {
    const cacheKey = JSON.stringify({ q: req.query.q || '', from: req.query.from || '', to: req.query.to || '', limit: req.query.limit || '' });
    setScanProgress(scanId, {
      status: 'running', stage: 'เตรียมการ', message: 'กำลังเตรียมค้นหา Gmail...', percent: 2,
      current: 0, total: 0, scanId
    });
    scanCacheKey = cacheKey;
    const now = Date.now();
    const cooldownUntil = scanCooldown.get(cacheKey) || 0;
    if (cooldownUntil > now) {
      const retryAfter = Math.ceil((cooldownUntil - now) / 1000);
      setScanProgress(scanId, {
        status: 'rate_limited', stage: 'พักการยิงคำขอ',
        message: `Gmail ถูกจำกัดชั่วคราว ระบบหยุดส่งคำขอซ้ำ`,
        percent: 100, retryAfter, current: 0, total: 0, scanId
      });
      clearScanProgressLater(scanId);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: `Gmail ถูกจำกัดชั่วคราว กรุณาลองใหม่ใน ${retryAfter} วินาที` });
    }
    const cached = scanCache.get(cacheKey);
    if (cached && now - cached.at < SCAN_CACHE_MS) {
      setScanProgress(scanId, { status: 'done', stage: 'เสร็จสิ้น', message: 'ใช้ผลสแกนที่แคชไว้ ไม่ต้องยิง Gmail ซ้ำ', percent: 100, current: cached.data.messages?.length || 0, total: cached.data.scanned || 0, scanId });
      clearScanProgressLater(scanId);
      return res.json(cached.data);
    }
    const pending = scanInFlight.get(cacheKey);
    if (pending) {
      const shared = await pending;
      if (shared?.data) return res.json(shared.data);
      if (shared?.status) return res.status(shared.status).json(shared.body);
    }
    const token = loadToken();
    if (!token) {
      setScanProgress(scanId, {
        status: 'error', stage: 'หยุดการสแกน',
        message: 'กรุณาเชื่อมต่อ Gmail ก่อน', percent: 0, current: 0, total: 0, scanId
      });
      clearScanProgressLater(scanId);
      return res.status(401).json({ error: 'กรุณาเชื่อมต่อ Gmail ก่อน' });
    }

    let resolveShared;
    const sharedPromise = new Promise(resolve => { resolveShared = resolve; });
    scanResolve = resolveShared;
    scanInFlight.set(cacheKey, sharedPromise);

    const client = oauthClient();
    client.setCredentials(token);
    const gmail = google.gmail({ version: 'v1', auth: client });
    const requested = normalizeGmailQuery(req.query.q || '');
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    // Gmail date search uses its own timezone semantics. When a month is selected,
    // start one calendar day earlier so transactions around midnight in Thailand are not missed.
    const dateFilter = from && to
      ? ` after:${(() => { const d = new Date(from + 'T00:00:00'); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); })()} before:${to}`
      : from
        ? ` after:${(() => { const d = new Date(from + 'T00:00:00'); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); })()}`
        : to
          ? ` before:${to}`
          : '';

    // Apply the selected month/date range directly to every Gmail query.
    // This is important because Gmail search itself must be restricted; filtering only
    // in the browser would still scan unrelated months and could make the selector appear broken.
    // Narrow the historical search to likely transaction emails before fetching full bodies.
    // The bank condition and transaction condition must both match, reducing API calls and noise.
    const transactionTerms = '{payment transfer transaction receipt invoice debit credit deposit withdrawal refund cashback ชำระ โอน เงินเข้า เงินออก รายการ รับเงิน ฝาก เงินเดือน}';
    const bankQueries = [
      `{ttb tmbthanachart ttbank} ${transactionTerms}`,
      `{K PLUS KBank Kasikorn kasikornbank} ${transactionTerms}`,
      `from:(scb.co.th) ${transactionTerms}`,
      `{SCB "SCB EASY"} ${transactionTerms}`
    ];
    // A selected month must be allowed to reach older Gmail history. Keep the
    // 180-day limit only for an unbounded/manual scan to reduce quota usage.
    const recentFilter = dateFilter ? '' : ' newer_than:180d';
    const queries = requested
      ? [`${requested}${dateFilter}`]
      : bankQueries.map(q => `${q}${recentFilter}${dateFilter}`);

    const ids = new Map();
    setScanProgress(scanId, { stage: 'ค้นหา', message: 'กำลังค้นหา Gmail จากแต่ละแหล่ง...', percent: 5, current: 0, total: queries.length, scanId });
    for (let qi = 0; qi < queries.length; qi++) {
      const q = queries[qi];
      setScanProgress(scanId, {
        stage: 'ค้นหา',
        message: `กำลังค้นหาแหล่งที่ ${qi + 1}/${queries.length}`,
        percent: Math.min(10 + Math.round((qi / queries.length) * 25), 35),
        current: qi + 1, total: queries.length, scanId
      });
      const found = await listMessages(gmail, q, 100);
      for (const [id, message] of found) ids.set(id, message);
    }

    const candidates = [];
    const reviewCandidates = [];
    setScanProgress(scanId, {
      stage: 'วิเคราะห์',
      message: `พบอีเมล ${ids.size.toLocaleString()} รายการ กำลังวิเคราะห์ธุรกรรม...`,
      percent: 40, current: 0, total: ids.size, scanId
    });
    const importedIds = new Set(
      db.prepare(`
        SELECT ie.gmail_id
        FROM imported_emails ie
        WHERE ie.kind = 'income'
           OR (ie.kind = 'expense' AND EXISTS (SELECT 1 FROM expenses e WHERE e.id = ie.expense_id))
      `).all().map(r => r.gmail_id)
    );
    let processed = 0;
    let quotaError = null;
    let workerError = null;
    const messages = Array.from(ids.values());
    let nextIndex = 0;
    const worker = async () => {
      while (true) {
        if (quotaError || workerError) return;
        const index = nextIndex++;
        if (index >= messages.length) return;
        const message = messages[index];

        if (importedIds.has(message.id)) {
          processed++;
          setScanProgress(scanId, {
            stage: 'วิเคราะห์',
            message: `ข้ามรายการที่นำเข้าแล้ว ${processed}/${ids.size}`,
            percent: ids.size ? 40 + Math.round((processed / ids.size) * 55) : 95,
            current: processed, total: ids.size, scanId
          });
          continue;
        }

        let full;
        try {
          full = await getMessageWithBackoff(gmail, message.id);
        } catch (error) {
          const reason = error?.errors?.[0]?.reason;
          const quota = error?.code === 429 || error?.status === 429 || reason === 'rateLimitExceeded';
          if (quota) {
            quotaError = error;
            return;
          }
          workerError = error;
          return;
        }

        processed++;
        const candidate = toCandidate(full.data);
        setScanProgress(scanId, {
          stage: 'วิเคราะห์',
          message: `กำลังวิเคราะห์อีเมล ${processed}/${ids.size}`,
          percent: ids.size ? 40 + Math.round((processed / ids.size) * 55) : 95,
          current: processed, total: ids.size, scanId
        });
        // After widening the Gmail search by one day, use the transaction date parsed
        // from the email as the final month boundary so adjacent-month emails stay out.
        if (from && to && candidate.date) {
          const targetMonth = from.slice(0, 7);
          const transactionMonth = String(candidate.date).slice(0, 7);
          if (transactionMonth !== targetMonth) continue;
        }
        const statement = /monthly statement|account statement|trade statement|order history|ใบแจ้งยอด|สรุปรายการลงทุน/i.test(`${candidate.subject} ${candidate.detail}`);
        const transactionEvidence = /successfully|processed successfully|transaction date|amount\s*:/i.test(candidate.detail || '') || /payment|transfer|transaction|เงินเข้า|เงินออก|โอน|ชำระ|จ่าย|ถอน|ฝาก|ซื้อ|รายการ/i.test(`${candidate.subject || ''} ${candidate.detail || ''}`);
        if (candidate.amount != null && candidate.type && candidate.bank && !statement && transactionEvidence) {
          if (candidate.score >= 8) candidate.confidence = 'high';
          else if (candidate.score >= 6) candidate.confidence = 'medium';
          else candidate.confidence = 'low';
          if (candidate.confidence === 'high') candidates.push(candidate);
          else reviewCandidates.push(candidate);
        }
      }
    };

    // Keep concurrency low for one Gmail user. Large historical scans use one worker
    // to avoid bursty traffic; small scans can use two workers safely.
    const concurrency = Math.min(messages.length > 80 ? 1 : 2, messages.length || 1);
    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    if (workerError) throw workerError;
    if (quotaError) {
      const retryAfter = Math.ceil(RATE_LIMIT_COOLDOWN_MS / 1000);
      const body = { error: 'Gmail ใช้งานครบโควตาชั่วคราว ระบบหยุดยิงคำขอซ้ำให้แล้ว กรุณาลองใหม่ภายหลัง' };
      setScanProgress(scanId, {
        status: 'rate_limited', stage: 'พักการยิงคำขอ',
        message: 'Gmail ใช้งานครบโควตาชั่วคราว ระบบหยุดคำขอซ้ำให้แล้ว',
        percent: 100, retryAfter, current: processed, total: ids.size, scanId
      });
      clearScanProgressLater(scanId);
      scanCooldown.set(cacheKey, Date.now() + RATE_LIMIT_COOLDOWN_MS);
      scanInFlight.delete(cacheKey);
      if (scanResolve) scanResolve({ status: 429, body });
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json(body);
    }

    // Do not cap the combined result at 25: one busy bank (for example TTB)
    // can otherwise crowd out another bank such as SCB completely.
    candidates.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    reviewCandidates.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    const result = { messages: candidates.slice(0, 100), review: reviewCandidates.slice(0, 100), scanned: ids.size };
    setScanProgress(scanId, {
      status: 'done', stage: 'เสร็จสิ้น',
      message: `วิเคราะห์เสร็จแล้ว พบรายการพร้อมนำเข้า ${result.messages.length} รายการ`,
      percent: 100, current: ids.size, total: ids.size, scanId
    });
    clearScanProgressLater(scanId);
    scanCache.set(cacheKey, { at: Date.now(), data: result });
    scanInFlight.delete(cacheKey);
    if (scanResolve) scanResolve({ data: result });
    res.json(result);
  } catch (error) {
    console.error(error);
    const message = error?.message || 'ไม่สามารถอ่านอีเมลจาก Gmail ได้';
    const authExpired = error?.message === 'invalid_grant' || /invalid_grant/i.test(String(error?.response?.data?.error || ''));
    if (scanCacheKey) scanInFlight.delete(scanCacheKey);
    if (scanResolve) {
      scanResolve(authExpired
        ? { status: 401, body: { error: 'การเชื่อมต่อ Gmail หมดอายุ กรุณาเชื่อมต่อ Gmail ใหม่' } }
        : { status: 500, body: { error: 'ไม่สามารถอ่านอีเมลจาก Gmail ได้', detail: message } });
    }
    if (authExpired) {
      setScanProgress(scanId, {
        status: 'error', stage: 'ต้องเชื่อมต่อใหม่',
        message: 'การเชื่อมต่อ Gmail หมดอายุ กรุณาเชื่อมต่อ Gmail ใหม่',
        percent: 100, current: 0, total: 0, scanId
      });
      clearScanProgressLater(scanId);
      return res.status(401).json({ error: 'การเชื่อมต่อ Gmail หมดอายุ กรุณาเชื่อมต่อ Gmail ใหม่' });
    }
    setScanProgress(scanId, {
      status: 'error', stage: 'เกิดข้อผิดพลาด',
      message: 'ไม่สามารถอ่านอีเมลจาก Gmail ได้',
      percent: 100, current: 0, total: 0, scanId
    });
    clearScanProgressLater(scanId);
    res.status(500).json({ error: 'ไม่สามารถอ่านอีเมลจาก Gmail ได้', detail: message });
  }
});

router.post('/import', async (req, res) => {
  const { candidate } = req.body || {};
  const amount = Number(candidate?.amount);
  if (!candidate?.id || !Number.isFinite(amount) || amount <= 0 || amount >= 100000000 || !['expense', 'income'].includes(candidate.type)) {
    return res.status(400).json({ error: 'ข้อมูลรายการไม่ครบหรือไม่ปลอดภัยที่จะนำเข้า' });
  }
  candidate.amount = amount;

  try {
    const exists = db.prepare('SELECT id,kind,expense_id FROM imported_emails WHERE gmail_id=?').get(candidate.id);
    if (exists) {
      const validExpense = exists.kind === 'expense' && exists.expense_id && db.prepare('SELECT id FROM expenses WHERE id=?').get(exists.expense_id);
      const validIncome = exists.kind === 'income';
      if (validExpense || validIncome) return res.json({ success: true, duplicate: true, message: 'รายการจาก Gmail นี้ถูกนำเข้าแล้ว' });
      db.prepare('DELETE FROM imported_emails WHERE id=?').run(exists.id);
    }

    const fingerprint = importFingerprint(candidate);
    const fingerprintMatch = db.prepare('SELECT id FROM imported_emails WHERE fingerprint=? LIMIT 1').get(fingerprint);
    if (fingerprintMatch) return res.json({ success: true, duplicate: true, message: 'ตรวจพบธุรกรรมซ้ำจากข้อมูลรายการ' });

    if (candidate.type === 'income') {
      const transactionDate = dateText(candidate.date || Date.now()) || dateText(Date.now());
      const month = transactionDate.slice(0, 7);
      db.prepare(`INSERT INTO income_entries
        (amount,type,title,income_date,month,note,locked,source) VALUES (?,?,?,?,?,?,?,?)`)
        .run(candidate.amount, 'other', candidate.merchant || 'รายรับจาก Gmail', transactionDate, month, candidate.detail || null, 0, 'gmail');
      db.prepare('INSERT INTO imported_emails(gmail_id,kind,source,fingerprint) VALUES(?,?,?,?)').run(candidate.id, 'income', 'gmail', fingerprint);
      return res.json({ success: true, type: 'income' });
    }

    const category = db.prepare('SELECT id FROM categories WHERE name=?').get(candidate.category)
      || db.prepare("SELECT id FROM categories WHERE name='อื่นๆ'").get();
    const parsedDate = dateText(candidate.date || Date.now()) || dateText(Date.now());
    const parsedTime = candidate.date && !Number.isNaN(new Date(candidate.date).getTime())
      ? new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(candidate.date))
      : null;

    // Cross-source dedupe: a manually recorded expense can represent the same
    // transaction that Gmail discovers later. Keep the user's existing manual
    // row and link the Gmail message to it instead of creating another expense.
    const crossSourceDuplicate = findCrossSourceDuplicate(candidate.amount, parsedDate, parsedTime, 'gmail');
    if (crossSourceDuplicate) {
      db.prepare('INSERT INTO imported_emails(gmail_id,kind,expense_id,source,fingerprint) VALUES(?,?,?,?,?)')
        .run(candidate.id, 'expense', crossSourceDuplicate.id, 'gmail', fingerprint);
      return res.json({
        success: true,
        type: 'expense',
        id: Number(crossSourceDuplicate.id),
        duplicate: true,
        crossSourceLinked: true
      });
    }

    // Repair/attach legacy Gmail expenses that were saved before imported_emails
    // existed. Match on the complete transaction identity so a re-scan cannot
    // create a second expense for the same legacy bank notification.
    const legacyExpense = db.prepare(
      'SELECT e.id FROM expenses e LEFT JOIN imported_emails ie ON ie.expense_id = e.id WHERE e.source = \'gmail\' AND e.amount = ? AND e.expense_date = ? AND COALESCE(e.expense_time, \'\') = COALESCE(?, \'\') AND COALESCE(e.merchant, \'\') = COALESCE(?, \'\') AND ie.id IS NULL ORDER BY e.id ASC LIMIT 1'
    ).get(candidate.amount, parsedDate, parsedTime || null, candidate.merchant || null);

    if (legacyExpense) {
      db.prepare('INSERT INTO imported_emails(gmail_id,kind,expense_id,source,fingerprint) VALUES(?,?,?,?,?)')
        .run(candidate.id, 'expense', legacyExpense.id, 'gmail', fingerprint);
      return res.json({ success: true, type: 'expense', id: Number(legacyExpense.id), duplicate: true, legacyLinked: true });
    }

    const info = db.prepare(
      'INSERT INTO expenses(amount,category_id,merchant,note,expense_date,expense_time,source) VALUES(?,?,?,?,?,?,?)'
    ).run(candidate.amount, category.id, candidate.merchant || null, candidate.detail || null, parsedDate, parsedTime, 'gmail');
    db.prepare('INSERT INTO imported_emails(gmail_id,kind,expense_id,source,fingerprint) VALUES(?,?,?,?,?)')
      .run(candidate.id, 'expense', info.lastInsertRowid, 'gmail', fingerprint);
    res.json({ success: true, type: 'expense', id: Number(info.lastInsertRowid) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'บันทึกรายการไม่สำเร็จ', detail: error.message });
  }
});

router.startGmailPushWatch = gmailPush.startGmailPushWatch;
module.exports = router;
