const express = require('express');
const db = require('../db');
const { currentMonth } = require('../utils/date');
const router = express.Router();


router.get('/', (req, res) => {
  const month = currentMonth();
  const rows = db.prepare(`
    SELECT b.id, b.category_id, c.name AS category_name, b.monthly_limit,
      COALESCE((
        SELECT SUM(amount) FROM expenses e
        WHERE e.category_id = b.category_id AND e.expense_date LIKE ?
      ), 0) AS spent
    FROM budgets b JOIN categories c ON c.id = b.category_id
  `).all(`${month}%`);
  res.json(rows);
});

router.post('/', (req, res) => {
  const { category_id, monthly_limit } = req.body;
  if (!category_id || !monthly_limit) return res.status(400).json({ error: 'à¸‚à¹‰à¸­à¸¡à¸¹à¸¥à¹„à¸¡à¹ˆà¸„à¸£à¸š' });
  db.prepare(`
    INSERT INTO budgets (category_id, monthly_limit) VALUES (?, ?)
    ON CONFLICT(category_id) DO UPDATE SET monthly_limit = excluded.monthly_limit
  `).run(category_id, monthly_limit);
  res.json({ success: true });
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM budgets WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
