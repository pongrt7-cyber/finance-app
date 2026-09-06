const express = require('express');
const bcrypt = require('bcryptjs');
const { issueToken } = require('../middleware/auth');
const db = require('../db');

const router = express.Router();

// Password hash stored in settings table (key='admin_password_hash')
router.post('/unlock', async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'ต้องกรอกรหัสผ่าน' });

  const row = db.prepare("SELECT value FROM settings WHERE key = 'admin_password_hash'").get();

  // First run: no password set yet -> seed from .env ADMIN_PASSWORD
  if (!row) {
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'admin', 10);
    db.prepare("INSERT INTO settings (key, value) VALUES ('admin_password_hash', ?)").run(hash);
  }

  const stored = db.prepare("SELECT value FROM settings WHERE key = 'admin_password_hash'").get();
  const match = await bcrypt.compare(password, stored.value);
  if (!match) return res.status(401).json({ error: 'รหัสผ่านไม่ถูกต้อง' });

  res.json({ token: issueToken() });
});

router.post('/change-password', async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'รหัสผ่านต้องมีอย่างน้อย 4 ตัวอักษร' });
  }
  const hash = await bcrypt.hash(newPassword, 10);
  db.prepare(`
    INSERT INTO settings (key, value) VALUES ('admin_password_hash', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(hash);
  res.json({ success: true });
});

module.exports = router;
