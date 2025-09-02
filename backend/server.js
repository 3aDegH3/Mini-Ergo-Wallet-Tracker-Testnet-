// backend/server.js
/**
 * Mini Ergo Wallet Tracker — robust backend (CSP + limit fixes)
 *
 * Install deps:
 *   npm install express cors node-fetch@2 morgan helmet express-rate-limit
 *
 * Run:
 *   node server.js
 */

const express = require('express');
const path = require('path');
const cors = require('cors');
const fetch = require('node-fetch'); // node-fetch v2 (CommonJS)
const morgan = require('morgan');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;
const TESTNET_BASE = 'https://api-testnet.ergoplatform.com/api/v1';

// --- basic middleware ---
// Helmet with CSP configured so CDN scripts (Tailwind, Chart.js) can load
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        'https://cdn.tailwindcss.com',
        'https://cdn.jsdelivr.net'
      ],
      styleSrc: [
        "'self'",
        "'unsafe-inline'",
        'https://cdn.jsdelivr.net',
        'https://fonts.googleapis.com',
        'https://cdn.tailwindcss.com'
      ],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'https://api-testnet.ergoplatform.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      objectSrc: ["'none'"],
    }
  }
}));

// allow cross-origin for development (if you will later host frontend separately you can lock this down)
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// serve frontend static files (expects ../frontend/index.html and assets)
app.use('/', express.static(path.join(__dirname, '..', 'frontend')));

// --- simple rate limiter (protect explorer from being hammered) ---
const limiter = rateLimit({
  windowMs: 15 * 1000, // 15s window
  max: 30, // limit each IP to 30 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down.' }
});
app.use('/api/', limiter);

// --- simple in-memory cache ---
const cache = new Map();
const CACHE_TTL_MS = 30 * 1000; // 30s - tune as needed

