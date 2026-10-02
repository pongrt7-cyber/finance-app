function createGmailPush({ db, google, oauthClient, topic, loadToken, getMessageWithBackoff, listMessages, toCandidate }) {
  let processing = Promise.resolve();

  async function startGmailPushWatch() {
    if (!topic) return { enabled: false, reason: 'GMAIL_PUBSUB_TOPIC is not configured' };
    const token = loadToken();
    if (!token) return { enabled: false, reason: 'Gmail is not connected' };
    const client = oauthClient();
    client.setCredentials(token);
    const gmail = google.gmail({ version: 'v1', auth: client });
    const response = await gmail.users.watch({
      userId: 'me',
      requestBody: { topicName: topic, labelIds: ['INBOX'], labelFilterBehavior: 'INCLUDE' }
    });
    const historyId = response.data?.historyId;
    const expiration = response.data?.expiration;
    if (!historyId || !expiration) throw new Error('Gmail watch returned an incomplete response');
    db.prepare("INSERT INTO settings(key,value) VALUES('gmail_history_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(historyId));
    db.prepare("INSERT INTO settings(key,value) VALUES('gmail_watch_expiration',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(expiration));
    db.prepare("INSERT INTO settings(key,value) VALUES('gmail_push_status',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run('active');
    return { enabled: true, historyId: String(historyId), expiration: Number(expiration) };
  }

  async function processGmailHistory(notificationHistoryId) {
    processing = processing.then(async () => {
      const token = loadToken();
      if (!token) throw new Error('Gmail is not connected');
      const previousHistoryId = db.prepare("SELECT value FROM settings WHERE key='gmail_history_id'").get()?.value;
      if (!previousHistoryId) {
        db.prepare("INSERT INTO settings(key,value) VALUES('gmail_history_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(notificationHistoryId));
        return { initialized: true, imported: 0, duplicates: 0, messageCount: 0 };
      }
      const client = oauthClient();
      client.setCredentials(token);
      const gmail = google.gmail({ version: 'v1', auth: client });
      const messageIds = new Set();
      let pageToken; let latestHistoryId = String(notificationHistoryId);
      try {
        do {
          const response = await gmail.users.history.list({
            userId: 'me',
            startHistoryId: String(previousHistoryId),
            historyTypes: ['messageAdded'],
            maxResults: 100,
            pageToken
          });
          for (const item of response.data.history || []) {
            for (const added of item.messagesAdded || []) {
              if (added.message?.id) messageIds.add(added.message.id);
            }
          }
          latestHistoryId = response.data.historyId || latestHistoryId;
          pageToken = response.data.nextPageToken;
        } while (pageToken);
      } catch (error) {
        if (error?.code !== 404 && error?.status !== 404) throw error;
        const fallback = await listMessages(gmail, 'newer_than:2d', 100);
        for (const [id] of fallback) messageIds.add(id);
      }

      let imported = 0; let duplicates = 0;
      for (const id of messageIds) {
        if (db.prepare('SELECT 1 FROM imported_emails WHERE gmail_id=?').get(id)) {
          duplicates++;
          continue;
        }
        const full = await getMessageWithBackoff(gmail, id);
        const candidate = toCandidate(full.data);
        const text = String(candidate.subject || '') + ' ' + String(candidate.detail || '');
        const statement = /monthly statement|account statement|trade statement|order history|ใบแจ้งยอด|สรุปรายการลงทุน/i.test(text);
        const valid = candidate.amount != null && candidate.type && candidate.bank && !statement && candidate.confidence === 'high';
        if (!valid) continue;
        const result = await importCandidate(candidate);
        if (result.duplicate) duplicates++; else imported++;
      }

      db.prepare("INSERT INTO settings(key,value) VALUES('gmail_history_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(latestHistoryId));
      return { initialized: false, imported, duplicates, messageCount: messageIds.size };
    });
    return processing;
  }

  async function importCandidate(candidate) {
    const res = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/gmail/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidate })
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(result.error || 'Gmail push import failed');
    return result;
  }

  return { startGmailPushWatch, processGmailHistory };
}

module.exports = { createGmailPush };
