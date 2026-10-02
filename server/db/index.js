const fs = require('fs');
const path = require('path');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const tursoUrl = String(process.env.TURSO_DATABASE_URL || '').trim();
const tursoToken = String(process.env.TURSO_AUTH_TOKEN || '').trim();

let db;

if (tursoUrl && tursoToken) {
  const Database = require('libsql');
  db = new Database(tursoUrl, { authToken: tursoToken });
} else {
  const { DatabaseSync } = require('node:sqlite');
  const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'finance.db');
  db = new DatabaseSync(DB_PATH);
}

db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));

module.exports = db;
