const express = require('express');
const db = require('../db');
const router = express.Router();

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM categories ORDER BY is_default DESC, name ASC').all();
  res.json(rows);
});

router.post('/', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'ต้องระบุชื่อหมวดหมู่' });
  try {
    const info = db.prepare('INSERT INTO categories (name, is_default) VALUES (?, 0)').run(name.trim());
    res.json({ id: Number(info.lastInsertRowid), name: name.trim() });
  } catch {
    res.status(409).json({ error: 'มีหมวดหมู่นี้อยู่แล้ว' });
  }
});

module.exports = router;
