const express = require('express');
const db = require('../db');
const router = express.Router();

router.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM savings_goals ORDER BY created_at DESC').all());
});

router.post('/', (req, res) => {
  const name = String(req.body?.name || '').trim();
  const targetAmount = Number(req.body?.target_amount);
  const targetDate = req.body?.target_date ? String(req.body.target_date) : null;
  if (!name || name.length > 100) return res.status(400).json({ error: 'ชื่อเป้าหมายไม่ถูกต้อง' });
  if (!Number.isFinite(targetAmount) || targetAmount <= 0 || targetAmount >= 1000000000) {
    return res.status(400).json({ error: 'จำนวนเป้าหมายไม่ถูกต้อง' });
  }
  if (targetDate && !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    return res.status(400).json({ error: 'วันที่เป้าหมายไม่ถูกต้อง' });
  }
  const info = db.prepare(`
    INSERT INTO savings_goals (name, target_amount, target_date) VALUES (?, ?, ?)
  `).run(name, targetAmount, targetDate);
  res.json({ id: Number(info.lastInsertRowid) });
});

router.put('/:id/add', (req, res) => {
  const amount = Number(req.body?.amount || 0);
  if (!Number.isFinite(amount) || amount <= 0 || amount >= 1000000000) return res.status(400).json({ error: 'จำนวนเงินออมไม่ถูกต้อง' });
  const goal = db.prepare('SELECT id, target_amount, current_amount FROM savings_goals WHERE id = ?').get(req.params.id);
  if (!goal) return res.status(404).json({ error: 'ไม่พบเป้าหมายการออม' });
  const next = Math.min(Number(goal.current_amount || 0) + amount, Number(goal.target_amount || 0));
  db.prepare('UPDATE savings_goals SET current_amount = ? WHERE id = ?').run(next, req.params.id);
  res.json({ success: true, current_amount: next, added: Math.max(0, next - Number(goal.current_amount || 0)) });
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM savings_goals WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
