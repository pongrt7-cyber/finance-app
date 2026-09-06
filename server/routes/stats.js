const express = require('express');
const db = require('../db');
const router = express.Router();

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

function daysPassedInMonth(month) {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 7);
  if (todayStr !== month) return daysInMonth(month);
  return today.getDate();
}

// Dashboard summary for current month
router.get('/dashboard', (req, res) => {
  const month = currentMonth();
  const income = db.prepare('SELECT amount FROM income WHERE month = ?').get(month);
  const salary = income ? income.amount : 0;

  const totalRow = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total FROM expenses
    WHERE expense_date LIKE ?
  `).get(`${month}%`);
  const totalExpense = totalRow.total;

  const remaining = salary - totalExpense;
  const usedPct = salary > 0 ? (totalExpense / salary) * 100 : 0;

  const totalDays = daysInMonth(month);
  const passed = daysPassedInMonth(month);
  const remainingDays = Math.max(totalDays - passed, 1);
  const dailyBudget = remaining > 0 ? remaining / remainingDays : 0;

  const byCategory = db.prepare(`
    SELECT c.name, SUM(e.amount) AS total
    FROM expenses e JOIN categories c ON c.id = e.category_id
    WHERE e.expense_date LIKE ?
    GROUP BY c.id ORDER BY total DESC
  `).all(`${month}%`);

  const recent = db.prepare(`
    SELECT e.*, c.name AS category_name FROM expenses e
    JOIN categories c ON c.id = e.category_id
    ORDER BY e.expense_date DESC, e.expense_time DESC, e.id DESC LIMIT 10
  `).all();

  res.json({
    month,
    salary,
    totalExpense,
    remaining,
    usedPct: Math.round(usedPct * 10) / 10,
    dailyBudget: Math.round(dailyBudget),
    byCategory,
    recent
  });
});

// Stats for a period: today | week | month | year
router.get('/period/:range', (req, res) => {
  const { range } = req.params;
  const today = new Date();
  let from;

  if (range === 'today') from = today.toISOString().slice(0, 10);
  else if (range === 'week') {
    const d = new Date(today);
    d.setDate(d.getDate() - 7);
    from = d.toISOString().slice(0, 10);
  } else if (range === 'month') from = today.toISOString().slice(0, 7) + '-01';
  else if (range === 'year') from = today.toISOString().slice(0, 4) + '-01-01';
  else return res.status(400).json({ error: 'range ไม่ถูกต้อง (today|week|month|year)' });

  const to = today.toISOString().slice(0, 10);

  const total = db.prepare(`
    SELECT COALESCE(SUM(amount),0) AS total FROM expenses
    WHERE expense_date BETWEEN ? AND ?
  `).get(from, to).total;

  const byCategory = db.prepare(`
    SELECT c.name, SUM(e.amount) AS total, COUNT(*) AS count
    FROM expenses e JOIN categories c ON c.id = e.category_id
    WHERE e.expense_date BETWEEN ? AND ?
    GROUP BY c.id ORDER BY total DESC
  `).all(from, to);

  const topExpense = db.prepare(`
    SELECT e.*, c.name AS category_name FROM expenses e
    JOIN categories c ON c.id = e.category_id
    WHERE e.expense_date BETWEEN ? AND ?
    ORDER BY e.amount DESC LIMIT 1
  `).get(from, to);

  const dailyTrend = db.prepare(`
    SELECT expense_date AS date, SUM(amount) AS total
    FROM expenses WHERE expense_date BETWEEN ? AND ?
    GROUP BY expense_date ORDER BY expense_date ASC
  `).all(from, to);

  res.json({ range, from, to, total, byCategory, topExpense, dailyTrend });
});

module.exports = router;
