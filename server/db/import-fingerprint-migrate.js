const db = require('../db');

try {
  db.exec("ALTER TABLE imported_emails ADD COLUMN fingerprint TEXT");
} catch (error) {
  if (!String(error.message).includes('duplicate column name')) throw error;
}

db.exec('CREATE INDEX IF NOT EXISTS idx_imported_emails_fingerprint ON imported_emails(fingerprint);');

module.exports = db;
