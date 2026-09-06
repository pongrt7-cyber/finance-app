const express = require('express');
const db = require('../db');
const router = express.Router();

// GET expenses with optional filters: date range, category, search, payment
router.get('/', (req, res) => {
  const { from, to, category_id, q, payment_method } = req.query;
  let sql = `
    SELECT e.*, c.name AS category_name
    FROM expenses e
    JOIN categories c ON c.id = e.category_id
    WHERE 1=1
  `;
  const params = [];

  if (from) { sql += ' AND e.expense_date >= ?'; params.push(from); }
  if (to) { sql += ' AND e.expense_date <= ?'; params.push(to); }
  if (category_id) { sql += ' AND e.category_id = ?'; params.push(category_id); }
  if (payment_method) { sql += ' AND e.payment_method = ?'; params.push(payment_method); }
  if (q) {
    sql += ' AND (e.merchant LIKE ? OR e.note LIKE ?)';
    params.push(`%${q}%`, `%${q}%`);
  }
  sql += ' ORDER BY e.expense_date DESC, e.expense_time DESC, e.id DESC';

  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

// GET single day
router.get('/day/:date', (req, res) => {
  const rows = db.prepare(`
    SELECT e.*, c.name AS category_name FROM expenses e
    JOIN categories c ON c.id = e.category_id
    WHERE e.expense_date = ?
    ORDER BY e.expense_time DESC
  `).all(req.params.date);
  res.json(rows);
});

// POST create expense (manual)
router.post('/', (req, res) => {
  const {
    amount, category_id, merchant, note,
    payment_method, is_state_welfare,
    expense_date, expense_time, source
  } = req.body;

  if (!amount || amount <= 0) return res.status(400).json({ error: 'จำนวนเงินไม่ถูกต้อง' });
  if (!category_id) return res.status(400).json({ error: 'ต้องระบุหมวดหมู่' });
  if (!expense_date) return res.status(400).json({ error: 'ต้องระบุวันที่' });

  const info = db.prepare(`
    INSERT INTO expenses
      (amount, category_id, merchant, note, payment_method, is_state_welfare, expense_date, expense_time, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    amount, category_id, merchant || null, note || null,
    payment_method || 'เงินสด', is_state_welfare ? 1 : 0,
    expense_date, expense_time || null, source || 'manual'
  );

  res.json({ id: Number(info.lastInsertRowid) });
});

// PUT update
router.put('/:id', (req, res) => {
  const { amount, category_id, merchant, note, payment_method, is_state_welfare, expense_date, expense_time } = req.body;
  db.prepare(`
    UPDATE expenses SET
      amount = ?, category_id = ?, merchant = ?, note = ?,
      payment_method = ?, is_state_welfare = ?, expense_date = ?, expense_time = ?
    WHERE id = ?
  `).run(amount, category_id, merchant, note, payment_method, is_state_welfare ? 1 : 0, expense_date, expense_time, req.params.id);
  res.json({ success: true });
});

// DELETE
router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM expenses WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
