/**
 * PocketCFO — server.js
 * Minimal Express server serving the static frontend.
 * Run with: node server.js
 * Then expose publicly with: ngrok http 3000
 */

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve all files in /Public as static assets
app.use(express.static(path.join(__dirname, 'Public')));

// Fallback: serve index.html for any unmatched route (SPA support)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'Public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  PocketCFO web UI:  http://localhost:${PORT}`);
  console.log(`  Gmail API backend: http://localhost:8080 (run: npm run start:backend)`);
  console.log(`  Full stack:         npm run dev\n`);
});
