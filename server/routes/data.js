const express = require('express');
const db = require('../db');
const router = express.Router();

function allExpenses() {
  return db.prepare(`
    SELECT e.*, c.name AS category_name FROM expenses e
    JOIN categories c ON c.id = e.category_id ORDER BY e.expense_date DESC
  `).all();
}

router.get('/export/json', (req, res) => {
  const payload = {
    exported_at: new Date().toISOString(),
    income: db.prepare('SELECT * FROM income').all(),
    expenses: allExpenses(),
    categories: db.prepare('SELECT * FROM categories').all(),
    budgets: db.prepare('SELECT * FROM budgets').all(),
    savings_goals: db.prepare('SELECT * FROM savings_goals').all()
  };
  res.setHeader('Content-Disposition', 'attachment; filename=finance-backup.json');
  res.json(payload);
});

router.get('/export/csv', (req, res) => {
  const rows = allExpenses();
  const header = 'id,amount,category,merchant,note,payment_method,is_state_welfare,date,time\n';
  const body = rows.map(r =>
    [r.id, r.amount, r.category_name, r.merchant || '', r.note || '', r.payment_method, r.is_state_welfare, r.expense_date, r.expense_time || ''].join(',')
  ).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=expenses.csv');
  res.send('\uFEFF' + header + body); // BOM for Excel Thai support
});

router.post('/import/json', (req, res) => {
  const { expenses, categories } = req.body;
  const insertCat = db.prepare('INSERT OR IGNORE INTO categories (name, is_default) VALUES (?, 0)');
  const insertExp = db.prepare(`
    INSERT INTO expenses (amount, category_id, merchant, note, payment_method, is_state_welfare, expense_date, expense_time, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'import')
  `);
  const getCatId = db.prepare('SELECT id FROM categories WHERE name = ?');

  if (categories) categories.forEach(c => insertCat.run(c.name));
  if (expenses) {
    expenses.forEach(e => {
      const cat = getCatId.get(e.category_name || e.category);
      if (!cat) return;
      insertExp.run(e.amount, cat.id, e.merchant, e.note, e.payment_method || 'เงินสด', e.is_state_welfare ? 1 : 0, e.expense_date, e.expense_time);
    });
  }
  res.json({ success: true });
});

router.post('/clear', (req, res) => {
  db.exec('DELETE FROM expenses; DELETE FROM income; DELETE FROM budgets; DELETE FROM savings_goals;');
  res.json({ success: true });
});

module.exports = router;
