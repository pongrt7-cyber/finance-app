const express = require('express');
const db = require('../db');
const router = express.Router();

router.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM savings_goals ORDER BY created_at DESC').all());
});

router.post('/', (req, res) => {
  const { name, target_amount, target_date } = req.body;
  if (!name || !target_amount) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
  const info = db.prepare(`
    INSERT INTO savings_goals (name, target_amount, target_date) VALUES (?, ?, ?)
  `).run(name, target_amount, target_date || null);
  res.json({ id: Number(info.lastInsertRowid) });
});

router.put('/:id/add', (req, res) => {
  const amount = Number(req.body?.amount || 0);
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'จำนวนเงินออมต้องมากกว่า 0' });
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
