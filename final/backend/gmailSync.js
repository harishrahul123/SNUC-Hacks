const { google } = require('googleapis');
const { parseTransactionEmail } = require('./gmailParser');
const { isMessageProcessed, markMessageProcessed, getProcessedMessageIds } = require('./tokenStore');

function decodeBase64Url(data) {
  if (!data) return '';
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + pad, 'base64').toString('utf8');
}

function stripHtml(html) {
  return String(html || '').replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractTextFromPayload(payload) {
  if (!payload) return '';

  // If payload itself is text
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return stripHtml(decodeBase64Url(payload.body.data));
  }

  // Otherwise search parts recursively
  if (Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      const text = extractTextFromPayload(part);
      if (text) return text;
    }
  }
  return '';
}

function extractMessageText(message) {
  const payload = message?.payload;
  let text = extractTextFromPayload(payload);
  if (!text && message?.snippet) text = message.snippet;
  return text || '';
}

async function syncTransactionsForEmail({ oauth2Client, email, q, maxResults = 20 }) {
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  // Fetch candidate messages
  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: q || 'newer_than:2m (debited OR credited OR UPI)',
    maxResults,
  });

  const ids = (listRes.data.messages || []).map(m => m.id);
  if (!ids.length) return [];

  // Dedup (backend-level)
  const processed = new Set(getProcessedMessageIds(email));
  const toFetch = ids.filter(id => !processed.has(id)).slice(0, maxResults);

  const results = [];
  for (const id of toFetch) {
    const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    const subject = msg.data?.payload?.headers?.find(h => h.name?.toLowerCase() === 'subject')?.value || '';
    const bodyText = extractMessageText(msg.data);
    const parsed = parseTransactionEmail(subject, bodyText);

    // Mark processed even if parse fails (prevents repeated work)
    markMessageProcessed(email, id);

    if (parsed) {
      results.push({
        id,
        ...parsed,
      });
    }
  }
  return results;
}

module.exports = {
  syncTransactionsForEmail,
};

