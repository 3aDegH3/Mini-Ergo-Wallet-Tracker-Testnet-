# Mini Ergo Wallet Tracker — Testnet

A small, educational full-stack project that proxies Ergo Testnet Explorer and displays UTXOs and token balances for a given address.

- **Backend:** Node.js + Express — proxy endpoints, simple in-memory cache, timeouts, basic security (Helmet), and rate limiting.
- **Frontend:** Vanilla HTML / JavaScript / CSS — paginated UTXO table, user-friendly token panel (cards), details modal, CSV export and JSON copy.

---

## Features

- Proxy endpoints that normalize Explorer responses and add caching/fallback.
- Request timeouts and Abort handling to avoid slow upstream responses.
- Rate limiting on `/api/` endpoints and basic Helmet security headers.
- Frontend:
  - Stable, paginated UTXO table (`table-layout: fixed`) to avoid layout breakage with long strings.
  - Token panel: card view with amount, percent of total, progress bars, copy tokenId and token details.
  - Clickable UTXO rows with JSON details modal (JSON is rendered LTR for readability).
  - Export CSV and copy JSON functionality.

---

## Tech stack

- Node.js (Express)
- Vanilla JavaScript (ES modules not required)
- Plain HTML & CSS (Tailwind CDN used optionally in `index.html`)

---

## Prerequisites

- Node.js v16+ (v18 recommended)
- npm (or yarn/pnpm)
- Network access to `https://api-testnet.ergoplatform.com`

---

## Quickstart (local)

```bash
# 1. clone the repo
git clone <your-repo-url>
cd mini-wallet

# 2. install backend deps
cd backend
npm install

# 3. run the server (serves frontend statically)
npm start

# for development with live reload:
# npm install --save-dev nodemon
# npm run dev   # if script is defined in package.json
