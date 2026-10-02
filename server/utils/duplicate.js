const db = require('../db');

const CROSS_SOURCE_WINDOW_MINUTES = 6 * 60;

function minutesOfDay(value) {
  const m = String(value || '').match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return Number.isInteger(minutes) && minutes >= 0 && minutes < 1440 ? minutes : null;
}

function findCrossSourceDuplicate(amount, expenseDate, expenseTime, source) {
  if (!Number.isFinite(Number(amount)) || !expenseDate || !expenseTime) return null;
  const opposite = source === 'gmail' ? 'manual' : 'gmail';
  const sql = "SELECT e.id, e.amount, e.category_id, e.merchant, e.note, e.expense_date, e.expense_time, e.source " +
    "FROM expenses e WHERE e.amount = ? AND e.expense_date = ? AND e.source = ? " +
    "AND NULLIF(TRIM(e.merchant), '') IS NULL AND NULLIF(TRIM(e.note), '') IS NULL " +
    "ORDER BY e.id ASC";
  const rows = db.prepare(sql).all(Number(amount), expenseDate, opposite);
  const target = minutesOfDay(expenseTime);
  if (target == null) return null;
  return rows.find(row => {
    const candidate = minutesOfDay(row.expense_time);
    return candidate != null && Math.abs(candidate - target) <= CROSS_SOURCE_WINDOW_MINUTES;
  }) || null;
}

module.exports = { findCrossSourceDuplicate };
