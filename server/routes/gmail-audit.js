const express = require('express');
const db = require('../db');
const router = express.Router();

function monthOk(value) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || '')); }
function summary(month) {
  const imported = db.prepare(`SELECT COUNT(*) count FROM imported_emails WHERE imported_at LIKE ?`).get(`${month}%`).count;
  const expenses = db.prepare(`SELECT COUNT(*) count, COALESCE(SUM(e.amount),0) total FROM expenses e WHERE e.source='gmail' AND e.expense_date LIKE ?`).get(`${month}%`);
  const income = db.prepare(`SELECT COUNT(*) count, COALESCE(SUM(amount),0) total FROM income_entries WHERE source='gmail' AND month=?`).get(month);
  return { imported, importedExpenses: expenses.count, importedExpenseTotal: Number(expenses.total || 0), importedIncome: income.count, importedIncomeTotal: Number(income.total || 0) };
}

router.get('/summary', (req, res) => {
  const month = String(req.query.month || '').trim();
  if (!monthOk(month)) return res.status(400).json({ error: 'รูปแบบเดือนต้องเป็น YYYY-MM' });
  res.json({ month, ...summary(month) });
});

router.get('/imported', (req, res) => {
  const month = String(req.query.month || '').trim();
  if (!monthOk(month)) return res.status(400).json({ error: 'รูปแบบเดือนต้องเป็น YYYY-MM' });
  const rows = db.prepare(`SELECT ie.id, ie.gmail_id, ie.kind, ie.expense_id, ie.fingerprint, ie.imported_at,
    e.amount AS expense_amount, e.merchant, e.expense_date, e.category_id FROM imported_emails ie
    LEFT JOIN expenses e ON e.id=ie.expense_id WHERE ie.imported_at LIKE ? ORDER BY ie.imported_at DESC LIMIT 200`).all(`${month}%`);
  res.json({ month, items: rows });
});

router.get('/integrity', (req, res) => {
  const orphan = db.prepare(`SELECT COUNT(*) count FROM imported_emails ie WHERE ie.kind='expense' AND NOT EXISTS (SELECT 1 FROM expenses e WHERE e.id=ie.expense_id)`).get().count;
  const duplicateGmail = db.prepare(`SELECT COUNT(*) count FROM (SELECT gmail_id FROM imported_emails GROUP BY gmail_id HAVING COUNT(*)>1)`).get().count;
  const duplicateFingerprint = db.prepare(`SELECT COUNT(*) count FROM (SELECT fingerprint FROM imported_emails WHERE fingerprint IS NOT NULL GROUP BY fingerprint HAVING COUNT(*)>1)`).get().count;
  const firstTracked = db.prepare('SELECT MIN(imported_at) AS first FROM imported_emails').get()?.first;
  const legacyClause = firstTracked ? ` AND e.expense_date >= substr(?,1,10)` : '';
  const gmailExpensesWithoutImport = firstTracked
    ? db.prepare(`SELECT COUNT(*) count FROM expenses e WHERE e.source='gmail' ${legacyClause} AND NOT EXISTS (SELECT 1 FROM imported_emails ie WHERE ie.expense_id=e.id)`).get(firstTracked).count
    : 0;
  const legacyUnlinked = firstTracked
    ? db.prepare(`SELECT COUNT(*) count FROM expenses e WHERE e.source='gmail' AND e.expense_date < substr(?,1,10) AND NOT EXISTS (SELECT 1 FROM imported_emails ie WHERE ie.expense_id=e.id)`).get(firstTracked).count
    : 0;
  return res.json({ orphanImportedEmails: orphan, duplicateGmailIds: duplicateGmail, duplicateFingerprints: duplicateFingerprint, gmailExpensesWithoutImport, legacyUnlinkedGmailExpenses: legacyUnlinked });
});

router.get('/reconciliation', (req, res) => {
  const month = String(req.query.month || '').trim();
  if (!monthOk(month)) return res.status(400).json({ error: 'รูปแบบเดือนต้องเป็น YYYY-MM' });
  const rows = db.prepare(`SELECT e.id, e.amount, e.expense_date, e.merchant, e.note, ie.gmail_id, ie.imported_at
    FROM expenses e LEFT JOIN imported_emails ie ON ie.expense_id=e.id
    WHERE e.source='gmail' AND e.expense_date LIKE ? ORDER BY e.expense_date DESC, e.id DESC`).all(`${month}%`);
  const matched = rows.filter(r => r.gmail_id);
  const missing = rows.filter(r => !r.gmail_id);
  const importedTotal = matched.reduce((s, r) => s + Number(r.amount || 0), 0);
  const financeTotal = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
  res.json({ month, financeCount: rows.length, matchedCount: matched.length, missingCount: missing.length,
    financeTotal: Number(financeTotal.toFixed(2)), matchedTotal: Number(importedTotal.toFixed(2)),
    missingTotal: Number(missing.reduce((s,r)=>s+Number(r.amount||0),0).toFixed(2)), items: rows });
});

router.delete('/imported/:id', (req, res) => {
  const row = db.prepare('SELECT id, gmail_id, kind, expense_id FROM imported_emails WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'ไม่พบประวัติ Gmail' });
  db.prepare('DELETE FROM imported_emails WHERE id=?').run(row.id);
  res.json({ success: true, gmailId: row.gmail_id, kind: row.kind });
});

module.exports = router;
