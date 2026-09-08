const db = require('./index');

// Multi-source income migration. Keeps the legacy income table untouched for rollback.
db.exec(`
  CREATE TABLE IF NOT EXISTS income_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    amount REAL NOT NULL,
    type TEXT NOT NULL DEFAULT 'salary',
    title TEXT,
    income_date TEXT NOT NULL,
    month TEXT NOT NULL,
    note TEXT,
    locked INTEGER DEFAULT 0,
    source TEXT DEFAULT 'manual',
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_income_entries_month ON income_entries(month);
  CREATE INDEX IF NOT EXISTS idx_income_entries_date ON income_entries(income_date);
`);

const count = db.prepare('SELECT COUNT(*) AS count FROM income_entries').get().count;
if (count === 0) {
  const legacy = db.prepare('SELECT * FROM income ORDER BY month ASC').all();
  const insert = db.prepare(`
    INSERT INTO income_entries (amount, type, title, income_date, month, note, locked, source)
    VALUES (?, 'salary', 'เงินเดือนหลัก', ?, ?, NULL, ?, 'legacy')
  `);
  for (const row of legacy) {
    insert.run(Number(row.amount), `${row.month}-01`, row.month, row.locked ? 1 : 0);
  }
}

module.exports = true;
