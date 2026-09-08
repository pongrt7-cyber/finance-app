const express = require('express');
// Gmail transaction parser: bank-specific, strict amount detection.
const crypto = require('crypto');
const { google } = require('googleapis');
const db = require('../db');
const { dateText } = require('../utils/date');

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

function transactionScore(from, subject, body, amount, type) {
  const t = normalizeText(`${from} ${subject} ${body}`).toLowerCase();
  let score = 0;
  if (amount != null) score += 4;
  if (type) score += 4;
  if (detectBank(from, subject, body)) score += 2;
  if (/payment|purchase|transfer|transaction|receipt|invoice|debit|credit|deposit|withdrawal|ชำระ|โอน|เงินเข้า|เงินออก|รายการ/.test(t)) score += 2;
  if (/otp|verification code|login|password|newsletter|unsubscribe|promotion|โปรโมชั่น|รหัส otp/.test(t)) score -= 8;
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
  const score = transactionScore(from, subject, body, amount, type);
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
    confidence: amount != null && type && !statement && score >= 10 ? 'high' : amount != null && type && !statement && score >= 8 ? 'medium' : 'low'
  };
}

function importFingerprint(candidate) {
  const raw = [candidate.type || '', candidate.date || '', Number(candidate.amount || 0).toFixed(2),
    normalizeText(candidate.merchant || '').toLowerCase(), normalizeText(candidate.subject || '').toLowerCase(),
    normalizeText(candidate.detail || '').slice(0, 180).toLowerCase()].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function normalizeGmailQuery(q = '') {
  const query = String(q).trim();
  if (!query) return query;
  // Accept the common UI form rom:(a) / from:(b) as Gmail OR syntax.
  return query.replace(/\s*\/\s*/g, ' OR ');
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

router.get('/status', (req, res) => {
  const row = db.prepare("SELECT value FROM settings WHERE key='gmail_email'").get();
  res.json({ connected: !!loadToken(), email: row?.value || null });
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
const SCAN_CACHE_MS = 5 * 60 * 1000;
const RATE_LIMIT_COOLDOWN_MS = 2 * 60 * 1000;
router.get('/messages', async (req, res) => {
  let scanResolve = null;
  let scanCacheKey = null;
  try {
    const cacheKey = JSON.stringify({ q: req.query.q || '', from: req.query.from || '', to: req.query.to || '', limit: req.query.limit || '' });
    scanCacheKey = cacheKey;
    const now = Date.now();
    const cooldownUntil = scanCooldown.get(cacheKey) || 0;
    if (cooldownUntil > now) {
      const retryAfter = Math.ceil((cooldownUntil - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: `Gmail ถูกจำกัดชั่วคราว กรุณาลองใหม่ใน ${retryAfter} วินาที` });
    }
    const cached = scanCache.get(cacheKey);
    if (cached && now - cached.at < SCAN_CACHE_MS) return res.json(cached.data);
    const pending = scanInFlight.get(cacheKey);
    if (pending) {
      const shared = await pending;
      if (shared?.data) return res.json(shared.data);
      if (shared?.status) return res.status(shared.status).json(shared.body);
    }
    const token = loadToken();
    if (!token) return res.status(401).json({ error: 'กรุณาเชื่อมต่อ Gmail ก่อน' });

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
    const queries = requested ? [`${requested}${dateFilter}`] : [
      'newer_than:180d {ttb tmbthanachart ttbank}',
      'newer_than:180d {K PLUS KBank Kasikorn kasikornbank}',
      'newer_than:180d from:(scb.co.th)',
      'newer_than:180d {"เงินเข้า" "เงินออก" "โอนเงิน" "ชำระเงิน" "รายการ"}'
    ].map(q => `${q}${dateFilter}`);

    const ids = new Map();
    for (const q of queries) {
      const found = await listMessages(gmail, q, 100);
      for (const [id, message] of found) ids.set(id, message);
    }

    const candidates = [];
    const importedIds = new Set(
      db.prepare(`
        SELECT ie.gmail_id
        FROM imported_emails ie
        WHERE ie.kind = 'income'
           OR (ie.kind = 'expense' AND EXISTS (SELECT 1 FROM expenses e WHERE e.id = ie.expense_id))
      `).all().map(r => r.gmail_id)
    );
    for (const message of ids.values()) {
      if (importedIds.has(message.id)) continue;
      let full;
      try {
        full = await gmail.users.messages.get({ userId: 'me', id: message.id, format: 'full' });
      } catch (error) {
        const reason = error?.errors?.[0]?.reason;
        const quota = error?.code === 429 || error?.status === 429 || reason === 'rateLimitExceeded';
        if (quota) {
          const retryAfter = Math.ceil(RATE_LIMIT_COOLDOWN_MS / 1000);
          const body = { error: 'Gmail ใช้งานครบโควตาชั่วคราว ระบบหยุดยิงคำขอซ้ำให้แล้ว กรุณาลองใหม่ภายหลัง' };
          scanCooldown.set(cacheKey, Date.now() + RATE_LIMIT_COOLDOWN_MS);
          scanInFlight.delete(cacheKey);
          if (scanResolve) scanResolve({ status: 429, body });
          res.set('Retry-After', String(retryAfter));
          return res.status(429).json(body);
        }
        throw error;
      }
      const candidate = toCandidate(full.data);
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
        candidate.confidence = 'high';
        candidates.push(candidate);
      }
    }

    candidates.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    // Do not cap the combined result at 25: one busy bank (for example TTB)
    // can otherwise crowd out another bank such as SCB completely.
    const result = { messages: candidates.slice(0, 100), scanned: ids.size };
    scanCache.set(cacheKey, { at: Date.now(), data: result });
    scanInFlight.delete(cacheKey);
    if (scanResolve) scanResolve({ data: result });
    res.json(result);
  } catch (error) {
    console.error(error);
    const message = error?.message || 'ไม่สามารถอ่านอีเมลจาก Gmail ได้';
    if (scanCacheKey) scanInFlight.delete(scanCacheKey);
    if (scanResolve) scanResolve({ status: 500, body: { error: 'ไม่สามารถอ่านอีเมลจาก Gmail ได้', detail: message } });
    res.status(500).json({ error: 'ไม่สามารถอ่านอีเมลจาก Gmail ได้', detail: message });
  }
});

router.post('/import', async (req, res) => {
  const { candidate } = req.body || {};
  if (!candidate?.id || !candidate.amount || !['expense', 'income'].includes(candidate.type)) {
    return res.status(400).json({ error: 'ข้อมูลรายการไม่ครบหรือไม่ปลอดภัยที่จะนำเข้า' });
  }

  try {
    const exists = db.prepare('SELECT id,kind,expense_id FROM imported_emails WHERE gmail_id=?').get(candidate.id);
    if (exists) {
      const validExpense = exists.kind === 'expense' && exists.expense_id && db.prepare('SELECT id FROM expenses WHERE id=?').get(exists.expense_id);
      const validIncome = exists.kind === 'income';
      if (validExpense || validIncome) return res.json({ success: true, duplicate: true, message: '???????????????????????' });
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
    const info = db.prepare(
      'INSERT INTO expenses(amount,category_id,merchant,note,expense_date,source) VALUES(?,?,?,?,?,?)'
    ).run(candidate.amount, category.id, candidate.merchant || null, candidate.detail || null, parsedDate, 'gmail');
    db.prepare('INSERT INTO imported_emails(gmail_id,kind,expense_id,source,fingerprint) VALUES(?,?,?,?,?)')
      .run(candidate.id, 'expense', info.lastInsertRowid, 'gmail', fingerprint);
    res.json({ success: true, type: 'expense', id: Number(info.lastInsertRowid) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'บันทึกรายการไม่สำเร็จ', detail: error.message });
  }
});

module.exports = router;
