const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '.data';
const STORE_FILE = path.join(__dirname, DATA_DIR, 'gmail_store.json');

function ensureDir() {
  const dir = path.dirname(STORE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function defaultStore() {
  return { users: {} };
}

function readStore() {
  ensureDir();
  if (!fs.existsSync(STORE_FILE)) return defaultStore();
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    if (!raw.trim()) return defaultStore();
    return JSON.parse(raw);
  } catch {
    return defaultStore();
  }
}

function writeStore(store) {
  ensureDir();
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), 'utf8');
}

function getUsers(store = readStore()) {
  return store.users || {};
}

function getSingleConnectedUserEmail(store = readStore()) {
  const users = getUsers(store);
  const emails = Object.keys(users);
  return emails.length ? emails[0] : null;
}

function upsertTokens(email, tokens, extra = {}) {
  const store = readStore();
  store.users = store.users || {};
  store.users[email] = store.users[email] || {};
  store.users[email].tokens = tokens;
  store.users[email].email = email;
  store.users[email].updatedAt = new Date().toISOString();
  store.users[email].processed = Array.isArray(store.users[email].processed) ? store.users[email].processed : [];
  // Store non-sensitive metadata (not required, but useful for debugging)
  store.users[email].extra = extra;
  writeStore(store);
}

function getTokensByEmail(email) {
  const store = readStore();
  return store.users?.[email]?.tokens || null;
}

function getProcessedMessageIds(email) {
  const store = readStore();
  const processed = store.users?.[email]?.processed;
  return Array.isArray(processed) ? processed : [];
}

function isMessageProcessed(email, messageId) {
  const processed = getProcessedMessageIds(email);
  return processed.includes(messageId);
}

function markMessageProcessed(email, messageId, maxToKeep = 500) {
  const store = readStore();
  if (!store.users?.[email]) return;
  const processed = Array.isArray(store.users[email].processed) ? store.users[email].processed : [];
  if (!processed.includes(messageId)) processed.unshift(messageId);
  // Trim oldest
  store.users[email].processed = processed.slice(0, maxToKeep);
  store.users[email].updatedAt = new Date().toISOString();
  writeStore(store);
}

function clearProcessed(email) {
  const store = readStore();
  if (!store.users?.[email]) return false;
  store.users[email].processed = [];
  store.users[email].updatedAt = new Date().toISOString();
  writeStore(store);
  return true;
}

function deleteUser(email) {
  const store = readStore();
  if (!store.users?.[email]) return false;
  delete store.users[email];
  writeStore(store);
  return true;
}

module.exports = {
  getSingleConnectedUserEmail,
  getTokensByEmail,
  getProcessedMessageIds,
  isMessageProcessed,
  markMessageProcessed,
  clearProcessed,
  deleteUser,
  upsertTokens,
};

