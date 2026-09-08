-- Finance App Schema (SQLite)

CREATE TABLE IF NOT EXISTS income (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  amount REAL NOT NULL,
  month TEXT NOT NULL UNIQUE, -- format: YYYY-MM
  locked INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

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

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  is_default INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  amount REAL NOT NULL,
  category_id INTEGER NOT NULL,
  merchant TEXT,
  note TEXT,
  payment_method TEXT DEFAULT 'เงินสด', -- เงินสด, โอน, บัตรเครดิต, บัตรเดบิต, ไทยช่วยไทย, อื่นๆ
  is_state_welfare INTEGER DEFAULT 0, -- ไทยช่วยไทย flag
  expense_date TEXT NOT NULL, -- YYYY-MM-DD
  expense_time TEXT,          -- HH:MM
  source TEXT DEFAULT 'manual', -- manual, ai_image, ai_text
  created_at TEXT DEFAULT (datetime('now', 'localtime')),
  FOREIGN KEY (category_id) REFERENCES categories(id)
);

CREATE TABLE IF NOT EXISTS budgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL,
  monthly_limit REAL NOT NULL,
  UNIQUE(category_id),
  FOREIGN KEY (category_id) REFERENCES categories(id)
);

CREATE TABLE IF NOT EXISTS savings_goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  target_amount REAL NOT NULL,
  current_amount REAL DEFAULT 0,
  target_date TEXT,
  created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS category_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern TEXT NOT NULL UNIQUE,
  category_id INTEGER NOT NULL,
  use_count INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT DEFAULT (datetime('now', 'localtime')),
  FOREIGN KEY (category_id) REFERENCES categories(id)
);

INSERT OR IGNORE INTO categories (name, is_default) VALUES
  ('ค่าห้อง', 1),
  ('ค่าเน็ต', 1),
  ('ค่าน้ำมัน', 1),
  ('ค่ากิน', 1),
  ('เสื้อผ้า', 0),
  ('เกม', 0),
  ('ของใช้', 0),
  ('อุปกรณ์ไอที', 0),
  ('ค่ารถ', 0),
  ('อื่นๆ', 0);
