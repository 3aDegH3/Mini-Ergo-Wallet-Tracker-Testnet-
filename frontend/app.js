// frontend/app.js
// Mini Ergo Wallet Tracker — frontend logic (user-friendly token cards)

const API_ROOT = ''; // same origin

// DOM refs
const form = document.getElementById('wallet-form');
const addressInput = document.getElementById('wallet-address');
const statusDiv = document.getElementById('status');
const tableBody = document.querySelector('#utxo-table tbody');
const showingCount = document.getElementById('showing-count');

const filterToken = document.getElementById('filter-token');
const filterMin = document.getElementById('filter-min');
const sortBy = document.getElementById('sort-by');
const autoRefresh = document.getElementById('auto-refresh');
const refreshIntervalInput = document.getElementById('refresh-interval');

const prevPageBtn = document.getElementById('prev-page');
const nextPageBtn = document.getElementById('next-page');

const exportCsvBtn = document.getElementById('export-csv');
const copyJsonBtn = document.getElementById('copy-json');

const summaryAddress = document.getElementById('summary-address');
const summaryErg = document.getElementById('summary-erg');
const summaryTokenCount = document.getElementById('summary-token-count');
const summaryUtxoCount = document.getElementById('summary-utxo-count');

const tokensSearch = document.getElementById('tokens-search');
const tokensSort = document.getElementById('tokens-sort');
const tokensListEl = document.getElementById('tokens-list');

const modal = document.getElementById('modal');
const modalContent = document.getElementById('modal-content');
const closeModalBtn = document.getElementById('close-modal');

// state
let currentAddress = '';
let currentItems = [];
let pageLimit = 20;
let pageOffset = 0;
let autoRefreshTimer = null;
let lastSeenBoxIds = new Set();

// token metadata cache
const tokenMetaCache = new Map();

// helper: format amounts (BigInt-aware)
function formatTokenAmountExact(amountStr) {
  try {
    return BigInt(amountStr).toString();
  } catch {
    return String(amountStr || '0');
  }
}
function formatTokenAmountHuman(amountStr) {
  try {
    let a = BigInt(amountStr);
    const absA = a < 0n ? -a : a;
    if (absA >= 1_000_000_000_000n) return `${(Number(a / 1_000_000_000n) / 1000).toLocaleString()}T`;
    if (absA >= 1_000_000_000n) return `${(Number(a / 1_000_000n) / 1000).toLocaleString()}B`;
    if (absA >= 1_000_000n) return `${(Number(a / 1000n) / 1000).toLocaleString()}M`;
    if (absA >= 1000n) return `${(Number(a / 100n) / 10).toLocaleString()}K`;
    return a.toString();
  } catch {
    return String(amountStr || '0');
  }
}

// small deterministic color generator from string
function colorFromString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i);
  const r = (h >> 16) & 0xff, g = (h >> 8) & 0xff, b = h & 0xff;
  return `rgb(${Math.abs(r)%200+30}, ${Math.abs(g)%200+30}, ${Math.abs(b)%200+30})`;
}

function simpleId(id, len = 10) {
  if (!id) return '-';
  return id.slice(0, len) + (id.length > len ? '…' : '');
}

function showStatus(text, isError = false) {
  statusDiv.textContent = text;
  statusDiv.style.color = isError ? '#b91c1c' : '';
}

// basic fetch wrapper
async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    const txt = await res.text().catch(()=>'<no body>');
    throw new Error(`HTTP ${res.status}: ${txt.slice(0,1000)}`);
  }
  return await res.json();
}

// existing UTXO + summary fetchers
async function fetchUTXOs(address, limit=500, offset=0) {
  const url = `${API_ROOT}/api/wallet/${encodeURIComponent(address)}/utxos?limit=${Math.min(500,limit)}&offset=${offset}`;
  const j = await fetchJson(url);
  return j.items || [];
}
async function fetchSummary(address) {
  try { return await fetchJson(`${API_ROOT}/api/summary/${encodeURIComponent(address)}`); }
  catch (e) { console.warn('summary fetch failed', e); return null; }
}

