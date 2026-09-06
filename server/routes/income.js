const express = require('express');
const db = require('../db');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();

function currentMonth() {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

// GET current month income status
router.get('/current', (req, res) => {
  const month = currentMonth();
  const row = db.prepare('SELECT * FROM income WHERE month = ?').get(month);
  res.json(row || { month, amount: null, locked: 0 });
});

// POST set income for current month (requires unlock token if already locked)
router.post('/', (req, res, next) => {
  const month = currentMonth();
  const existing = db.prepare('SELECT * FROM income WHERE month = ?').get(month);
  if (existing && existing.locked) {
    return verifyToken(req, res, next); // must be unlocked first
  }
  next();
}, (req, res) => {
  const { amount } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'จำนวนเงินไม่ถูกต้อง' });
  const month = currentMonth();

  db.prepare(`
    INSERT INTO income (amount, month, locked) VALUES (?, ?, 1)
    ON CONFLICT(month) DO UPDATE SET amount = excluded.amount, locked = 1
  `).run(amount, month);

  res.json({ success: true, month, amount });
});

module.exports = router;
