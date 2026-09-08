const express = require('express');
const db = require('../db');
const router = express.Router();

// Get system overview/stats for admin
router.get('/stats', (req, res) => {
  const totalExpenses = db.prepare('SELECT SUM(amount) as total FROM expenses').get().total || 0;
  const totalIncome = db.prepare('SELECT SUM(amount) as total FROM income_entries').get().total || 0;
  const userCount = 1; // Single user system currently
  
  res.json({ totalExpenses, totalIncome, userCount });
});

// Reset database (DANGER - placeholder)
router.post('/reset', (req, res) => {
  // In a real system, you'd add heavy security here
  try {
    db.exec('DELETE FROM expenses; DELETE FROM income_entries; DELETE FROM income; DELETE FROM budgets; DELETE FROM savings_goals;');
    res.json({ success: true, message: 'Data reset successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