// token metadata fetcher with cache (small batch concurrency)
async function fetchTokenMetaBulk(tokenIds, batchSize = 8) {
  const results = {};
  const toFetch = [];
  tokenIds.forEach(id => {
    if (tokenMetaCache.has(id)) results[id] = tokenMetaCache.get(id);
    else toFetch.push(id);
  });
  for (let i=0;i<toFetch.length;i+=batchSize) {
    const batch = toFetch.slice(i, i+batchSize);
    await Promise.all(batch.map(async id => {
      try {
        const j = await fetchJson(`${API_ROOT}/api/asset/${encodeURIComponent(id)}`);
        const item = j && (j.item || j);
        const name = item && (item.name || item.tokenName || item.metadata && item.metadata.name) || null;
        const symbol = item && (item.symbol || item.ticker || item.metadata && item.metadata.symbol) || null;
        const decimals = item && (typeof item.decimals === 'number' ? item.decimals : (item.decimals ? Number(item.decimals) : null));
        const meta = { tokenId: id, name: name || null, symbol: symbol || null, decimals: decimals ?? null };
        tokenMetaCache.set(id, meta);
        results[id] = meta;
      } catch (err) {
        tokenMetaCache.set(id, { tokenId: id, name: null, symbol: null, decimals: null });
        results[id] = tokenMetaCache.get(id);
      }
    }));
  }
  return results;
}

