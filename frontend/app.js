// frontend/app.js
// Mini Ergo Wallet Tracker — frontend logic
// Assumes Chart.js is loaded and backend served on same origin (API_ROOT = '')
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
const tokensChartEl = document.getElementById('tokensChart');

const modal = document.getElementById('modal');
const modalContent = document.getElementById('modal-content');
const closeModalBtn = document.getElementById('close-modal');

// state
let currentAddress = '';
let currentItems = [];       // all fetched UTXOs (client-side pagination)
let pageLimit = 20;
let pageOffset = 0;
let autoRefreshTimer = null;
let lastSeenBoxIds = new Set();
let chart = null;

// helpers
function humanERG(nano) {
  try {
    return (Number(nano) / 1e9).toLocaleString('en-US');
  } catch {
    return nano;
  }
}

function simpleId(id, len = 10) {
  if (!id) return '-';
  return id.slice(0, len) + (id.length > len ? '…' : '');
}

function showStatus(text, isError = false) {
  statusDiv.textContent = text;
  statusDiv.style.color = isError ? '#b91c1c' : '';
}

async function fetchJson(url) {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) {
      const txt = await res.text().catch(()=>'<no body>');
      const msg = `HTTP ${res.status}: ${txt.slice(0,1000)}`;
      const err = new Error(msg);
      err.status = res.status;
      err.body = txt;
      throw err;
    }
    return await res.json();
  } catch (err) {
    console.error('[fetchJson] error for', url, err && (err.stack || err.message || err));
    throw err;
  }
}

// fetch UTXOs from backend (which proxies to explorer)
// NOTE: default limit reduced to 500 to match Explorer limit
async function fetchUTXOs(address, limit = 500, offset = 0) {
  const capped = Math.min(limit || 500, 500);
  const url = `${API_ROOT}/api/wallet/${encodeURIComponent(address)}/utxos?limit=${capped}&offset=${offset}`;
  const j = await fetchJson(url);
  // our backend returns { items: [...] } or similar
  return j.items || [];
}

async function fetchSummary(address) {
  try {
    const j = await fetchJson(`${API_ROOT}/api/summary/${encodeURIComponent(address)}`);
    return j;
  } catch (err) {
    console.warn('Summary fetch failed', err);
    return null;
  }
}

// render
function renderTable(items) {
  tableBody.innerHTML = '';
  items.forEach(it => {
    const tr = document.createElement('tr');

    if (!lastSeenBoxIds.has(it.boxId)) tr.classList.add('highlight-new');

    const tokens = (it.assets || []).map(a => `${simpleId(a.tokenId, 8)}(${a.amount})`).join(', ') || '-';
    const vNano = it.value || 0;
    tr.innerHTML = `
      <td class="p-2 break-all">${simpleId(it.boxId, 40)}</td>
      <td class="p-2">${vNano}</td>
      <td class="p-2 text-xs break-all">${tokens}</td>
      <td class="p-2">${it.creationHeight || '-'}</td>
      <td class="p-2 text-xs break-all">${it.spentTransactionId ? simpleId(it.spentTransactionId, 20) : '-'}</td>
    `;
    tr.addEventListener('click', () => openModal(it));
    tableBody.appendChild(tr);
  });
  showingCount.textContent = items.length;
}

