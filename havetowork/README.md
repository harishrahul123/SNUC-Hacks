# PocketCFO

Smart Cash Flow Intelligence for small businesses.

---

## Project Structure

```
pocketcfo/
├── server.js          ← Express server (entry point)
├── package.json       ← Node dependencies
├── README.md
└── public/            ← Static frontend (served by Express)
    ├── index.html     ← HTML shell — loads CSS + JS
    ├── styles.css     ← All styles (extracted from original)
    └── app.js         ← All React components + app logic
```

---

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Start the server
```bash
npm start
```

The app will be running at **http://localhost:3000**

---

## Deploy with ngrok

### Install ngrok (if not already installed)
```bash
# macOS
brew install ngrok

# Linux / Windows
# Download from https://ngrok.com/download
```

### Authenticate (one-time setup)
```bash
ngrok config add-authtoken YOUR_NGROK_TOKEN
```

### Start tunnel
```bash
# Terminal 1 — start the app server
npm start

# Terminal 2 — expose it publicly
ngrok http 3000
```

ngrok will output a public URL like `https://abc123.ngrok.io` — share that link to access PocketCFO from anywhere.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT`   | `3000`  | Port the Express server listens on |

Example:
```bash
PORT=8080 npm start
# Then: ngrok http 8080
```

---

## Features

- **Dashboard** — real-time cash position, obligation priority queue, 30-day cash flow projection
- **Obligations** — add/remove upcoming payables with category, due date, flexibility flag
- **Receivables** — track incoming invoices and expected payment dates
- **Transaction History** — import bank statements (CSV/TXT), paste text, or extract from bank SMS messages
- **Future** — 6-month financial pathway projections (3 scenarios per metric)
- **Actions** — AI-powered decision engine + negotiation email drafts

---

## AI Integration

The app uses the **Groq API** (llama-3.1-8b-instant) for:
- Document parsing (bank statements, invoices)
- SMS financial data extraction
- Decision engine analysis with chain-of-thought reasoning
- Negotiation email drafting

Enter your Groq API key in the sidebar. Get a free key at [console.groq.com](https://console.groq.com).

All Groq calls are made **client-side** directly from the browser — your API key never touches this server.
