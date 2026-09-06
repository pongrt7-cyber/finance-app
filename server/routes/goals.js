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
  const { amount } = req.body;
  db.prepare('UPDATE savings_goals SET current_amount = current_amount + ? WHERE id = ?')
    .run(amount, req.params.id);
  res.json({ success: true });
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM savings_goals WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
