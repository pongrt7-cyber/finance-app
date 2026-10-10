const fs = require('fs');
const path = require('path');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const tursoUrl = String(process.env.TURSO_DATABASE_URL || '').trim();
const tursoToken = String(process.env.TURSO_AUTH_TOKEN || '').trim();
const useTurso = Boolean(tursoUrl && tursoToken);

let db;

function createTursoConnection() {
  const Database = require('libsql');
  return new Database(tursoUrl, { authToken: tursoToken });
}

if (useTurso) {
  db = createTursoConnection();
} else {
  const { DatabaseSync } = require('node:sqlite');
  const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'finance.db');
  db = new DatabaseSync(DB_PATH);
}

db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));

// Long-lived Render instances can retain an expired Turso Hrana stream.
// The failure is raised during prepare(), before a statement is executed, so
// reconnecting and retrying preparation once is safe for both reads and writes.
function isExpiredTursoStream(error) {
  return /stream not found/i.test(String(error?.message || error));
}

function reconnectTurso() {
  const previous = db;
  db = createTursoConnection();
  try {
    previous.close();
  } catch {
    // The connection can already be in a failed state.
  }
  console.warn('[database] Reconnected to Turso after an expired Hrana stream.');
}

module.exports = new Proxy({}, {
  get(_target, property) {
    if (property === 'prepare') {
      return (...args) => {
        try {
          return db.prepare(...args);
        } catch (error) {
          if (!useTurso || !isExpiredTursoStream(error)) throw error;

          reconnectTurso();
          // Retry once only; any second failure is surfaced to the caller.
          return db.prepare(...args);
        }
      };
    }

    const value = db[property];
    return typeof value === 'function' ? value.bind(db) : value;
  },

  set(_target, property, value) {
    db[property] = value;
    return true;
  }
});
