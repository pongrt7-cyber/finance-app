const crypto = require('crypto');
const db = require('../db');

try {
  db.exec("ALTER TABLE imported_emails ADD COLUMN fingerprint TEXT");
} catch (error) {
  if (!String(error.message).includes('duplicate column name')) throw error;
}

db.exec('CREATE INDEX IF NOT EXISTS idx_imported_emails_fingerprint ON imported_emails(fingerprint);');

function fingerprint(kind, date, amount, merchant) {
  const name = String(merchant || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!name || !date) return null;
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return null;
  const timestamp = parsed.toISOString().slice(0, 16);
  const raw = [kind, timestamp, Number(amount || 0).toFixed(2), name].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// Backfill semantic fingerprints for legacy Gmail imports where a merchant/recipient exists.
// Rows without a merchant stay un-fingerprinted to avoid false duplicate matches.
const legacy = db.prepare(`
  SELECT ie.id, ie.kind,
         e.expense_date AS expense_date, e.expense_time AS expense_time, e.amount AS expense_amount, e.merchant,
         i.income_date AS income_date, i.amount AS income_amount, i.title
  FROM imported_emails ie
  LEFT JOIN expenses e ON e.id = ie.expense_id
  LEFT JOIN income_entries i ON ie.kind='income' AND i.id = ie.expense_id
  WHERE ie.fingerprint IS NULL
`).all();

for (const row of legacy) {
  // Only backfill expenses with a recorded transaction time. Older rows without
  // a time are left un-fingerprinted to avoid false duplicate matches.
  if (row.kind !== 'expense' || !row.expense_date || !row.merchant || !row.expense_amount) continue;
  const time = String(row.expense_time || '').trim();
  if (!time) continue;
  const fp = fingerprint(row.kind, row.expense_date + 'T' + time, row.expense_amount, row.merchant);
  if (fp) db.prepare('UPDATE imported_emails SET fingerprint=? WHERE id=?').run(fp, row.id);
}

module.exports = db;