// ---------- rendering tokens panel (USER-FRIENDLY) ----------
async function renderTokensPanel(tokens) {
  // tokens: [{ tokenId, amount }, ...]
  tokensListEl.innerHTML = '';
  if (!tokens || tokens.length === 0) {
    tokensListEl.innerHTML = '<div class="text-sm text-slate-500">توکنی وجود ندارد.</div>';
    return;
  }

  // fetch metas
  const tokenIds = tokens.map(t => String(t.tokenId));
  const metas = await fetchTokenMetaBulk(tokenIds, 8);

  // compute totals using BigInt
  let total = 0n;
  tokens.forEach(t => {
    try { total += BigInt(String(t.amount || '0')); } catch { }
  });
  if (total === 0n) total = 1n; // avoid div-by-zero

  // prepare list of items enriched
  const enriched = tokens.map(t => {
    const id = String(t.tokenId);
    const meta = metas[id] || { tokenId: id, name: null, symbol: null };
    const amount = String(t.amount || '0');
    const amtBig = (() => { try { return BigInt(amount); } catch { return 0n; } })();
    const percentScaled = Number((amtBig * 10000n) / total); // percent * 100 (two decimals)
    const percent = (percentScaled / 100).toFixed(2);
    return { tokenId: id, amount, amtBig, meta, percent: Number(percent) };
  });

  // sorting + filtering from UI
  function buildAndRenderList() {
    const q = (tokensSearch.value || '').trim().toLowerCase();
    const sort = tokensSort.value || 'amount_desc';
    let list = enriched.slice();

    if (q) {
      list = list.filter(it => {
        const name = (it.meta.name || it.meta.symbol || it.tokenId).toString().toLowerCase();
        return name.includes(q) || it.tokenId.includes(q);
      });
    }

    if (sort === 'amount_desc') list.sort((a,b) => (b.amtBig - a.amtBig > 0n) ? 1 : -1);
    else if (sort === 'amount_asc') list.sort((a,b) => (a.amtBig - b.amtBig > 0n) ? 1 : -1);
    else if (sort === 'name_asc') list.sort((a,b) => {
      const na = (a.meta.name || a.meta.symbol || a.tokenId).toLowerCase();
      const nb = (b.meta.name || b.meta.symbol || b.tokenId).toLowerCase();
      return na < nb ? -1 : (na > nb ? 1 : 0);
    });

    // render top (but allow scrolling, still cap to e.g. 200 to avoid DOM explosion)
    const CAP = 200;
    list.slice(0, CAP).forEach(it => {
      const card = document.createElement('div');
      card.className = 'token-card';

      const avatar = document.createElement('div');
      avatar.className = 'token-avatar';
      const labelForAvatar = (it.meta.symbol || it.meta.name || it.tokenId).toString();
      avatar.style.background = colorFromString(it.tokenId);
      avatar.textContent = (it.meta.symbol || it.meta.name || it.tokenId).toString().slice(0,2).toUpperCase();

      const info = document.createElement('div');
      info.className = 'token-info';
      const title = document.createElement('div');
      title.className = 'token-title';
      title.title = it.meta.name || it.meta.symbol || it.tokenId;
      title.textContent = it.meta.name ? `${it.meta.name} ${it.meta.symbol ? '('+it.meta.symbol+')' : ''}` : (it.meta.symbol || simpleId(it.tokenId, 12));
      const sub = document.createElement('div');
      sub.className = 'token-sub';
      sub.textContent = simpleId(it.tokenId, 24);

      const controls = document.createElement('div');
      controls.className = 'token-controls';
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.textContent = 'کپی id';
      copyBtn.style.fontSize = '12px';
      copyBtn.addEventListener('click', (ev)=> {
        ev.stopPropagation();
        navigator.clipboard.writeText(it.tokenId).then(()=> {
          copyBtn.textContent = 'کپی شد';
          setTimeout(()=> copyBtn.textContent = 'کپی id', 900);
        }).catch(()=> alert('کپی ناموفق'));
      });

      const showBtn = document.createElement('button');
      showBtn.type = 'button';
      showBtn.textContent = 'جزئیات';
      showBtn.style.fontSize = '12px';
      showBtn.addEventListener('click', (ev)=> {
        ev.stopPropagation();
        openTokenModal(it);
      });

      controls.appendChild(copyBtn);
      controls.appendChild(showBtn);

      info.appendChild(title);
      info.appendChild(sub);
      info.appendChild(controls);

      const right = document.createElement('div');
      right.className = 'token-right';
      const amtHuman = document.createElement('div');
      amtHuman.style.fontWeight = '700';
      amtHuman.textContent = formatTokenAmountHuman(it.amount);
      const amtExact = document.createElement('div');
      amtExact.style.fontSize = '12px';
      amtExact.style.opacity = 0.8;
      amtExact.textContent = `${it.amount} — ${it.percent}%`;

      const progWrap = document.createElement('div');
      progWrap.className = 'token-progress';
      const bar = document.createElement('div');
      bar.className = 'bar';
      // set width using percent
      bar.style.width = Math.max(0, Math.min(100, it.percent)) + '%';
      progWrap.appendChild(bar);

      right.appendChild(amtHuman);
      right.appendChild(amtExact);
      right.appendChild(progWrap);

      card.appendChild(avatar);
      card.appendChild(info);
      card.appendChild(right);

      // clicking card opens token modal
      card.addEventListener('click', ()=> openTokenModal(it));
      tokensListEl.appendChild(card);
    });

    // if total items > CAP, show notice
    if (list.length > CAP) {
      const moreDiv = document.createElement('div');
      moreDiv.className = 'text-sm text-slate-500';
      moreDiv.textContent = `نمایش ${CAP} آیتم اول از ${list.length} (برای نمایش بقیه تغییر فیلتر یا مرتب‌سازی را امتحان کنید)`;
      tokensListEl.appendChild(moreDiv);
    }
  }

  // wire search & sort handlers (debounced)
  let tmr = null;
  function triggerRenderDebounced() {
    if (tmr) clearTimeout(tmr);
    tmr = setTimeout(buildAndRenderList, 200);
  }
  tokensSearch.oninput = triggerRenderDebounced;
  tokensSort.onchange = buildAndRenderList;

  // initial render
  buildAndRenderList();
}

