const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const { runTesseractOcr } = require('../ocr/ocrEngine');
const { extractFields } = require('../ocr/extractFields');
const router = express.Router();

const upload = multer({ storage: multer.diskStorage({
  destination: os.tmpdir(),
  filename: (req, file, cb) => cb(null, `slip_${Date.now()}${path.extname(file.originalname) || '.jpg'}`)
}), limits: { fileSize: 8 * 1024 * 1024 } });

const CATEGORY_HINT = () =>
  db.prepare('SELECT name FROM categories').all().map(c => c.name).join(', ');

async function callClaude(messages) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages
    })
  });
  if (!resp.ok) throw new Error(`Claude API error: ${resp.status}`);
  const data = await resp.json();
  const text = data.content.map(b => b.text || '').join('');
  return text.replace(/```json|```/g, '').trim();
}

// POST /api/ai/parse-image - upload slip/receipt image, read via Tesseract.js (free, pure JS, no native deps)
router.post('/parse-image', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ไม่พบไฟล์รูปภาพ' });
  const filePath = req.file.path;

  try {
    const lines = await runTesseractOcr(filePath);
    const parsed = extractFields(lines);

    if (parsed.category) {
      const exists = db.prepare('SELECT 1 FROM categories WHERE name = ?').get(parsed.category);
      if (!exists) parsed.category = null;
    }

    res.json(parsed);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'อ่านสลิปไม่สำเร็จ กรุณากรอกเอง' });
  } finally {
    fs.unlink(filePath, () => {});
  }
});

// POST /api/ai/parse-text - short text e.g. "7-Eleven 58 บาท"
router.post('/parse-text', async (req, res) => {
  const { text: input } = req.body;
  if (!input) return res.status(400).json({ error: 'ต้องระบุข้อความ' });
  try {
    const prompt = `แปลงข้อความรายจ่ายนี้เป็น JSON เท่านั้น (ห้ามมีข้อความอื่น): "${input}"
รูปแบบ: {"merchant": "ชื่อร้าน หรือ null", "amount": ตัวเลข, "category": "เลือกจากรายการนี้เท่านั้น: ${CATEGORY_HINT()}"}
ใช้วันที่และเวลาปัจจุบันเสมอ ถ้าไม่ระบุจำนวนเงินให้ amount เป็น null`;

    const text = await callClaude([{ role: 'user', content: prompt }]);
    const parsed = JSON.parse(text);
    const now = new Date();
    parsed.date = now.toISOString().slice(0, 10);
    parsed.time = now.toTimeString().slice(0, 5);
    res.json(parsed);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'แปลข้อความไม่สำเร็จ กรุณากรอกเอง' });
  }
});

// GET /api/ai/analysis - monthly AI summary
router.get('/analysis', async (req, res) => {
  const month = new Date().toISOString().slice(0, 7);
  const expenses = db.prepare(`
    SELECT e.amount, e.merchant, c.name AS category, e.expense_date
    FROM expenses e JOIN categories c ON c.id = e.category_id
    WHERE e.expense_date LIKE ?
  `).all(`${month}%`);

  if (expenses.length === 0) return res.json({ summary: 'ยังไม่มีรายจ่ายเดือนนี้' });

  try {
    const prompt = `นี่คือรายจ่ายเดือน ${month} ของผู้ใช้ (JSON): ${JSON.stringify(expenses)}
วิเคราะห์และสรุปเป็นภาษาไทย 4-6 bullet สั้นๆ ครอบคลุม: หมวดที่ใช้เงินมากที่สุดกี่%, ร้านที่ใช้บ่อยที่สุด, ค่าเฉลี่ยต่อวัน, คำแนะนำลดรายจ่าย 1 ข้อ`;

    const summary = await callClaude([{ role: 'user', content: prompt }]);
    res.json({ summary });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'วิเคราะห์ไม่สำเร็จ' });
  }
});

module.exports = router;
