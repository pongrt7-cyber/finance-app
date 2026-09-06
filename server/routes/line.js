const express = require('express');
const line = require('@line/bot-sdk');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const { runTesseractOcr } = require('../ocr/ocrEngine');
const { extractFields } = require('../ocr/extractFields');

const router = express.Router();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

let client = null;
function getClient() {
  if (!config.channelAccessToken || !config.channelSecret) {
    throw new Error('LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET missing in .env');
  }
  if (!client) client = new line.messagingApi.MessagingApiClient({ channelAccessToken: config.channelAccessToken });
  return client;
}

function fmt(n) {
  return '฿' + Number(n || 0).toLocaleString('th-TH', { maximumFractionDigits: 0 });
}

function getOrCreateCategoryId(name) {
  if (!name) {
    const other = db.prepare("SELECT id FROM categories WHERE name = 'อื่นๆ'").get();
    return other ? other.id : db.prepare('SELECT id FROM categories LIMIT 1').get().id;
  }
  const row = db.prepare('SELECT id FROM categories WHERE name = ?').get(name);
  if (row) return row.id;
  const info = db.prepare('INSERT INTO categories (name, is_default) VALUES (?, 0)').run(name);
  return Number(info.lastInsertRowid);
}

function insertExpense({ amount, category_id, merchant, source }) {
  const now = new Date();
  const info = db.prepare(`
    INSERT INTO expenses (amount, category_id, merchant, payment_method, expense_date, expense_time, source)
    VALUES (?, ?, ?, 'เงินสด', ?, ?, ?)
  `).run(
    amount, category_id, merchant || null,
    now.toISOString().slice(0, 10), now.toTimeString().slice(0, 5), source
  );
  return Number(info.lastInsertRowid);
}

// แยกจำนวนเงิน+ร้านค้าจากข้อความสั้นๆ เช่น "7-Eleven 58 บาท" หรือ "กาแฟ 65"
function parseQuickText(text) {
  const numberPattern = /(?<!\d)\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?(?!\d)/g;
  const matches = [...text.matchAll(numberPattern)];
  if (matches.length === 0) return null;

  // เลือกเลขที่อยู่ติดกับคำว่า บาท/฿/thb ก่อน (แม่นสุด กันเลขในชื่อร้านเช่น "7-Eleven")
  let chosen = null;
  for (const m of matches) {
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 6);
    if (/^\s*(บาท|฿|thb)/i.test(after)) { chosen = m; break; }
  }
  // ไม่เจอ -> ใช้เลขตัวสุดท้ายในข้อความ (รูปแบบทั่วไปมักลงท้ายด้วยจำนวนเงิน)
  if (!chosen) chosen = matches[matches.length - 1];

  const amount = parseFloat(chosen[0].replace(/,/g, ''));
  const merchant = (text.slice(0, chosen.index) + text.slice(chosen.index + chosen[0].length))
    .replace(/บาท|฿|thb/gi, '').trim() || null;
  return { amount, merchant };
}

async function handleImageMessage(event, replyToken) {
  const messageId = event.message.id;
  const stream = await getClient().getMessageContent(messageId);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);

  const tmpPath = path.join(os.tmpdir(), `line_slip_${Date.now()}.jpg`);
  fs.writeFileSync(tmpPath, buffer);

  try {
    const lines = await runTesseractOcr(tmpPath);
    const parsed = extractFields(lines);

    if (!parsed.amount) {
      return getClient().replyMessage({
        replyToken,
        messages: [{ type: 'text', text: 'อ่านสลิปไม่ออก ลองส่งรูปที่ชัดกว่านี้ หรือพิมพ์เช่น "7-Eleven 58 บาท" แทนได้' }]
      });
    }

    const categoryId = getOrCreateCategoryId(parsed.category);
    const category = db.prepare('SELECT name FROM categories WHERE id = ?').get(categoryId);
    const expenseId = insertExpense({
      amount: parsed.amount, category_id: categoryId, merchant: parsed.merchant, source: 'line_image'
    });

    return getClient().replyMessage({
      replyToken,
      messages: [{
        type: 'text',
        text: `บันทึกแล้ว ✅\n${parsed.merchant || 'ไม่ทราบร้านค้า'}\n${fmt(parsed.amount)} · ${category.name}\n\n(รายการ #${expenseId} แก้ไขได้ที่หน้าเว็บถ้าไม่ตรง)`
      }]
    });
  } finally {
    fs.unlink(tmpPath, () => {});
  }
}

async function handleTextMessage(event, replyToken) {
  const text = event.message.text.trim();
  const parsed = parseQuickText(text);

  if (!parsed || !parsed.amount) {
    return getClient().replyMessage({
      replyToken,
      messages: [{ type: 'text', text: 'พิมพ์รูปแบบ "ชื่อร้าน จำนวนเงิน บาท" เช่น "7-Eleven 58 บาท" หรือส่งรูปสลิปมาได้เลย' }]
    });
  }

  const categoryId = getOrCreateCategoryId(null); // ข้อความสั้นเดาหมวดหมู่ยาก ให้เป็น "อื่นๆ" ไปก่อน ผู้ใช้แก้เองที่เว็บได้
  const category = db.prepare('SELECT name FROM categories WHERE id = ?').get(categoryId);
  const expenseId = insertExpense({
    amount: parsed.amount, category_id: categoryId, merchant: parsed.merchant, source: 'line_text'
  });

  return getClient().replyMessage({
    replyToken,
    messages: [{
      type: 'text',
      text: `บันทึกแล้ว ✅\n${parsed.merchant || 'ไม่ทราบร้านค้า'}\n${fmt(parsed.amount)} · ${category.name}\n\n(รายการ #${expenseId} แก้หมวดหมู่ได้ที่หน้าเว็บ)`
    }]
  });
}

router.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(async (event) => {
      if (event.type !== 'message') return;
      if (event.message.type === 'image') return handleImageMessage(event, event.replyToken);
      if (event.message.type === 'text') return handleTextMessage(event, event.replyToken);
    }));
    res.sendStatus(200);
  } catch (err) {
    console.error('LINE webhook error:', err);
    res.sendStatus(200); // ตอบ 200 เสมอ ไม่งั้น LINE จะ retry รัว
  }
});

module.exports = router;
