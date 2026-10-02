require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

require('./db/gmail-migrate');
require('./db/category-memory-migrate');
require('./db/import-fingerprint-migrate');
require('./db/income-migrate');

app.use('/api/auth', require('./routes/auth'));
app.use('/api/income', require('./routes/income'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/expenses', require('./routes/expenses'));
app.use('/api/stats', require('./routes/stats'));
app.use('/api/monthly', require('./routes/monthly'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/budgets', require('./routes/budgets'));
app.use('/api/goals', require('./routes/goals'));
app.use('/api/ai', require('./routes/ai'));
app.use('/api/data', require('./routes/data'));
const gmailRoute = require('./routes/gmail');
app.use('/api/gmail', gmailRoute);
app.use('/api/gmail-audit', require('./routes/gmail-audit'));

async function autoImportGmail() {
  try {
    const statusRes = await fetch('http://127.0.0.1:3000/api/gmail/status');
    const status = await statusRes.json();
    if (!status.connected) return;

    const res = await fetch('http://127.0.0.1:3000/api/gmail/messages?q=newer_than:2d&limit=100');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gmail scan failed');

    let saved = 0;
    for (const candidate of data.messages || []) {
      if (candidate.confidence !== 'high') continue;
      const importRes = await fetch('http://127.0.0.1:3000/api/gmail/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidate })
      });
      if (importRes.ok) {
        const imported = await importRes.json().catch(() => ({}));
        if (!imported.duplicate) saved++;
      }
    }
    if (saved) console.log(`Gmail daily auto-import: saved=${saved}`);
  } catch (error) {
    console.error('Gmail daily auto-import:', error.message);
  }
}

function scheduleDailyGmailImport() {
  if (process.env.GMAIL_PUBSUB_TOPIC) {
    console.log('Gmail push configured; daily Gmail polling is disabled.');
    return;
  }
  const now = new Date();
  const next = new Date(now);
  next.setHours(23, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const delay = next.getTime() - now.getTime();

  console.log(`Gmail daily auto-import scheduled for ${next.toLocaleString('th-TH')}`);
  setTimeout(() => {
    autoImportGmail();
    setInterval(autoImportGmail, 24 * 60 * 60 * 1000);
  }, delay);
}

// One automatic Gmail scan per day at 23:00 local server time.
// Manual scans from the Gmail page remain available.
scheduleDailyGmailImport();

async function renewGmailPushWatch() {
  if (!process.env.GMAIL_PUBSUB_TOPIC) return;
  try {
    const result = await gmailRoute.startGmailPushWatch();
    console.log('Gmail push watch:', result);
  } catch (error) {
    console.error('Gmail push watch renewal:', error.message);
  }
}

// Renew Gmail watch once per day; Google requires renewal at least every 7 days.
setTimeout(() => {
  renewGmailPushWatch();
  setInterval(renewGmailPushWatch, 24 * 60 * 60 * 1000);
}, 5000);

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Finance App running at http://localhost:${PORT}`);
  console.log(`Tailscale access: http://<tailscale-ip>:${PORT}`);
});