// token modal: show more metadata + amount
function openTokenModal(item) {
  // item: { tokenId, amount, meta, percent }
  const lines = [];
  lines.push(`TokenId: ${item.tokenId}`);
  if (item.meta.name) lines.push(`Name: ${item.meta.name}`);
  if (item.meta.symbol) lines.push(`Symbol: ${item.meta.symbol}`);
  if (item.meta.decimals !== null && item.meta.decimals !== undefined) lines.push(`Decimals: ${item.meta.decimals}`);
  lines.push(`Amount: ${formatTokenAmountExact(item.amount)}`);
  lines.push(`Human: ${formatTokenAmountHuman(item.amount)}`);
  lines.push(`Percent of total: ${item.percent}%`);
  modalContent.style.direction = 'ltr';
  modalContent.style.textAlign = 'left';
  modalContent.textContent = lines.join('\n');
  modal.classList.remove('hidden'); modal.classList.add('flex');
}

function closeModal() { modal.classList.add('hidden'); modal.classList.remove('flex'); }

// render table (kept simple, similar to previous)
function renderTable(items) {
  tableBody.innerHTML = '';
  items.forEach(it => {
    const tr = document.createElement('tr');
    if (!lastSeenBoxIds.has(it.boxId)) tr.classList.add('highlight-new');

    const tdBox = document.createElement('td');
    tdBox.textContent = simpleId(it.boxId || '', 40);
    tdBox.title = it.boxId || '';

    const tdValue = document.createElement('td');
    tdValue.textContent = (Number(it.value || 0)/1e9).toLocaleString('en-US');
    tdValue.title = `nanoERG: ${it.value || 0}`;

    const tdTokens = document.createElement('td');
    tdTokens.textContent = (it.assets || []).map(a => `${simpleId(a.tokenId, 8)}(${a.amount})`).join(', ') || '-';
    tdTokens.title = (it.assets || []).map(a => `${a.tokenId} (${a.amount})`).join('\n');

    const tdHeight = document.createElement('td'); tdHeight.textContent = it.creationHeight || '-';
    const tdSpent = document.createElement('td'); tdSpent.textContent = it.spentTransactionId ? simpleId(it.spentTransactionId, 20) : '-';

    tr.appendChild(tdBox); tr.appendChild(tdValue); tr.appendChild(tdTokens); tr.appendChild(tdHeight); tr.appendChild(tdSpent);
    tr.addEventListener('click', ()=> {
      modalContent.style.direction = 'ltr';
      modalContent.style.textAlign = 'left';
      modalContent.textContent = JSON.stringify(it, null, 2);
      modal.classList.remove('hidden'); modal.classList.add('flex');
    });
    tableBody.appendChild(tr);
  });
  showingCount.textContent = items.length;
}

// apply filters & sort for table (unchanged)
function applyFiltersAndSort(items) {
  const tokenQ = filterToken.value.trim();
  const minQ = Number(filterMin.value) || 0;
  let filtered = items.filter(it => (Number(it.value || 0) >= minQ));
  if (tokenQ) filtered = filtered.filter(it => (it.assets || []).some(a => String(a.tokenId).includes(tokenQ)));
  const s = sortBy.value;
  if (s === 'value_desc') filtered.sort((a,b)=> (Number(b.value||0) - Number(a.value||0)));
  if (s === 'value_asc') filtered.sort((a,b)=> (Number(a.value||0) - Number(b.value||0)));
  if (s === 'height_desc') filtered.sort((a,b)=> (Number(b.creationHeight||0) - Number(a.creationHeight||0)));
  if (s === 'height_asc') filtered.sort((a,b)=> (Number(a.creationHeight||0) - Number(a.creationHeight||0)));
  return filtered;
}

