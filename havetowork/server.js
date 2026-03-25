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

// Serve all files in /public as static assets
app.use(express.static(path.join(__dirname, 'public')));

// Fallback: serve index.html for any unmatched route (SPA support)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  PocketCFO server running at http://localhost:${PORT}`);
  console.log(`  To expose via ngrok: ngrok http ${PORT}\n`);
});
