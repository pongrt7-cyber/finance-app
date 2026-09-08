const express = require('express');
const db = require('../db');
const { verifyToken } = require('../middleware/auth');
const { currentMonth, currentDate } = require('../utils/date');

const router = express.Router();
const TYPES = new Set(['salary', 'side', 'freelance', 'bonus', 'refund', 'other']);
const LABELS = {
  salary: 'เงินเดือนหลัก', side: 'รายได้เสริม', freelance: 'ฟรีแลนซ์',
  bonus: 'โบนัส', refund: 'เงินคืน', other: 'รายรับอื่นๆ'
};

function normalizeType(type) { return TYPES.has(String(type)) ? String(type) : 'other'; }
function list(month) {
  return db.prepare(`SELECT * FROM income_entries WHERE month=? ORDER BY income_date DESC, id DESC`).all(month);
}
function total(month) {
  return Number(db.prepare('SELECT COALESCE(SUM(amount),0) AS amount FROM income_entries WHERE month=?').get(month).amount || 0);
}

router.get('/current', (req, res) => {
  const month = currentMonth();
  const entries = list(month);
  const salary = entries.find(e => e.type === 'salary');
  res.json({ month, amount: total(month), locked: salary?.locked ? 1 : 0, entries });
});

router.get('/', (req, res) => {
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.month || '')) ? req.query.month : currentMonth();
  res.json({ month, total: total(month), entries: list(month) });
});

router.post('/', (req, res, next) => {
  const type = normalizeType(req.body.type || 'salary');
  if (type === 'salary') {
    const salary = db.prepare('SELECT * FROM income_entries WHERE month=? AND type=? LIMIT 1').get(currentMonth(), 'salary');
    if (salary?.locked) return verifyToken(req, res, next);
  }
  next();
}, (req, res) => {
  const amount = Number(req.body.amount);
  const type = normalizeType(req.body.type || 'salary');
  const title = String(req.body.title || LABELS[type]).trim() || LABELS[type];
  const incomeDate = String(req.body.income_date || currentDate());
  const month = incomeDate.slice(0, 7);
  const note = String(req.body.note || '').trim() || null;
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'จำนวนเงินไม่ถูกต้อง' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(incomeDate)) return res.status(400).json({ error: 'วันที่ไม่ถูกต้อง' });

  const existingSalary = type === 'salary'
    ? db.prepare('SELECT id FROM income_entries WHERE month=? AND type=? LIMIT 1').get(month, 'salary')
    : null;
  if (existingSalary) {
    db.prepare(`UPDATE income_entries SET amount=?, title=?, income_date=?, note=?, locked=1 WHERE id=?`)
      .run(amount, title, incomeDate, note, existingSalary.id);
    return res.json({ success: true, updated: true, entry: db.prepare('SELECT * FROM income_entries WHERE id=?').get(existingSalary.id) });
  }

  const result = db.prepare(`INSERT INTO income_entries
    (amount,type,title,income_date,month,note,locked,source) VALUES (?,?,?,?,?,?,?,?)`)
    .run(amount, type, title, incomeDate, month, note, type === 'salary' ? 1 : 0, 'manual');
  res.json({ success: true, entry: db.prepare('SELECT * FROM income_entries WHERE id=?').get(result.lastInsertRowid) });
});

router.delete('/:id', (req, res, next) => {
  const row = db.prepare('SELECT * FROM income_entries WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'ไม่พบรายรับ' });
  if (row.locked) return verifyToken(req, res, next);
  next();
}, (req, res) => {
  db.prepare('DELETE FROM income_entries WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
