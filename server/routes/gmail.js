const express = require('express');
// Gmail transaction parser: bank-specific, strict amount detection.
const crypto = require('crypto');
const { google } = require('googleapis');
const db = require('../db');

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

  // Never interpret statement/report/order numbers as a transaction amount.
  if (/(monthly statement|account statement|statement|trade statement|order history|รายการคำสั่งซื้อ|สรุปรายการลงทุน)/i.test(lower)) {
    return null;
  }

  const amountNumber = '([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)';
  const labeled = [
    new RegExp(`(?:จำนวนเงิน|ยอดรายการ|ยอดธุรกรรม|ยอดชำระ|ยอดโอน|ยอดใช้จ่าย|ยอดเงินที่ทำรายการ|transaction amount|transaction value|payment amount|purchase amount|amount paid|amount|total paid|paid)\\s*[:=]?\\s*(?:THB|฿|บาท)?\\s*${amountNumber}(?:\\s*(?:THB|฿|บาท))?`, 'i'),
    new RegExp(`(?:จำนวนเงิน|ยอดรายการ|ยอดธุรกรรม|ยอดชำระ|ยอดโอน|ยอดใช้จ่าย|ยอดเงินที่ทำรายการ|transaction amount|transaction value|payment amount|purchase amount|amount paid|amount|total paid|paid)\\s*[:=]?\\s*(?:THB|฿|บาท)?\\s*${amountNumber}`, 'i')
  ];

  for (const re of labeled) {
    const m = text.match(re);
    if (m) {
      const value = numberFrom(m[1]);
      if (value != null) return value;
    }
  }

  // Explicit Thai transaction sentences. This is intentionally narrower than
  // matching every number near words such as "เงิน" or "โอน".
  const explicit = [
    new RegExp(`(?:โอนเงิน|โอน|ชำระเงิน|ชำระ|จ่าย|ซื้อ|ถอนเงิน|ฝากเงิน|รับเงิน|เงินเข้า|เงินออก)[^0-9]{0,30}(?:THB|฿|บาท)?\\s*${amountNumber}(?:\\s*(?:THB|฿|บาท))?`, 'i'),
    new RegExp(`(?:THB|฿|บาท)\\s*${amountNumber}[^0-9]{0,20}(?:โอนเงิน|โอน|ชำระเงิน|ชำระ|จ่าย|ซื้อ|ถอนเงิน|ฝากเงิน|รับเงิน|เงินเข้า|เงินออก)`, 'i')
  ];
  for (const re of explicit) {
    const m = text.match(re);
    if (m) {
      const value = numberFrom(m[1]);
      if (value != null) return value;
    }
  }

  // English bank alerts often put the amount immediately after a transaction verb.
  const english = new RegExp(`(?:transfer|payment|purchase|withdrawal|deposit|received|sent|spent)[^0-9]{0,25}(?:THB|฿)?\\s*${amountNumber}(?:\\s*(?:THB|฿))?`, 'i');
  const em = text.match(english);
  if (em) return numberFrom(em[1]);

  return null;
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
    /เงินออก/, /โอนออก/, /โอนเงินออก/, /ชำระเงิน/, /ชำระ/, /จ่าย/, /ซื้อสินค้า/, /ถอนเงิน/, /หักบัญชี/, /หักเงิน/, /payment/, /purchase/, /debit(?:ed)?/, /withdrawal/, /sent/, /outgoing transfer/, /bill payment/
  ];

  const income = incomePatterns.some(re => re.test(t));
  const expense = expensePatterns.some(re => re.test(t));
  if (income && !expense) return 'income';
  if (expense && !income) return 'expense';
  return null;
}

