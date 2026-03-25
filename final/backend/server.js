const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const { getOAuthClient, getScopes, getUserEmailFromOAuth } = require('./googleAuth');
const { upsertTokens, getSingleConnectedUserEmail, getTokensByEmail, clearProcessed, deleteUser } = require('./tokenStore');
const { syncTransactionsForEmail } = require('./gmailSync');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cors({ origin: process.env.CORS_ORIGIN || '*', credentials: false }));

const PORT = process.env.PORT || 8080;

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/api/gmail/status', async (req, res) => {
  try {
    const email = getSingleConnectedUserEmail();
    const connected = !!email;
    res.json({ connected, email });
  } catch (e) {
    res.status(500).json({ connected: false, error: e.message });
  }
});

app.get('/auth/google/start', (req, res) => {
  try {
    const oauth2Client = getOAuthClient();
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: getScopes(),
    });
    res.redirect(authUrl);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send('Missing OAuth code');

    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);

    oauth2Client.setCredentials(tokens);
    const email = await getUserEmailFromOAuth(oauth2Client);
    if (!email) return res.status(500).send('Could not determine connected Gmail email.');

    upsertTokens(email, tokens);

    // Close OAuth tab if possible (helps UX). User can then return to the app.
    res.send(`
      <html><body style="font-family: Arial, sans-serif; padding: 24px;">
        <h3>Gmail connected.</h3>
        <p>You can close this tab and click <b>Sync transactions</b> in the app.</p>
        <script>setTimeout(()=>window.close(), 500);</script>
      </body></html>
    `);
  } catch (e) {
    res.status(500).send(`OAuth callback error: ${e.message}`);
  }
});

app.post('/api/gmail/sync', async (req, res) => {
  try {
    const email = getSingleConnectedUserEmail();
    if (!email) return res.status(400).json({ error: 'Connect Gmail first.' });

    const tokens = getTokensByEmail(email);
    if (!tokens) return res.status(400).json({ error: 'Missing stored Gmail tokens.' });

    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials(tokens);

    const sinceMinutes = Number(req.body?.sinceMinutes || process.env.POLL_WINDOW_MINUTES || 2);
    const sinceDays = Number(req.body?.sinceDays || 0);

    // Wider filter window is ok because we dedupe by messageId.
    const newerThan = sinceDays > 0 ? `${Math.max(1, sinceDays)}d` : `${Math.max(1, sinceMinutes)}m`;
    const q = req.body?.q || `newer_than:${newerThan} (debited OR credited OR UPI OR "UPI transaction")`;

    const transactions = await syncTransactionsForEmail({
      oauth2Client,
      email,
      q,
      maxResults: Number(req.body?.maxResults || 20),
    });

    res.json({ transactions, fetchedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/gmail/reset', async (req, res) => {
  try {
    const email = getSingleConnectedUserEmail();
    if (!email) return res.status(400).json({ error: 'Connect Gmail first.' });
    const ok = clearProcessed(email);
    res.json({ ok, email });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/gmail/disconnect', async (req, res) => {
  try {
    const email = getSingleConnectedUserEmail();
    if (!email) return res.json({ ok: true, disconnected: false });
    const ok = deleteUser(email);
    res.json({ ok, disconnected: ok, email });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Backend listening on http://localhost:${PORT}`);
});

