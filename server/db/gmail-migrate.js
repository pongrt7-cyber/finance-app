const db = require('../db');
db.exec(`CREATE TABLE IF NOT EXISTS imported_emails (id INTEGER PRIMARY KEY AUTOINCREMENT, gmail_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, expense_id INTEGER, source TEXT DEFAULT 'gmail', imported_at TEXT DEFAULT (datetime('now','localtime')));`);
