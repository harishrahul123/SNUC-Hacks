# PocketCFO — how to run

## One-time setup

From the project root (`SNUC_Hacks`):

```bash
npm install
```

This installs root dependencies and runs `postinstall` to install `backend/` dependencies.

Copy Gmail OAuth config:

```bash
cp backend/.env.example backend/.env
```

Edit `backend/.env` and set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` (see `backend/.env.example`). Set `CORS_ORIGIN=http://localhost:3000` if the web UI runs on port 3000.

In Google Cloud Console, enable **Gmail API** and add **Authorized redirect URI**:  
`http://localhost:8080/auth/google/callback`

## Run everything (recommended)

```bash
npm run dev
```

Then open **http://localhost:3000** (sign in, then use **Transactions → Gmail Auto-Import**).

## Run separately (two terminals)

Terminal 1 — Gmail backend:

```bash
npm run start:backend
```

Terminal 2 — web UI:

```bash
npm start
```

Open **http://localhost:3000**.