function classify(subject, body) {
  const t = normalizeText(`${subject} ${body}`).toLowerCase();
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

  const patterns = [
    /(?:ร้านค้า|ผู้รับเงิน|ผู้รับ|ผู้โอน|ปลายทาง|merchant|payee|recipient)\s*[:：-]?\s*([^|,]{2,80})/i,
    /(?:to|from)\s*[:：-]?\s*([A-Za-z][A-Za-z0-9 .&'-]{2,60})/i
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) return m[1].trim();
  }
  return '';
}

function parseTransactionDate(subject = '', body = '', fallback = '') {
  const text = normalizeText(`${subject} ${body}`);
  const thaiMonths = {
    'ม.ค.': 0, 'ก.พ.': 1, 'มี.ค.': 2, 'เม.ย.': 3, 'พ.ค.': 4, 'มิ.ย.': 5,
    'ก.ค.': 6, 'ส.ค.': 7, 'ก.ย.': 8, 'ต.ค.': 9, 'พ.ย.': 10, 'ธ.ค.': 11
  };

  // ttb / SCB commonly provide an explicit transaction date in the body.
  const thai = text.match(/(?:วันที่ทำรายการ|วันและเวลาการทำรายการ)\\s*[:：]?\\s*(\\d{1,2})\\s+([ก-ฮ]+\\.)\\s+(\\d{2,4})(?:\\s*(?:-\\s*|ณ\\s+))(\\d{1,2}):(\\d{2})(?::(\\d{2}))?/i);
  if (thai) {
    const month = thaiMonths[thai[2]];
    if (month != null) {
      let year = Number(thai[3]);
      if (year < 100) year += 2500;
      if (year >= 2400) year -= 543;
      const date = new Date(year, month, Number(thai[1]), Number(thai[4]), Number(thai[5]), Number(thai[6] || 0));
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
  }

  // Fallback for English bank alerts with an explicit Transaction Date.
  const english = text.match(/(?:transaction date|transaction datetime|date\\s+and\\s+time)\\s*[:：]?\\s*([^|]{6,60}?)(?=\\s{2,}|reference|ref(?:erence)?\\s*(?:no|number)|$)/i);
  if (english) {
    const date = new Date(english[1].trim());
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }

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
    merchant: merchant(subject, body),
    category: classify(subject, body),
    detail: normalizeText(body).slice(0, 1000),
    score,
    confidence: amount != null && type && !statement && score >= 10 ? 'high' : amount != null && type && !statement && score >= 8 ? 'medium' : 'low'
  };
}

async function listMessages(gmail, q, maxResults = 50) {
  const ids = new Map();
  let pageToken;
  do {
    const response = await gmail.users.messages.list({ userId: 'me', q, maxResults, pageToken });
    for (const m of response.data.messages || []) ids.set(m.id, m);
    pageToken = response.data.nextPageToken;
  } while (pageToken && ids.size < 150);
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
    const client = oauthClient();
    const { tokens } = await client.getToken(req.query.code);
    client.setCredentials(tokens);
    saveToken(tokens);
    const gmail = google.gmail({ version: 'v1', auth: client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    db.prepare("INSERT INTO settings(key,value) VALUES('gmail_email',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(profile.data.emailAddress || '');
    res.redirect('/?gmail=connected');
  } catch (error) {
    console.error(error);
    res.status(500).send('Gmail connection failed');
  }
});

router.post('/disconnect', (req, res) => {
  db.prepare("DELETE FROM settings WHERE key IN ('gmail_oauth','gmail_email')").run();
  res.json({ success: true });
});

router.get('/messages', async (req, res) => {
  try {
    const token = loadToken();
    if (!token) return res.status(401).json({ error: 'กรุณาเชื่อมต่อ Gmail ก่อน' });

    const client = oauthClient();
    client.setCredentials(token);
    const gmail = google.gmail({ version: 'v1', auth: client });
    const requested = String(req.query.q || '').trim();

    // Search bank alerts first. Gmail supports the same query syntax as Gmail search.
    // The bank-specific searches reduce unrelated mail while still allowing a manual custom query.
    const queries = requested ? [requested] : [
      'newer_than:180d {from:(ttbbank.com) from:(kasikornbank.com) from:(kbank.co.th) from:(scb.co.th) "เงินเข้า" "เงินออก" "โอนเงิน" "ชำระเงิน"}',
      'newer_than:180d {"จำนวนเงิน" "ยอดรายการ" "ยอดชำระ" "ยอดโอน" "transaction amount" "payment amount"}',
      'newer_than:180d {from:(ttbbank.com) from:(kasikornbank.com) from:(scb.co.th) payment purchase transfer transaction receipt}'
    ];

    const ids = new Map();
    for (const q of queries) {
      const found = await listMessages(gmail, q, 50);
      for (const [id, message] of found) ids.set(id, message);
    }

    const candidates = [];
    for (const message of ids.values()) {
      const full = await gmail.users.messages.get({ userId: 'me', id: message.id, format: 'full' });
      const candidate = toCandidate(full.data);
      if (candidate.amount != null && candidate.type && candidate.confidence !== 'low') {
        candidates.push(candidate);
      }
    }

    candidates.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    res.json({ messages: candidates.slice(0, 100), scanned: ids.size });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'ไม่สามารถอ่านอีเมลจาก Gmail ได้', detail: error.message });
  }
});

router.post('/import', async (req, res) => {
  const { candidate } = req.body || {};
  if (!candidate?.id || !candidate.amount || !['expense', 'income'].includes(candidate.type)) {
    return res.status(400).json({ error: 'ข้อมูลรายการไม่ครบหรือไม่ปลอดภัยที่จะนำเข้า' });
  }

  try {
    const exists = db.prepare('SELECT id FROM imported_emails WHERE gmail_id=?').get(candidate.id);
    if (exists) return res.status(409).json({ error: 'อีเมลนี้ถูกนำเข้าไปแล้ว' });

    if (candidate.type === 'income') {
      const date = new Date(candidate.date || Date.now());
      const month = Number.isNaN(date.getTime()) ? new Date().toISOString().slice(0, 7) : date.toISOString().slice(0, 7);
      const row = db.prepare('SELECT * FROM income WHERE month=?').get(month);
      if (row) db.prepare('UPDATE income SET amount=amount+? WHERE month=?').run(candidate.amount, month);
      else db.prepare('INSERT INTO income(amount,month,locked) VALUES(?,?,1)').run(candidate.amount, month);
      db.prepare('INSERT INTO imported_emails(gmail_id,kind,source) VALUES(?,?,?)').run(candidate.id, 'income', 'gmail');
      return res.json({ success: true, type: 'income' });
    }

    const category = db.prepare('SELECT id FROM categories WHERE name=?').get(candidate.category)
      || db.prepare("SELECT id FROM categories WHERE name='อื่นๆ'").get();
    const date = new Date(candidate.date || Date.now());
    const dateText = Number.isNaN(date.getTime()) ? new Date().toISOString().slice(0, 10) : date.toISOString().slice(0, 10);
    const info = db.prepare(
      'INSERT INTO expenses(amount,category_id,merchant,note,expense_date,source) VALUES(?,?,?,?,?,?)'
    ).run(candidate.amount, category.id, candidate.merchant || null, candidate.detail || null, dateText, 'gmail');
    db.prepare('INSERT INTO imported_emails(gmail_id,kind,expense_id,source) VALUES(?,?,?,?)')
      .run(candidate.id, 'expense', info.lastInsertRowid, 'gmail');
    res.json({ success: true, type: 'expense', id: Number(info.lastInsertRowid) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'บันทึกรายการไม่สำเร็จ', detail: error.message });
  }
});

module.exports = router;
