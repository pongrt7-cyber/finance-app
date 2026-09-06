const express = require('express');
const db = require('../db');
const router = express.Router();

// GET settings
router.get('/', (req, res) => {
  const settings = db.prepare('SELECT * FROM settings').all();
  const result = {};
  settings.forEach(s => result[s.key] = s.value);
  res.json(result);
});

// POST update settings
router.post('/', (req, res) => {
  const { tct_limit, admin_pass } = req.body;
  
  if (tct_limit !== undefined) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('tct_limit', tct_limit);
  }
  if (admin_pass !== undefined && admin_pass !== '') {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('admin_pass', admin_pass);
  }
  
  res.json({ success: true });
});

module.exports = router;
