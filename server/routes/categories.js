const express = require('express');
const db = require('../db');
const router = express.Router();

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM categories ORDER BY is_default DESC, name ASC').all();
  res.json(rows);
});

router.post('/', (req, res) => {
  const rawName = String(req.body?.name || '').trim();
  if (!rawName) return res.status(400).json({ error: 'ต้องระบุชื่อหมวดหมู่' });

  const existing = db.prepare('SELECT id, name FROM categories WHERE lower(name) = lower(?) LIMIT 1').get(rawName);
  if (existing) return res.json({ id: Number(existing.id), name: existing.name, existing: true });

  try {
    const info = db.prepare('INSERT INTO categories (name, is_default) VALUES (?, 0)').run(rawName);
    res.json({ id: Number(info.lastInsertRowid), name: rawName, created: true });
  } catch (error) {
    const duplicate = db.prepare('SELECT id, name FROM categories WHERE lower(name) = lower(?) LIMIT 1').get(rawName);
    if (duplicate) return res.json({ id: Number(duplicate.id), name: duplicate.name, existing: true });
    res.status(500).json({ error: 'ไม่สามารถสร้างหมวดหมู่ได้' });
  }
});

module.exports = router;