function getCached(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() - item.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return item.data;
}
function setCached(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

// --- helper: fetch with timeout and browser-like headers ---
const defaultTimeout = 30_000; // ms (increased)
async function fetchWithTimeout(url, opts = {}, timeoutMs = defaultTimeout) {
  const controller = typeof globalThis.AbortController !== 'undefined'
    ? new globalThis.AbortController()
    : null;

  if (controller) {
    opts.signal = controller.signal;
    var timeout = setTimeout(() => controller.abort(), timeoutMs);
  }

  // ensure sensible headers so Explorer accepts server requests
  opts.headers = Object.assign({
    'User-Agent': 'Mini-Ergo-Wallet-Tracker/1.0 (Node.js)',
    'Accept': 'application/json, text/plain, */*',
    'Referer': 'https://api-testnet.ergoplatform.com/'
  }, opts.headers || {});

  try {
    console.log('[proxy] fetching ->', url);
    const res = await fetch(url, opts);
    if (controller) clearTimeout(timeout);
    console.log('[proxy] response', url, res.status);
    return res;
  } catch (err) {
    if (controller) clearTimeout(timeout);
    console.error('[proxy] fetchWithTimeout error for', url, err && (err.stack || err.message || err));
    throw err;
  }
}

// --- endpoints ---

// health
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// get UTXOs for an address (with optional paging)
// IMPORTANT: explorer limits 'limit' to <= 500 — we cap it server-side.
app.get('/api/wallet/:address/utxos', async (req, res) => {
  try {
    const raw = String(req.params.address || '');
    const address = raw.replace(/\s/g, '').trim();
    if (!address) return res.status(400).json({ error: 'آدرس نامعتبر است' });

    // validate & cap limit
    let limit = parseInt(req.query.limit, 10) || 100;
    let offset = parseInt(req.query.offset, 10) || 0;
    if (Number.isNaN(limit) || limit <= 0) limit = 100;
    if (Number.isNaN(offset) || offset < 0) offset = 0;

    const EXPLORER_MAX_LIMIT = 500;
    if (limit > EXPLORER_MAX_LIMIT) limit = EXPLORER_MAX_LIMIT;

    const url = `${TESTNET_BASE}/boxes/byAddress/${encodeURIComponent(address)}?limit=${limit}&offset=${offset}`;

    // try cache
    const cached = getCached(url);
    if (cached) {
      return res.json({ fetchedAt: Date.now(), cached: true, from: url, items: cached.items || [] });
    }

    // call explorer
    const response = await fetchWithTimeout(url);
    if (!response.ok) {
      const txt = await response.text().catch(() => '');
      console.error('Explorer returned non-OK:', response.status, txt.slice(0, 1000));
      // if explorer returned client error (4xx), forward that status; if server error, surface as 502
      const statusToClient = response.status >= 500 ? 502 : response.status;
      return res.status(statusToClient).json({ error: 'خطا از Explorer', status: response.status, body: txt.slice(0, 1000) });
    }

    const json = await response.json();
    // normalize: ensure .items present
    const items = Array.isArray(json) ? json : (json.items || json);
    setCached(url, { items, raw: json });
    return res.json({ fetchedAt: Date.now(), cached: false, from: url, items });
  } catch (err) {
    console.error('Error /api/wallet/:address/utxos', err && (err.stack || err));
    if (err.name === 'AbortError') return res.status(504).json({ error: 'Explorer request timed out' });
    return res.status(500).json({ error: 'خطا در دریافت UTXOها', detail: String(err.message || err) });
  }
});

// get token info
app.get('/api/asset/:tokenId', async (req, res) => {
  try {
    const id = String(req.params.tokenId || '').trim();
    if (!id) return res.status(400).json({ error: 'tokenId لازم است' });

    const url = `${TESTNET_BASE}/tokens/${encodeURIComponent(id)}`;
    const cached = getCached(url);
    if (cached) return res.json({ fetchedAt: Date.now(), cached: true, from: url, item: cached });

    const resp = await fetchWithTimeout(url);
    if (!resp.ok) {
      const t = await resp.text().catch(()=>'');
      const statusToClient = resp.status >= 500 ? 502 : resp.status;
      return res.status(statusToClient).json({ error: 'Explorer token API error', status: resp.status, body: t.slice(0,1000) });
    }
    const json = await resp.json();
    setCached(url, json);
    return res.json({ fetchedAt: Date.now(), cached: false, from: url, item: json });
  } catch (err) {
    console.error('Error /api/asset/:tokenId', err && (err.stack || err));
    return res.status(500).json({ error: 'خطا در گرفتن اطلاعات توکن', detail: String(err.message || err) });
  }
});

// get tx details
app.get('/api/tx/:txId', async (req, res) => {
  try {
    const txId = String(req.params.txId || '').trim();
    if (!txId) return res.status(400).json({ error: 'txId لازم است' });

    const url = `${TESTNET_BASE}/transactions/byId/${encodeURIComponent(txId)}`;
    const cached = getCached(url);
    if (cached) return res.json({ fetchedAt: Date.now(), cached: true, from: url, item: cached });

    const resp = await fetchWithTimeout(url);
    if (!resp.ok) {
      const t = await resp.text().catch(()=>'');
      const statusToClient = resp.status >= 500 ? 502 : resp.status;
      return res.status(statusToClient).json({ error: 'Explorer tx API error', status: resp.status, body: t.slice(0,1000) });
    }
    const json = await resp.json();
    setCached(url, json);
    return res.json({ fetchedAt: Date.now(), cached: false, from: url, item: json });
  } catch (err) {
    console.error('Error /api/tx/:txId', err && (err.stack || err));
    return res.status(500).json({ error: 'خطا در گرفتن اطلاعات تراکنش', detail: String(err.message || err) });
  }
});

// summary (total ERG and token aggregation)
app.get('/api/summary/:address', async (req, res) => {
  try {
    const raw = String(req.params.address || '');
    const address = raw.replace(/\s/g, '').trim();
    if (!address) return res.status(400).json({ error: 'آدرس لازم است' });

    const url = `${TESTNET_BASE}/boxes/byAddress/${encodeURIComponent(address)}?limit=500`;
    const data = getCached(url) || (await (await fetchWithTimeout(url)).json());
    const items = (data && data.items) ? data.items : (Array.isArray(data) ? data : []);

    // aggregate
    let totalNanoErg = 0n;
    const tokenMap = new Map();
    items.forEach(it => {
      totalNanoErg += BigInt(it.value || 0);
      (it.assets || []).forEach(a => {
        const id = String(a.tokenId);
        const amt = BigInt(a.amount || 0);
        tokenMap.set(id, (tokenMap.get(id) || 0n) + amt);
      });
    });

    const tokens = Array.from(tokenMap.entries()).map(([tokenId, amount]) => ({ tokenId, amount: amount.toString() }));

    return res.json({
      fetchedAt: Date.now(),
      address,
      totalNanoErg: totalNanoErg.toString(),
      tokenCount: tokens.length,
      tokens,
      utxoCount: items.length
    });
  } catch (err) {
    console.error('Error /api/summary/:address', err && (err.stack || err));
    return res.status(500).json({ error: 'خطا در ساخت خلاصه', detail: String(err.message || err) });
  }
});

// final 404 fallback
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// graceful start
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Serving frontend from: ${path.join(__dirname, '..', 'frontend')}`);
});
