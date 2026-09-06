const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const router = express.Router();

// GET settings
router.get('/', (req, res) => {
  const settings = db.prepare('SELECT * FROM settings').all();
  const result = {};
  settings.forEach(s => { if (s.key !== 'admin_password_hash') result[s.key] = s.value; });
  res.json(result);
});

// POST update settings
router.post('/', async (req, res) => {
  const { tct_limit, admin_pass } = req.body;

  if (tct_limit !== undefined) {
    db.prepare(`
      INSERT INTO settings (key, value) VALUES ('tct_limit', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(tct_limit));
  }

  if (admin_pass !== undefined && admin_pass !== '') {
    if (admin_pass.length < 4) return res.status(400).json({ error: 'รหัสผ่านต้องมีอย่างน้อย 4 ตัวอักษร' });
    const hash = await bcrypt.hash(admin_pass, 10);
    db.prepare(`
      INSERT INTO settings (key, value) VALUES ('admin_password_hash', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(hash);
  }

  res.json({ success: true });
});

module.exports = router;
