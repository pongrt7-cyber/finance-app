// Uses Node's native sqlite module (Node >=22.5 with --experimental-sqlite,
// stable in Node 24+). Avoids better-sqlite3 native compilation issues.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'finance.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

const db = new DatabaseSync(DB_PATH);
db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));

module.exports = db;