// main refresh
async function doRefresh(full=false) {
  if (!currentAddress) return;
  showStatus('در حال بارگذاری...');
  try {
    const items = await fetchUTXOs(currentAddress, 500, 0);
    currentItems = items || [];

    const summ = await fetchSummary(currentAddress);
    if (summ) {
      summaryAddress.textContent = currentAddress;
      summaryErg.textContent = summ.totalNanoErg ? (Number(summ.totalNanoErg)/1e9).toLocaleString('en-US') : '-';
      summaryTokenCount.textContent = summ.tokenCount ?? '-';
      summaryUtxoCount.textContent = summ.utxoCount ?? currentItems.length;
      // render token panel (user-friendly)
      await renderTokensPanel(summ.tokens || []);
    }

    const processed = applyFiltersAndSort(currentItems.slice());
    const pageItems = processed.slice(pageOffset, pageOffset + pageLimit);
    renderTable(pageItems);

    currentItems.forEach(it => lastSeenBoxIds.add(it.boxId));
    showStatus(`به‌روزرسانی انجام شد — ${processed.length} مورد (نمایش ${pageItems.length})`);
  } catch (err) {
    console.error(err);
    showStatus(`خطا در دریافت داده‌ها: ${err && err.message ? err.message : 'unknown'}`, true);
  }
}

// auto refresh
function startAutoRefresh() { stopAutoRefresh(); const s = Number(refreshIntervalInput.value) || 15; autoRefreshTimer = setInterval(()=> doRefresh(), Math.max(5000, s*1000)); }
function stopAutoRefresh() { if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; } }

// pagination buttons
prevPageBtn.addEventListener('click', ()=> { pageOffset = Math.max(0, pageOffset - pageLimit); doRefresh(); });
nextPageBtn.addEventListener('click', ()=> { pageOffset += pageLimit; doRefresh(); });

// export CSV
exportCsvBtn.addEventListener('click', ()=> {
  if (!currentItems || currentItems.length === 0) return alert('هیچ داده‌ای برای صادرات نیست');
  const rows = currentItems.map(it => ({
    boxId: it.boxId,
    value: it.value,
    erg: (Number(it.value || 0)/1e9).toString(),
    tokens: (it.assets || []).map(a => `${a.tokenId}(${a.amount})`).join(';'),
    creationHeight: it.creationHeight || ''
  }));
  const header = Object.keys(rows[0]).join(',');
  const csvBody = rows.map(r => Object.values(r).map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const csv = header + '\n' + csvBody;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `${currentAddress || 'wallet'}_utxos.csv`; a.click();
  URL.revokeObjectURL(url);
});

// copy JSON
copyJsonBtn.addEventListener('click', ()=> {
  if (!currentItems || currentItems.length === 0) return alert('هیچ داده‌ای برای کپی نیست');
  navigator.clipboard.writeText(JSON.stringify(currentItems, null, 2)).then(()=> alert('Copied JSON to clipboard')).catch(()=> alert('کپی ناموفق بود'));
});

// modal controls
closeModalBtn.addEventListener('click', closeModal);
modal.addEventListener('click', (e)=> { if (e.target === modal) closeModal(); });

// wire small inputs
tokensSearch.addEventListener('input', ()=> { /* handled in renderTokensPanel via debounce */ });
tokensSort.addEventListener('change', ()=> { /* handled in renderTokensPanel */ });

autoRefresh.addEventListener('change', ()=> { if (autoRefresh.checked) startAutoRefresh(); else stopAutoRefresh(); });
filterToken.addEventListener('input', ()=> doRefresh());
filterMin.addEventListener('input', ()=> doRefresh());
sortBy.addEventListener('change', ()=> doRefresh());

form.addEventListener('submit', async (e)=> {
  e.preventDefault();
  const addr = (addressInput.value || '').trim();
  if (!addr) { showStatus('لطفاً آدرس را وارد کنید', true); return; }
  currentAddress = addr;
  pageOffset = 0;
  lastSeenBoxIds = new Set();
  await doRefresh(true);
});

// initial
showStatus('آماده — آدرس تست‌نت را وارد کنید و Fetch را بزنید.');