function openModal(item) {
  modalContent.textContent = JSON.stringify(item, null, 2);
  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function closeModal() {
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

// filtering / sorting / pagination
function applyFiltersAndSort(items) {
  const tokenQ = filterToken.value.trim();
  const minQ = Number(filterMin.value) || 0;

  let filtered = items.filter(it => (Number(it.value || 0) >= minQ));

  if (tokenQ) {
    filtered = filtered.filter(it => (it.assets || []).some(a => a.tokenId.includes(tokenQ)));
  }

  const s = sortBy.value;
  if (s === 'value_desc') filtered.sort((a,b)=> (b.value||0)-(a.value||0));
  if (s === 'value_asc') filtered.sort((a,b)=> (a.value||0)-(b.value||0));
  if (s === 'height_desc') filtered.sort((a,b)=> (b.creationHeight||0)-(a.creationHeight||0));
  if (s === 'height_asc') filtered.sort((a,b)=> (a.creationHeight||0)-(b.creationHeight||0));

  return filtered;
}

// main refresh flow
async function doRefresh(full = false) {
  if (!currentAddress) return;
  showStatus('در حال بارگذاری...');
  try {
    // fetch a reasonably large window on server (server may cache)
    const items = await fetchUTXOs(currentAddress, 500, 0);
    currentItems = items || [];

    // update summary (server aggregates tokens + total)
    const summ = await fetchSummary(currentAddress);
    if (summ) {
      summaryAddress.textContent = currentAddress;
      summaryErg.textContent = summ.totalNanoErg ? (Number(summ.totalNanoErg)/1e9).toLocaleString('en-US') : '-';
      summaryTokenCount.textContent = summ.tokenCount ?? '-';
      summaryUtxoCount.textContent = summ.utxoCount ?? currentItems.length;
      renderChart(summ.tokens || []);
    }

    // apply filters & sort, then paginate client-side
    const processed = applyFiltersAndSort(currentItems.slice());
    const pageItems = processed.slice(pageOffset, pageOffset + pageLimit);
    renderTable(pageItems);

    // update seen set for highlight
    currentItems.forEach(it => lastSeenBoxIds.add(it.boxId));

    showStatus(`به‌روزرسانی انجام شد — ${processed.length} مورد (نمایش ${pageItems.length})`);
  } catch (err) {
    console.error(err);
    const msg = err && err.message ? err.message : 'خطا در دریافت داده‌ها';
    showStatus(`خطا در دریافت داده‌ها: ${msg}`, true);
  }
}

// auto refresh control
function startAutoRefresh() {
  stopAutoRefresh();
  const s = Number(refreshIntervalInput.value) || 15;
  autoRefreshTimer = setInterval(() => doRefresh(), Math.max(5000, s*1000));
}
function stopAutoRefresh() {
  if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
}

// pagination
prevPageBtn.addEventListener('click', ()=> {
  pageOffset = Math.max(0, pageOffset - pageLimit);
  doRefresh();
});
nextPageBtn.addEventListener('click', ()=> {
  pageOffset += pageLimit;
  doRefresh();
});

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
  const csv = [header].concat(rows.map(r => Object.values(r).map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n'));
  const blob = new Blob(csv, { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `${currentAddress || 'wallet'}_utxos.csv`; a.click();
  URL.revokeObjectURL(url);
});

// copy JSON
copyJsonBtn.addEventListener('click', ()=> {
  if (!currentItems || currentItems.length === 0) return alert('هیچ داده‌ای برای کپی نیست');
  navigator.clipboard.writeText(JSON.stringify(currentItems, null, 2)).then(()=> alert('Copied JSON to clipboard')).catch(()=> alert('کپی ناموفق بود'));
});

// chart rendering (simple pie for top tokens)
function renderChart(tokens) {
  try {
    if (!tokens || tokens.length === 0) {
      if (chart) { chart.destroy(); chart = null; }
      tokensChartEl.getContext && tokensChartEl.getContext('2d').clearRect(0,0,tokensChartEl.width,tokensChartEl.height);
      return;
    }

    const top = tokens.slice(0, 10);
    const labels = top.map(t => t.tokenId.slice(0,8));
    const data = top.map(t => Number(t.amount));

    if (chart) chart.destroy();
    const ctx = tokensChartEl.getContext('2d');
    chart = new Chart(ctx, {
      type: 'pie',
      data: {
        labels,
        datasets: [{ data }]
      },
      options: { maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
    });
  } catch (err) {
    console.error('Chart render error', err);
  }
}

// modal controls
closeModalBtn.addEventListener('click', closeModal);
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

// wiring initial interactions
autoRefresh.addEventListener('change', ()=> {
  if (autoRefresh.checked) startAutoRefresh(); else stopAutoRefresh();
});
filterToken.addEventListener('input', ()=> doRefresh());
filterMin.addEventListener('input', ()=> doRefresh());
sortBy.addEventListener('change', ()=> doRefresh());

// form submit
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const addr = (addressInput.value || '').trim();
  if (!addr) { showStatus('لطفاً آدرس را وارد کنید', true); return; }
  currentAddress = addr;
  pageOffset = 0;
  lastSeenBoxIds = new Set();
  await doRefresh(true);
});

// initial state
showStatus('آماده — آدرس تست‌نت را وارد کنید و Fetch را بزنید.');
