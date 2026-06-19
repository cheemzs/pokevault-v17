/* ═══════════════════════════════════════════════════════════════════
   POKEVAULT v17 — app.js
   New in v17:
     • Sealed products fully fixed (correct API endpoint + data mapping)
     • Search results filter out cards < $2 USD (low-value noise)
     • Metric cards (P/L Dashboard, Price History, Trade Analyser) now
       fully clickable with teal hover border + "+" indicator
     • Edit button added to portfolio rows (revealed on row click)
     • Sell + Edit buttons hidden by default; shown on row hover/click
     • Actions column removed from table header
     • Responsive layout fixes for mobile and wide desktop
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const SUPABASE_URL      = 'https://jqzwvcjkekvdyimhryha.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Impxend2Y2prZWt2ZHlpbWhyeWhhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1NzU5OTYsImV4cCI6MjA5NjE1MTk5Nn0.waU_KSWUuB0W_0Zu7tizbraAxmSpXyEVnKWCQnruXjs';
const _sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Global State ──────────────────────────────────────────────────
let USD_TO_SGD          = 1.35;
const MIN_PRICE_USD     = 2.00; // Filter out cards below this value in search results
let portfolioItems      = [];
let _currentUserId      = null;
let _userProfile        = null;
let _allowedHistoryDays = 35;
let _portfolioChart     = null;
let _cardDetailChart    = null;

// Search state
let _searchLang         = 'english';
let _searchType         = 'cards';
let _activeView         = 'grid';
let _searchResults      = [];

// Portfolio search state
let _pfSearchLang       = 'english';
let _pfSearchType       = 'cards';
let _pfSearchResults    = [];
let _pfSearchDebounce   = null;

// Portfolio add modal state
let _portfolioAddResult = null;

// Sell modal state
let _sellItemId         = null;

// Trade analyser state
let _tradeMyItems    = [];
let _tradeTheirItems = [];

// ── DB Mappers ────────────────────────────────────────────────────
function dbToPortfolioItem(row) {
  return {
    id:               row.id,
    itemId:           row.item_id,
    type:             row.type,
    name:             row.name,
    set:              row.set_name,
    imageUrl:         row.image_url,
    purchasePrice:    row.purchase_price,
    quantity:         row.quantity     ?? 1,
    conditionOrGrade: row.condition_or_grade ?? 'Near Mint',
    language:         row.language     ?? 'english',
    notes:            row.notes,
    currentValue:     row.current_value,
    lastValueUpdated: row.last_value_updated,
    sold:             row.sold         ?? false,
    soldPrice:        row.sold_price,
    soldDate:         row.sold_date,
    createdAt:        row.created_at,
  };
}

// ── Theme ─────────────────────────────────────────────────────────
(function initTheme() {
  const saved = localStorage.getItem('pv-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
})();

window.addEventListener('scroll', () => {
  document.getElementById('site-header')?.classList.toggle('scrolled', window.scrollY > 20);
});

// ── Exchange Rate ─────────────────────────────────────────────────
async function fetchExchangeRate() {
  try {
    const res = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
    if (!res.ok) return;
    const data = await res.json();
    if (data.rates?.SGD) {
      USD_TO_SGD = data.rates.SGD;
      const el = document.getElementById('fx-rate');
      if (el) el.textContent = 'USD/SGD: ' + USD_TO_SGD.toFixed(4);
    }
  } catch { console.warn('Exchange rate fetch failed — using fallback 1.35'); }
}

// ── History Window ────────────────────────────────────────────────
function computeAllowedHistoryDays(profile) {
  if (!profile) return 35;
  if (profile.is_premium) return 180;
  const created     = new Date(profile.created_at);
  const windowStart = new Date(created);
  windowStart.setDate(windowStart.getDate() - 5);
  const today     = new Date();
  const totalDays = Math.ceil((today - windowStart) / (1000 * 60 * 60 * 24));
  return Math.max(totalDays, 5);
}

function historyWindowLabel(profile) {
  if (!profile) return '—';
  if (profile.is_premium) return '6-month history (Pro)';
  const created     = new Date(profile.created_at);
  const windowStart = new Date(created);
  windowStart.setDate(windowStart.getDate() - 5);
  const dateStr = windowStart.toLocaleDateString('en-SG', { day:'numeric', month:'short', year:'numeric' });
  return `From ${dateStr} → today`;
}

// ── Profile ───────────────────────────────────────────────────────
async function loadProfile() {
  const { data, error } = await _sb
    .from('profiles')
    .select('id, username, created_at, is_premium')
    .eq('id', _currentUserId)
    .single();

  if (error && error.code === 'PGRST116') {
    const { data: { user } } = await _sb.auth.getUser();
    const email = user?.email || '';
    const usernameVal = user?.user_metadata?.username
      || email.replace('@pokevault.app', '').replace(/@.*/, '')
      || 'user_' + _currentUserId.slice(0, 8);
    const { data: inserted, error: insertErr } = await _sb
      .from('profiles')
      .insert([{ id: _currentUserId, username: usernameVal }])
      .select()
      .single();
    if (!insertErr) _userProfile = inserted;
  } else if (!error) {
    _userProfile = data;
  }

  _allowedHistoryDays = computeAllowedHistoryDays(_userProfile);

  const premBadge = document.getElementById('premium-badge');
  if (_userProfile?.is_premium && premBadge) premBadge.style.display = 'inline-flex';

  const histEl = document.getElementById('history-days-display');
  if (histEl) histEl.textContent = historyWindowLabel(_userProfile);
}

// ── Init ──────────────────────────────────────────────────────────
async function init() {
  const { data: { session } } = await _sb.auth.getSession();
  if (!session) { window.location.href = '/login'; return; }
  _currentUserId = session.user.id;
  const usernameEl = document.getElementById('username-display');
  if (usernameEl) {
    const email = session.user.email || '';
    const metaUsername = session.user.user_metadata?.username;
    usernameEl.textContent = metaUsername || email.replace('@pokevault.app', '').replace(/@.*/, '');
  }

  await Promise.all([fetchExchangeRate(), loadProfile()]);
  await loadPortfolioItems();
  setupSearchListeners();
  const isFirstTime = portfolioItems.filter(i => !i.sold).length === 0;
  switchMainTab(isFirstTime ? 'search' : 'portfolio');
  updateSearchTabVisibility();
}

async function logout() {
  await _sb.auth.signOut();
  window.location.href = '/login';
}

// ── Tab Navigation ────────────────────────────────────────────────
function switchMainTab(tab) {
  document.getElementById('tab-search').style.display    = tab === 'search'    ? 'block' : 'none';
  document.getElementById('tab-portfolio').style.display = tab === 'portfolio' ? 'block' : 'none';
  document.getElementById('nav-search').classList.toggle('active',    tab === 'search');
  document.getElementById('nav-portfolio').classList.toggle('active', tab === 'portfolio');
  document.getElementById('nav-search').setAttribute('aria-selected',    tab === 'search');
  document.getElementById('nav-portfolio').setAttribute('aria-selected', tab === 'portfolio');
}

function updateSearchTabVisibility() {
  const hasItems  = portfolioItems.filter(i => !i.sold).length > 0;
  const navSearch = document.getElementById('nav-search');
  if (navSearch) navSearch.style.display = hasItems ? 'none' : '';
  if (hasItems && document.getElementById('tab-search')?.style.display !== 'none') {
    switchMainTab('portfolio');
  }
}

// ── Utility ───────────────────────────────────────────────────────
function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function toast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.classList.add('toast-show'), 10);
  setTimeout(() => { el.classList.remove('toast-show'); setTimeout(() => el.remove(), 300); }, 3500);
}

function confirmDialog(message) {
  return new Promise(resolve => {
    document.getElementById('confirm-message').textContent = message;
    const overlay = document.getElementById('confirm-overlay');
    overlay.classList.add('active');
    const ok     = document.getElementById('confirm-ok');
    const cancel = document.getElementById('confirm-cancel');
    function cleanup(result) {
      overlay.classList.remove('active');
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      resolve(result);
    }
    const onOk     = () => cleanup(true);
    const onCancel = () => cleanup(false);
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
  });
}

function animateValue(el, target, prefix) {
  if (!el) return;
  const start = parseFloat(el.getAttribute('data-val') || '0');
  const duration = 600; const t0 = performance.now();
  const step = now => {
    const p = Math.min((now - t0) / duration, 1);
    const ease = 1 - Math.pow(1 - p, 3);
    el.textContent = prefix + '$' + (start + (target - start) * ease).toFixed(2);
    if (p < 1) requestAnimationFrame(step);
    else { el.textContent = prefix + '$' + target.toFixed(2); el.setAttribute('data-val', target); }
  };
  requestAnimationFrame(step);
}

// ── Price Extraction ──────────────────────────────────────────────
function extractResultPrice(r, isSealed) {
  if (isSealed) {
    // Sealed products use different field names depending on the API response
    return r.unopenedPrice ?? r.marketPrice ?? r.price
        ?? r.prices?.market ?? r.prices?.midPrice ?? r.prices?.lowPrice
        ?? null;
  }
  if (r.prices?.market   != null) return r.prices.market;
  if (r.prices?.lowPrice != null) return r.prices.lowPrice;
  if (r.prices?.midPrice != null) return r.prices.midPrice;
  if (r.japanesePrice    != null) return r.japanesePrice;
  if (r.averagePrice     != null) return r.averagePrice;
  if (r.marketPrice      != null) return r.marketPrice;
  if (r.price            != null) return r.price;
  return null;
}

function extractGradedPrice(apiResult, conditionOrGrade) {
  if (!apiResult || !conditionOrGrade) return null;
  const gradeMatch = conditionOrGrade.match(/^(PSA|BGS|CGC)\s+(.+)$/i);
  if (!gradeMatch) return null;
  const company = gradeMatch[1].toLowerCase();
  const grade   = gradeMatch[2].trim().replace('.', '_');
  const key     = company + grade;
  const salesByGrade = apiResult?.ebay?.salesByGrade;
  if (!salesByGrade || typeof salesByGrade !== 'object') return null;
  const entry = salesByGrade[key];
  if (!entry) return null;
  const price = parseFloat(entry.smartMarketPrice?.price ?? entry.averagePrice ?? entry.medianPrice ?? 0);
  return price > 0 ? price : null;
}

// ── Chart Helpers ─────────────────────────────────────────────────
function destroyChart(chartRef) {
  if (chartRef) { try { chartRef.destroy(); } catch(e) {} }
  return null;
}

function buildChartConfig(labels, values, label, color = '#00e5cc') {
  return buildMultiChartConfig(labels, [{ label, values, color }]);
}

function buildMultiChartConfig(labels, datasets) {
  const PALETTE = ['#00e5cc', '#f5a623', '#e05a5a', '#7b61ff', '#40c8a0', '#ff8c42'];
  return {
    type: 'line',
    data: {
      labels,
      datasets: datasets.map((ds, i) => {
        const color = ds.color || PALETTE[i % PALETTE.length];
        return {
          label:            ds.label,
          data:             ds.values,
          borderColor:      color,
          backgroundColor:  color + '18',
          borderWidth:      2,
          pointRadius:      labels.length > 30 ? 0 : 3,
          pointHoverRadius: 5,
          fill:             datasets.length === 1,
          tension:          0.3,
          spanGaps:         true,
        };
      }),
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: datasets.length > 1,
          labels: { color: '#a8b0d0', font: { family: 'JetBrains Mono', size: 11 }, boxWidth: 12 },
        },
        tooltip: {
          callbacks: {
            label: ctx => {
              const v = ctx.parsed.y;
              return v != null ? ctx.dataset.label + ': SGD $' + Number(v).toFixed(2) : null;
            },
          },
          backgroundColor: '#0e1017',
          borderColor: '#00e5cc',
          borderWidth: 1,
          titleColor: '#f0f2ff',
          bodyColor: '#a8b0d0',
        },
      },
      scales: {
        x: {
          ticks: { color: '#5a6080', font: { family: 'JetBrains Mono', size: 10 }, maxTicksLimit: 8 },
          grid:  { color: 'rgba(255,255,255,0.04)' },
        },
        y: {
          ticks: { color: '#5a6080', font: { family: 'JetBrains Mono', size: 10 }, callback: v => 'SGD $' + Number(v).toFixed(2) },
          grid:  { color: 'rgba(255,255,255,0.04)' },
        },
      },
    },
  };
}

// ══════════════════════════════════════════════════════════════════
//  SEARCH TAB
// ══════════════════════════════════════════════════════════════════

function setupSearchListeners() {
  const input   = document.getElementById('search-input');
  const btn     = document.getElementById('search-btn');
  const setInp  = document.getElementById('set-input');

  btn?.addEventListener('click', doSearch);
  input?.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  setInp?.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

  document.querySelectorAll('.lang-btn:not(.pf-lang-btn)').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.lang-btn:not(.pf-lang-btn)').forEach(x => { x.classList.remove('active'); x.setAttribute('aria-pressed','false'); });
      b.classList.add('active'); b.setAttribute('aria-pressed','true');
      _searchLang = b.dataset.lang;
    });
  });

  document.querySelectorAll('.search-type-btn:not(#pf-type-cards):not(#pf-type-sealed)').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.search-type-btn:not(#pf-type-cards):not(#pf-type-sealed)').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      _searchType = b.dataset.type;
    });
  });

  document.querySelectorAll('.hint-chip, .example-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const q = chip.dataset.query;
      if (!q) return;
      document.getElementById('search-input').value = q;
      if (chip.dataset.lang === 'japanese') {
        _searchLang = 'japanese';
        document.querySelectorAll('.lang-btn:not(.pf-lang-btn)').forEach(b => {
          b.classList.toggle('active', b.dataset.lang === 'japanese');
          b.setAttribute('aria-pressed', b.dataset.lang === 'japanese' ? 'true' : 'false');
        });
      }
      doSearch();
    });
  });

  document.querySelectorAll('.view-btn').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.view-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      _activeView = b.dataset.view;
      const grid = document.getElementById('results-grid');
      if (grid) grid.classList.toggle('list-view', _activeView === 'list');
    });
  });
}

function showSearchState(state) {
  document.getElementById('welcome-state').classList.toggle('hidden', state !== 'welcome');
  document.getElementById('loading').classList.toggle('visible', state === 'loading');
  document.getElementById('empty-state').classList.toggle('visible', state === 'empty');
  document.getElementById('error-state').classList.toggle('visible', state === 'error');
  const grid = document.getElementById('results-grid');
  grid.classList.toggle('hidden', state !== 'results');
  document.getElementById('status-bar').classList.toggle('hidden', state !== 'results');
}

function isCardNumber(q) {
  return /^\d+\/\d+$/.test(q.trim()) || /^\d{3}$/.test(q.trim());
}

async function doSearch() {
  const raw   = (document.getElementById('search-input')?.value || '').trim();
  const set   = (document.getElementById('set-input')?.value || '').trim();
  if (!raw) return;

  showSearchState('loading');

  try {
    let params;
    if (_searchType === 'sealed') {
      params = new URLSearchParams({ action: 'sealed', language: _searchLang });
      params.set('name', raw);
      if (set) params.set('set', set);
    } else if (isCardNumber(raw)) {
      params = new URLSearchParams({ action: 'bynumber', name: raw, language: _searchLang });
      if (set) params.set('set', set);
    } else {
      const q = set ? raw + ' ' + set : raw;
      params = new URLSearchParams({ action: 'search', name: q, language: _searchLang });
    }

    const res  = await fetch('/api/pokeprice?' + params);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    _searchResults = data.results || [];

    if (!_searchResults.length) { showSearchState('empty'); return; }

    renderSearchResults(_searchResults, _searchType === 'sealed');
    showSearchState('results');

    const countEl = document.getElementById('result-count');
    if (countEl) countEl.innerHTML = `<strong>${_searchResults.length}</strong> result${_searchResults.length !== 1 ? 's' : ''}`;
  } catch (e) {
    console.error('doSearch error:', e);
    document.getElementById('error-msg').textContent = e.message || 'Unknown error';
    showSearchState('error');
  }
}

function renderSearchResults(results, isSealed) {
  const grid = document.getElementById('results-grid');
  grid.classList.toggle('list-view', _activeView === 'list');

  // Filter out low-value cards (not sealed products — those can be cheap per unit)
  const filtered = isSealed
    ? results
    : results.filter(r => {
        const p = extractResultPrice(r, false);
        return p == null || p >= MIN_PRICE_USD;
      });

  // Store filtered results back so openSearchResult index matches
  if (!isSealed) _searchResults = filtered;

  grid.innerHTML = filtered.map((r, i) => {
    const thumb    = r.imageCdnUrl400 || r.imageCdnUrl200 || r.imageCdnUrl || '';
    const priceUSD = extractResultPrice(r, isSealed);
    const mktSGD   = priceUSD != null ? 'SGD $' + (priceUSD * USD_TO_SGD).toFixed(2) : null;
    const lowSGD   = r.prices?.lowPrice != null ? 'SGD $' + (r.prices.lowPrice * USD_TO_SGD).toFixed(2) : null;
    const imgEl    = thumb
      ? `<img src="${esc(thumb)}" loading="lazy" alt="${esc(r.name)}" />`
      : `<div class="card-img-placeholder">${isSealed ? '📦' : '🃏'}</div>`;
    const rarity = r.rarity ? `<span class="rarity-badge">${esc(r.rarity)}</span>` : '';
    const number = r.cardNumber ? `<span class="number-badge">#${esc(r.cardNumber)}</span>` : '';
    const jpFlag = _searchLang === 'japanese' ? ' 🇯🇵' : '';

    return `<div class="card" role="listitem" onclick="openSearchResult(${i},${isSealed})">
      <div class="card-img-wrap">${imgEl}${rarity}${number}</div>
      <div class="card-body">
        <div class="card-name">${esc(r.name)}${jpFlag}</div>
        <div class="card-meta">${esc(r.setName||'—')}${r.cardNumber?' · #'+esc(r.cardNumber):''}</div>
        <div class="card-prices">
          <div class="price-row">
            <span class="price-label">Market</span>
            <span class="price-value ${mktSGD?'':'na'}">${mktSGD||'—'}</span>
          </div>
          ${lowSGD ? `<div class="price-row"><span class="price-label">Low</span><span class="price-value">${lowSGD}</span></div>` : ''}
        </div>
        <button class="btn-add-portfolio" onclick="event.stopPropagation();addToPortfolioFromSearch(${i},${isSealed})">+ Portfolio</button>
      </div>
    </div>`;
  }).join('');
}

function openSearchResult(index, isSealed) {
  const r = _searchResults[index];
  if (!r) return;
  const thumb  = r.imageCdnUrl400 || r.imageCdnUrl || r.imageCdnUrl200 || '';
  const priceUSD = extractResultPrice(r, isSealed);
  const mktSGD = priceUSD != null ? 'SGD $' + (priceUSD * USD_TO_SGD).toFixed(2) : '—';
  const lowSGD = r.prices?.lowPrice != null ? 'SGD $' + (r.prices.lowPrice * USD_TO_SGD).toFixed(2) : '—';
  const midSGD = r.prices?.midPrice != null ? 'SGD $' + (r.prices.midPrice * USD_TO_SGD).toFixed(2) : '—';
  const hiSGD  = r.prices?.highPrice != null ? 'SGD $' + (r.prices.highPrice * USD_TO_SGD).toFixed(2) : '—';
  const jpFlag = _searchLang === 'japanese' ? ' 🇯🇵' : '';

  document.getElementById('modal-content').innerHTML = `
    <div class="modal-body">
      <div class="modal-img-wrap">
        ${thumb ? `<img src="${esc(thumb)}" alt="${esc(r.name)}" />` : `<div class="modal-img-placeholder">${isSealed ? '📦' : '🃏'}</div>`}
      </div>
      <div class="modal-info">
        <div class="modal-card-name">${esc(r.name)}${jpFlag}</div>
        <div class="modal-card-set">${esc(r.setName||'—')}${r.cardNumber?' · #'+esc(r.cardNumber):''}${r.rarity?' · '+esc(r.rarity):''}</div>
        <div class="modal-tags">
          ${isSealed ? '<span class="modal-tag accent">📦 Sealed</span>' : ''}
          ${r.pokemonType ? `<span class="modal-tag">${esc(r.pokemonType)}</span>` : ''}
        </div>
        <div class="modal-section-title">Prices (SGD)</div>
        <div class="price-table-wrap" style="margin-bottom:20px;">
          <table class="price-table">
            <thead><tr><th>Type</th><th>Price</th></tr></thead>
            <tbody>
              <tr><td class="label-cell">Market</td><td class="price-cell">${mktSGD}</td></tr>
              ${!isSealed ? `
              <tr><td class="label-cell">Low</td><td class="price-cell">${lowSGD}</td></tr>
              <tr><td class="label-cell">Mid</td><td class="price-cell">${midSGD}</td></tr>
              <tr><td class="label-cell">High</td><td class="price-cell">${hiSGD}</td></tr>` : ''}
            </tbody>
          </table>
        </div>
        <button class="btn-search" style="width:100%;" onclick="_destroyModal();addToPortfolioFromSearch(${index},${isSealed})">
          + Add to Portfolio
        </button>
      </div>
    </div>`;

  document.getElementById('modal-overlay').classList.add('active');
}

function closeModal(e) {
  if (e && e.target !== document.getElementById('modal-overlay')) return;
  _destroyModal();
}

function _destroyModal() {
  document.getElementById('modal-overlay').classList.remove('active');
}

function addToPortfolioFromSearch(index, isSealed) {
  const r = _searchResults[index];
  if (!r) return;
  openPortfolioAddModal(r, isSealed);
}

// ══════════════════════════════════════════════════════════════════
//  CARD DETAIL MODAL — Grade-aware chart
// ══════════════════════════════════════════════════════════════════

let _cdApiResult   = null;
let _cdItem        = null;
let _cdActiveGrades = new Set();
let _cdRawHistory   = [];

const GRADE_META = {
  raw:    { label: 'Raw',      color: '#00e5cc' },
  psa10:  { label: 'PSA 10',  color: '#f5a623' },
  psa9:   { label: 'PSA 9',   color: '#e8c33a' },
  psa8:   { label: 'PSA 8',   color: '#a8b0d0' },
  bgs10:  { label: 'BGS 10',  color: '#7b61ff' },
  bgs9_5: { label: 'BGS 9.5', color: '#b08eff' },
  bgs9:   { label: 'BGS 9',   color: '#8070cc' },
  cgc10:  { label: 'CGC 10',  color: '#40c8a0' },
  cgc9_5: { label: 'CGC 9.5', color: '#5adba8' },
  cgc9:   { label: 'CGC 9',   color: '#35a882' },
};

function gradeKey(conditionOrGrade) {
  if (!conditionOrGrade) return 'raw';
  const m = conditionOrGrade.match(/^(PSA|BGS|CGC)\s+(.+)$/i);
  if (!m) return 'raw';
  const company = m[1].toLowerCase();
  const grade   = m[2].trim().replace('.', '_');
  return company + grade;
}

async function openCardDetailModal(itemId) {
  const item = portfolioItems.find(i => i.id === itemId);
  if (!item) return;

  _cdItem         = item;
  _cdApiResult    = null;
  _cdActiveGrades = new Set();

  const overlay = document.getElementById('card-detail-overlay');
  const content = document.getElementById('card-detail-content');

  const thumb     = item.imageUrl || '';
  const cost      = Number(item.purchasePrice) * (item.quantity || 1);
  const val       = item.currentValue != null ? Number(item.currentValue) * (item.quantity || 1) : null;
  const profit    = val != null ? val - cost : null;
  const profitStr = profit != null ? (profit >= 0 ? '↑ +' : '↓ ') + 'SGD $' + Math.abs(profit).toFixed(2) : '—';
  const profitClass = profit == null ? '' : (profit >= 0 ? 'profit-pos' : 'profit-neg');
  const langFlag  = item.language === 'japanese' ? ' 🇯🇵' : '';
  const typeEmoji = item.type === 'sealed' ? '📦' : '🃏';

  content.innerHTML = `
    <div style="padding:24px 28px 0;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
      <div>
        <div style="font-family:var(--font-display);font-size:16px;font-weight:700;color:var(--text);">${typeEmoji} ${esc(item.name)}${langFlag}</div>
        <div style="font-size:12px;color:var(--text3);margin-top:3px;">${esc(item.set||'—')} · ${esc(item.conditionOrGrade)} · ×${item.quantity||1}</div>
      </div>
      <div class="${profitClass}" style="font-family:var(--font-mono);font-size:13px;font-weight:700;">${profitStr}</div>
    </div>

    <div style="padding:14px 28px 4px;display:flex;gap:10px;border-bottom:1px solid var(--border);">
      <button class="pl-tab-btn active" id="cd-tab-chart" onclick="switchCardDetailTab('chart')" style="padding:6px 14px;font-size:12px;">📈 Price Chart</button>
      <button class="pl-tab-btn" id="cd-tab-image" onclick="switchCardDetailTab('image')" style="padding:6px 14px;font-size:12px;">${typeEmoji} ${item.type === 'sealed' ? 'Product Image' : 'Card Image'}</button>
    </div>

    <div id="cd-pane-chart" style="padding:16px 28px 28px;">
      <div id="cd-grade-row" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px;min-height:28px;align-items:center;">
        <span style="font-size:11px;color:var(--text3);">Loading…</span>
      </div>
      <div id="cd-chart-loading" style="text-align:center;padding:30px;color:var(--text3);">
        <div class="spinner"></div>
        <div style="margin-top:10px;font-size:12px;">Fetching price data…</div>
      </div>
      <canvas id="cd-chart-canvas" style="display:none;max-height:340px;"></canvas>
      <div id="cd-chart-empty" style="display:none;text-align:center;padding:40px;color:var(--text3);">
        No price history data available yet.<br><span style="font-size:12px;">Data accumulates as you refresh your portfolio values.</span>
      </div>
    </div>

    <div id="cd-pane-image" style="display:none;padding:20px 28px 28px;text-align:center;">
      ${thumb
        ? `<img src="${esc(thumb)}" alt="${esc(item.name)}" style="max-width:220px;max-height:320px;object-fit:contain;border-radius:8px;" />`
        : `<div style="padding:40px;color:var(--text3);font-size:32px;">${typeEmoji}</div>`}
    </div>`;

  overlay.classList.add('active');
  loadCardDetailChart(item);
}

function switchCardDetailTab(tab) {
  document.getElementById('cd-pane-chart').style.display = tab === 'chart' ? 'block' : 'none';
  document.getElementById('cd-pane-image').style.display = tab === 'image' ? 'block' : 'none';
  document.getElementById('cd-tab-chart')?.classList.toggle('active', tab === 'chart');
  document.getElementById('cd-tab-image')?.classList.toggle('active', tab === 'image');
}

function gradeHistory(salesByGrade, key) {
  const entry = salesByGrade?.[key];
  if (!entry) return [];
  const raw = entry.history || entry.priceHistory || [];
  if (raw.length) {
    return raw
      .map(h => ({ date: (h.date||'').split('T')[0], priceSGD: Math.round(Number(h.price ?? h.value ?? 0) * USD_TO_SGD * 100) / 100 }))
      .filter(h => h.date && h.priceSGD > 0)
      .sort((a, b) => a.date.localeCompare(b.date));
  }
  const price = parseFloat(entry.smartMarketPrice?.price ?? entry.averagePrice ?? entry.medianPrice ?? 0);
  if (price > 0) {
    const today = new Date().toISOString().split('T')[0];
    return [{ date: today, priceSGD: Math.round(price * USD_TO_SGD * 100) / 100 }];
  }
  return [];
}

async function loadCardDetailChart(item) {
  const loadingEl  = document.getElementById('cd-chart-loading');
  const canvasEl   = document.getElementById('cd-chart-canvas');
  const emptyEl    = document.getElementById('cd-chart-empty');
  const gradeRowEl = document.getElementById('cd-grade-row');

  _cardDetailChart = destroyChart(_cardDetailChart);

  try {
    const lang     = item.language || 'english';
    const isSealed = item.type === 'sealed';
    let params;

    if (isSealed) {
      params = new URLSearchParams({ action: 'sealed', language: lang, includeHistory: 'true', days: String(_allowedHistoryDays) });
      params.set('name', item.name);
    } else {
      params = new URLSearchParams({ action: 'search', name: item.name, language: lang, includeHistory: 'true', days: String(_allowedHistoryDays) });
      if (item.set) params.set('set', item.set);
    }

    const res  = await fetch('/api/pokeprice?' + params);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data    = await res.json();
    const results = data.results || [];

    if (!results.length) { showCardDetailEmpty(loadingEl, canvasEl, emptyEl, gradeRowEl); return; }

    const r = results[0];
    _cdApiResult = r;

    const rawHistArr = (r.priceHistory || r.history || [])
      .map(h => ({ date: (h.date||'').split('T')[0], priceSGD: Math.round(Number(h.price ?? h.value ?? 0) * USD_TO_SGD * 100) / 100 }))
      .filter(h => h.date && h.priceSGD > 0)
      .sort((a, b) => a.date.localeCompare(b.date));

    if (!rawHistArr.length) {
      const priceUSD = extractResultPrice(r, isSealed);
      if (priceUSD != null) {
        rawHistArr.push({ date: new Date().toISOString().split('T')[0], priceSGD: Math.round(priceUSD * USD_TO_SGD * 100) / 100 });
      }
    }

    const salesByGrade = r?.ebay?.salesByGrade || {};
    const availableGradeKeys = Object.keys(salesByGrade).filter(k => gradeHistory(salesByGrade, k).length > 0);

    const myGradeKey = gradeKey(item.conditionOrGrade);
    _cdActiveGrades = new Set();

    if (myGradeKey === 'raw' || isSealed) {
      _cdActiveGrades.add('raw');
    } else if (availableGradeKeys.includes(myGradeKey)) {
      _cdActiveGrades.add(myGradeKey);
    } else {
      _cdActiveGrades.add('raw');
    }

    if (gradeRowEl) {
      const chips = [];
      if (rawHistArr.length) chips.push({ key: 'raw', label: GRADE_META['raw'].label, color: GRADE_META['raw'].color });
      for (const k of availableGradeKeys) {
        const meta = GRADE_META[k] || { label: k.toUpperCase().replace('_', '.'), color: '#a8b0d0' };
        chips.push({ key: k, label: meta.label, color: meta.color });
      }

      if (chips.length <= 1) {
        gradeRowEl.style.display = 'none';
      } else {
        const compareLabel = chips.length > 2 ? 'Compare all' : `Compare ${chips.filter(c=>c.key!==chips[0].key).map(c=>c.label).join(' & ')}`;
        gradeRowEl.innerHTML = chips.map(c => {
          const isActive = _cdActiveGrades.has(c.key);
          return `<button
            id="cd-chip-${c.key}"
            class="cd-grade-chip${isActive ? ' active' : ''}"
            onclick="toggleGradeChip('${c.key}')"
            style="--chip-color:${c.color};"
            title="Toggle ${c.label} price">
            ${esc(c.label)}
          </button>`;
        }).join('') + `
          <button class="cd-grade-chip cd-chip-compare" onclick="compareAllGrades()" title="Compare all grades on one chart" style="margin-left:auto;">
            ⊞ ${esc(compareLabel)}
          </button>`;
      }
    }

    drawCardDetailChart(rawHistArr, salesByGrade);

  } catch (e) {
    console.warn('loadCardDetailChart error:', e);
    showCardDetailEmpty(
      document.getElementById('cd-chart-loading'),
      document.getElementById('cd-chart-canvas'),
      document.getElementById('cd-chart-empty'),
      document.getElementById('cd-grade-row')
    );
  }
}

function toggleGradeChip(key) {
  if (_cdActiveGrades.has(key)) {
    if (_cdActiveGrades.size <= 1) return;
    _cdActiveGrades.delete(key);
  } else {
    _cdActiveGrades.add(key);
  }
  document.querySelectorAll('.cd-grade-chip:not(.cd-chip-compare)').forEach(btn => {
    const k = btn.id.replace('cd-chip-', '');
    btn.classList.toggle('active', _cdActiveGrades.has(k));
  });
  const salesByGrade = _cdApiResult?.ebay?.salesByGrade || {};
  drawCardDetailChart(_cdRawHistory || [], salesByGrade);
}

function compareAllGrades() {
  const allChips = [...document.querySelectorAll('.cd-grade-chip:not(.cd-chip-compare)')];
  allChips.forEach(btn => {
    const k = btn.id.replace('cd-chip-', '');
    _cdActiveGrades.add(k);
    btn.classList.add('active');
  });
  const salesByGrade = _cdApiResult?.ebay?.salesByGrade || {};
  drawCardDetailChart(_cdRawHistory || [], salesByGrade);
}

function drawCardDetailChart(rawHistArr, salesByGrade) {
  _cdRawHistory = rawHistArr;

  const canvasEl  = document.getElementById('cd-chart-canvas');
  const loadingEl = document.getElementById('cd-chart-loading');
  const emptyEl   = document.getElementById('cd-chart-empty');

  _cardDetailChart = destroyChart(_cardDetailChart);

  const dateSet = new Set();
  if (_cdActiveGrades.has('raw')) rawHistArr.forEach(h => dateSet.add(h.date));
  for (const k of _cdActiveGrades) {
    if (k === 'raw') continue;
    gradeHistory(salesByGrade, k).forEach(h => dateSet.add(h.date));
  }

  const allDates = [...dateSet].sort();
  if (!allDates.length) { showCardDetailEmpty(loadingEl, canvasEl, emptyEl, null); return; }

  const datasets = [];
  const PALETTE  = ['#00e5cc', '#f5a623', '#e05a5a', '#7b61ff', '#40c8a0', '#ff8c42'];
  let colorIdx   = 0;

  for (const k of [..._cdActiveGrades].sort()) {
    const meta  = GRADE_META[k] || { label: k.toUpperCase().replace('_', '.'), color: PALETTE[colorIdx % PALETTE.length] };
    const color = meta.color || PALETTE[colorIdx % PALETTE.length];
    colorIdx++;

    let histMap;
    if (k === 'raw') {
      histMap = Object.fromEntries(rawHistArr.map(h => [h.date, h.priceSGD]));
    } else {
      const hist = gradeHistory(salesByGrade, k);
      histMap = Object.fromEntries(hist.map(h => [h.date, h.priceSGD]));
    }

    const values = allDates.map(d => histMap[d] ?? null);
    datasets.push({ label: meta.label, values, color });
  }

  if (!datasets.length) { showCardDetailEmpty(loadingEl, canvasEl, emptyEl, null); return; }

  if (loadingEl) loadingEl.style.display = 'none';
  if (emptyEl)   emptyEl.style.display   = 'none';
  canvasEl.style.display = 'block';

  _cardDetailChart = new Chart(canvasEl, buildMultiChartConfig(allDates, datasets));
}

function showCardDetailEmpty(loadingEl, canvasEl, emptyEl, gradeRowEl) {
  if (loadingEl) loadingEl.style.display = 'none';
  if (canvasEl)  canvasEl.style.display  = 'none';
  if (emptyEl)   emptyEl.style.display   = 'block';
  if (gradeRowEl) gradeRowEl.innerHTML   = '';
}

function closeCardDetailModal(e) {
  if (e && e.target !== document.getElementById('card-detail-overlay')) return;
  document.getElementById('card-detail-overlay').classList.remove('active');
  _cardDetailChart = destroyChart(_cardDetailChart);
}

// ══════════════════════════════════════════════════════════════════
//  PORTFOLIO CHART MODAL
// ══════════════════════════════════════════════════════════════════

async function openPortfolioChartModal() {
  const overlay = document.getElementById('portfolio-chart-overlay');
  const loading = document.getElementById('portfolio-chart-loading');
  const canvas  = document.getElementById('portfolio-chart-canvas');
  const errEl   = document.getElementById('portfolio-chart-error');

  loading.style.display = 'flex';
  canvas.style.display  = 'none';
  errEl.style.display   = 'none';
  overlay.classList.add('active');

  _portfolioChart = destroyChart(_portfolioChart);

  const active = portfolioItems.filter(i => !i.sold);
  if (!active.length) {
    loading.style.display = 'none';
    errEl.style.display   = 'block';
    errEl.textContent     = 'No portfolio items to chart.';
    return;
  }

  try {
    const dateMap = {};

    for (const item of active) {
      const lang     = item.language || 'english';
      const isSealed = item.type === 'sealed';
      let params;

      if (isSealed) {
        params = new URLSearchParams({ action: 'sealed', language: lang, includeHistory: 'true', days: String(_allowedHistoryDays) });
        params.set('name', item.name);
      } else {
        params = new URLSearchParams({ action: 'search', name: item.name, language: lang, includeHistory: 'true', days: String(_allowedHistoryDays) });
        if (item.set) params.set('set', item.set);
      }

      try {
        const res = await fetch('/api/pokeprice?' + params);
        if (!res.ok) continue;
        const d = await res.json();
        const results = d.results || [];
        if (!results.length) continue;

        const r = results[0];
        const history = r.priceHistory || r.history || [];

        if (history.length > 0) {
          for (const h of history) {
            const priceSGD = Math.round(Number(h.price ?? h.value ?? 0) * USD_TO_SGD * 100) / 100;
            dateMap[h.date] = (dateMap[h.date] || 0) + priceSGD * (item.quantity || 1);
          }
        } else {
          const priceUSD = extractResultPrice(r, isSealed);
          const today = new Date().toISOString().split('T')[0];
          if (priceUSD != null) {
            const total = Math.round(priceUSD * USD_TO_SGD * (item.quantity || 1) * 100) / 100;
            dateMap[today] = (dateMap[today] || 0) + total;
          }
        }
      } catch {}
      await new Promise(r => setTimeout(r, 300));
    }

    const dates = Object.keys(dateMap).sort();
    if (dates.length === 0) { loading.style.display = 'none'; errEl.style.display = 'block'; return; }

    renderPortfolioChart(canvas, loading, dates.map(d => ({ date: d, value: dateMap[d] })));
  } catch (e) {
    loading.style.display = 'none';
    errEl.style.display   = 'block';
  }
}

function renderPortfolioChart(canvas, loading, points) {
  loading.style.display = 'none';
  canvas.style.display  = 'block';
  _portfolioChart = new Chart(canvas, buildChartConfig(
    points.map(p => p.date),
    points.map(p => p.value),
    'Portfolio Value (SGD)'
  ));
}

function closePortfolioChartModal(e) {
  if (e && e.target !== document.getElementById('portfolio-chart-overlay')) return;
  document.getElementById('portfolio-chart-overlay').classList.remove('active');
  _portfolioChart = destroyChart(_portfolioChart);
}

// ══════════════════════════════════════════════════════════════════
//  PORTFOLIO SEARCH (add-card panel)
// ══════════════════════════════════════════════════════════════════

function pfSetSearchLang(lang) {
  _pfSearchLang = lang;
  document.querySelectorAll('.pf-lang-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.lang === lang);
  });
}

function pfSetSearchType(type) {
  _pfSearchType = type;
  document.getElementById('pf-type-cards').classList.toggle('active', type === 'cards');
  document.getElementById('pf-type-sealed').classList.toggle('active', type === 'sealed');
}

function pfSearchDebounce() {
  clearTimeout(_pfSearchDebounce);
  _pfSearchDebounce = setTimeout(pfSearch, 380);
}

async function pfSearch() {
  const raw    = (document.getElementById('pf-search-input')?.value || '').trim();
  const set    = (document.getElementById('pf-set-input')?.value || '').trim();
  const box    = document.getElementById('pf-search-results');
  const isSealed = _pfSearchType === 'sealed';
  if (!raw || raw.length < 2) { if (box) { box.style.display = 'none'; box.innerHTML = ''; } return; }

  try {
    let params;
    if (isSealed) {
      params = new URLSearchParams({ action: 'sealed', language: _pfSearchLang });
      params.set('name', raw);
      if (set) params.set('set', set);
    } else if (isCardNumber(raw)) {
      params = new URLSearchParams({ action: 'bynumber', name: raw, language: _pfSearchLang });
      if (set) params.set('set', set);
    } else {
      const q = set ? raw + ' ' + set : raw;
      params = new URLSearchParams({ action: 'search', name: q, language: _pfSearchLang });
    }

    const res  = await fetch('/api/pokeprice?' + params);
    if (!res.ok) return;
    const data = await res.json();
    let pfResults = data.results || [];
    // Filter out low-value cards (not sealed products)
    if (!isSealed) {
      pfResults = pfResults.filter(r => {
        const p = extractResultPrice(r, false);
        return p == null || p >= MIN_PRICE_USD;
      });
    }
    _pfSearchResults = pfResults;
    renderPFSearchResults(_pfSearchResults, isSealed);
  } catch (e) { console.warn('pfSearch error:', e); }
}

function renderPFSearchResults(results, isSealed) {
  const box = document.getElementById('pf-search-results');
  if (!box) return;
  if (!results.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.style.display = 'block';
  box.innerHTML = results.slice(0, 20).map((r, i) => {
    const thumb    = r.imageCdnUrl200 || r.imageCdnUrl400 || r.imageCdnUrl || '';
    const priceUSD = extractResultPrice(r, isSealed);
    const priceTxt = priceUSD != null ? `SGD $${(priceUSD * USD_TO_SGD).toFixed(2)}` : '';
    const imgEl = thumb
      ? `<img src="${esc(thumb)}" style="width:34px;height:48px;object-fit:contain;border-radius:3px;flex-shrink:0;" />`
      : `<span style="width:34px;height:48px;display:flex;align-items:center;justify-content:center;font-size:20px;">${isSealed?'📦':'🃏'}</span>`;
    const sub = isSealed
      ? esc(r.setName||'—')
      : `${esc(r.setName||'—')}${r.cardNumber?' · #'+esc(r.cardNumber):''}${r.rarity?' · '+esc(r.rarity):''}`;
    return `<div class="pf-result-row" onclick="pfPickResult(${i},${isSealed})">
      ${imgEl}
      <div class="pf-result-info">
        <div class="pf-result-name">${esc(r.name)}</div>
        <div class="pf-result-sub">${sub}</div>
      </div>
      <div class="pf-result-right">
        <span class="pf-result-price">${esc(priceTxt)}</span>
        <button class="btn-add-portfolio" onclick="event.stopPropagation();pfPickResult(${i},${isSealed})">+ Portfolio</button>
      </div>
    </div>`;
  }).join('');
}

function pfPickResult(index, isSealed) {
  const r = _pfSearchResults[index];
  if (!r) return;
  const box = document.getElementById('pf-search-results');
  if (box) { box.style.display = 'none'; box.innerHTML = ''; }
  document.getElementById('pf-search-input').value = '';
  const setInp = document.getElementById('pf-set-input');
  if (setInp) setInp.value = '';
  openPortfolioAddModal(r, isSealed);
}

// ══════════════════════════════════════════════════════════════════
//  PORTFOLIO ADD MODAL
// ══════════════════════════════════════════════════════════════════

function openPortfolioAddModal(apiResult, isSealed) {
  if (!apiResult) return;
  _portfolioAddResult = { result: apiResult, isSealed };

  const priceUSD = extractResultPrice(apiResult, isSealed);
  const priceSGD = priceUSD != null ? (priceUSD * USD_TO_SGD).toFixed(2) : '';

  document.getElementById('pf-item-name').textContent  = apiResult.name || '—';
  document.getElementById('pf-item-set').textContent   = apiResult.setName || '—';
  document.getElementById('pf-item-type').textContent  = isSealed ? '📦 Sealed Product' : '🃏 Card';

  const imgEl = document.getElementById('pf-item-img');
  const thumb = apiResult.imageCdnUrl200 || apiResult.imageCdnUrl400 || apiResult.imageCdnUrl || '';
  if (imgEl) { imgEl.src = thumb; imgEl.style.display = thumb ? 'block' : 'none'; }

  document.getElementById('pf-purchase-price').value = priceSGD;
  document.getElementById('pf-quantity').value       = '1';
  document.getElementById('pf-notes').value          = '';

  const gradeEl = document.getElementById('pf-condition');
  if (gradeEl) {
    gradeEl.innerHTML = isSealed
      ? `<option value="Sealed">Sealed / Unopened</option><option value="Opened">Opened</option>`
      : `<option value="Near Mint">Near Mint</option>
         <option value="Lightly Played">Lightly Played</option>
         <option value="Moderately Played">Moderately Played</option>
         <option value="Heavily Played">Heavily Played</option>
         <option value="Damaged">Damaged</option>
         <option value="PSA 10">PSA 10</option>
         <option value="PSA 9">PSA 9</option>
         <option value="PSA 8">PSA 8</option>
         <option value="BGS 10">BGS 10</option>
         <option value="BGS 9.5">BGS 9.5</option>`;
  }

  document.getElementById('portfolio-add-overlay').classList.add('active');
  setTimeout(() => document.getElementById('pf-purchase-price')?.focus(), 100);
}

function closePortfolioAddModal() {
  document.getElementById('portfolio-add-overlay').classList.remove('active');
  _portfolioAddResult = null;
  // Reset heading + button in case it was in edit mode
  const heading = document.querySelector('#portfolio-add-overlay h2');
  const saveBtn = document.querySelector('#portfolio-add-overlay .btn-search');
  if (heading) heading.textContent = 'Add to Portfolio';
  if (saveBtn) { saveBtn.textContent = 'Add to Portfolio'; saveBtn.onclick = savePortfolioItem; }
}

async function savePortfolioItem() {
  const { result: r, isSealed } = _portfolioAddResult || {};
  if (!r) return;

  const purchasePrice    = parseFloat(document.getElementById('pf-purchase-price').value);
  const quantity         = parseInt(document.getElementById('pf-quantity').value, 10) || 1;
  const conditionOrGrade = document.getElementById('pf-condition').value;
  const notes            = document.getElementById('pf-notes').value.trim();

  if (!purchasePrice || purchasePrice <= 0) { toast('Please enter a valid purchase price.', 'error'); return; }

  const imgUrl = r.imageCdnUrl || r.imageCdnUrl400 || r.imageCdnUrl200 || null;
  const itemId = String(r.tcgPlayerId || r.id || r.productId || crypto.randomUUID());

  let currentValueSGD = null;
  const isGraded = !isSealed && /^(PSA|BGS|CGC)\s+/i.test(conditionOrGrade);

  if (isGraded) {
    const gradedUSD = extractGradedPrice(r, conditionOrGrade);
    if (gradedUSD != null) currentValueSGD = Math.round(gradedUSD * USD_TO_SGD * 100) / 100;

    if (currentValueSGD == null) {
      try {
        const params = new URLSearchParams({ action: 'search', name: r.name, language: _pfSearchLang, includeEbay: 'true' });
        if (r.setName) params.set('set', r.setName);
        if (r.tcgPlayerId) params.set('tcgPlayerId', String(r.tcgPlayerId));
        const res  = await fetch('/api/pokeprice?' + params);
        const data = await res.json();
        const liveResult = (data.results || [])[0];
        if (liveResult) {
          const gradedUSD2 = extractGradedPrice(liveResult, conditionOrGrade);
          if (gradedUSD2 != null) currentValueSGD = Math.round(gradedUSD2 * USD_TO_SGD * 100) / 100;
        }
      } catch (e) { console.warn('Graded price live fetch failed:', e); }
    }
  }

  if (currentValueSGD == null) {
    const priceUSD = extractResultPrice(r, isSealed);
    currentValueSGD = priceUSD != null ? Math.round(priceUSD * USD_TO_SGD * 100) / 100 : null;
  }

  const row = {
    user_id:            _currentUserId,
    item_id:            itemId,
    type:               isSealed ? 'sealed' : 'card',
    name:               r.name || '—',
    set_name:           r.setName || null,
    image_url:          imgUrl,
    purchase_price:     purchasePrice,
    quantity,
    condition_or_grade: conditionOrGrade,
    language:           _pfSearchLang,
    notes:              notes || null,
    current_value:      currentValueSGD,
    last_value_updated: currentValueSGD ? new Date().toISOString() : null,
  };

  const { data, error } = await _sb.from('portfolio_items').insert([row]).select().single();
  if (error) { toast('Failed to save: ' + error.message, 'error'); return; }

  portfolioItems.push(dbToPortfolioItem(data));
  closePortfolioAddModal();
  renderPortfolio();
  updateSearchTabVisibility();
  toast(`${r.name} added to portfolio.`, 'success');
  switchMainTab('portfolio');
}

// ══════════════════════════════════════════════════════════════════
//  MARK AS SOLD — Modal
// ══════════════════════════════════════════════════════════════════

function openSellModal(itemId) {
  const item = portfolioItems.find(i => i.id === itemId);
  if (!item) return;
  _sellItemId = itemId;

  const nameEl   = document.getElementById('sell-item-name');
  const metaEl   = document.getElementById('sell-item-meta');
  const costEl   = document.getElementById('sell-cost-hint');
  const imgEl    = document.getElementById('sell-item-img');
  const iconEl   = document.getElementById('sell-item-icon');
  const priceInp = document.getElementById('sell-price');
  const dateInp  = document.getElementById('sell-date');

  if (nameEl) nameEl.textContent = item.name;
  if (metaEl) metaEl.textContent = `${item.set || '—'} · ${item.conditionOrGrade} · ×${item.quantity||1}`;

  const totalCost = Number(item.purchasePrice) * (item.quantity || 1);
  if (costEl) costEl.textContent = `Cost basis: SGD $${totalCost.toFixed(2)}`;

  if (imgEl && item.imageUrl) {
    imgEl.src = item.imageUrl;
    imgEl.style.display = 'block';
    if (iconEl) iconEl.style.display = 'none';
  } else {
    if (imgEl) imgEl.style.display = 'none';
    if (iconEl) { iconEl.textContent = item.type === 'sealed' ? '📦' : '🃏'; iconEl.style.display = 'inline'; }
  }

  if (priceInp) {
    const val = item.currentValue != null ? Number(item.currentValue) * (item.quantity || 1) : totalCost;
    priceInp.value = val.toFixed(2);
  }
  if (dateInp) dateInp.value = new Date().toISOString().split('T')[0];

  document.getElementById('sell-overlay').classList.add('active');
  setTimeout(() => priceInp?.focus(), 100);
}

function closeSellModal() {
  document.getElementById('sell-overlay').classList.remove('active');
  _sellItemId = null;
}

async function confirmSellItem() {
  if (!_sellItemId) return;

  const soldPriceVal = parseFloat(document.getElementById('sell-price').value);
  const soldDateVal  = document.getElementById('sell-date').value;

  if (!soldPriceVal || soldPriceVal < 0) { toast('Please enter a valid sold price.', 'error'); return; }
  if (!soldDateVal) { toast('Please enter the date sold.', 'error'); return; }

  const item = portfolioItems.find(i => i.id === _sellItemId);
  if (!item) { closeSellModal(); return; }

  const { error } = await _sb
    .from('portfolio_items')
    .update({ sold: true, sold_price: soldPriceVal, sold_date: soldDateVal })
    .eq('id', _sellItemId)
    .eq('user_id', _currentUserId);

  if (error) { toast('Failed to mark as sold: ' + error.message, 'error'); return; }

  const idx = portfolioItems.findIndex(i => i.id === _sellItemId);
  if (idx > -1) {
    portfolioItems[idx] = { ...portfolioItems[idx], sold: true, soldPrice: soldPriceVal, soldDate: soldDateVal };
  }

  closeSellModal();
  renderPortfolio();
  updateSearchTabVisibility();

  const cost = Number(item.purchasePrice) * (item.quantity || 1);
  const pl   = soldPriceVal - cost;
  const plStr = (pl >= 0 ? '+' : '') + 'SGD $' + pl.toFixed(2);
  toast(`${item.name} marked as sold. P/L: ${plStr}`, pl >= 0 ? 'success' : 'info');
}

// ══════════════════════════════════════════════════════════════════
//  P/L DASHBOARD — Two-tab overlay
//  Tab 1: Current — Top Movers by % (current portfolio)
//  Tab 2: Sold    — Full scrollable table of all sold items
// ══════════════════════════════════════════════════════════════════

function openPLDashboard() {
  renderPLDashboard();
  document.getElementById('pl-overlay').classList.add('active');
}

function closePLDashboard(e) {
  if (e && e.target !== document.getElementById('pl-overlay')) return;
  document.getElementById('pl-overlay').classList.remove('active');
}

function switchPLTab(tab) {
  document.getElementById('pl-panel-current').classList.toggle('active', tab === 'current');
  document.getElementById('pl-panel-history').classList.toggle('active', tab === 'history');
  document.getElementById('pl-nav-current').classList.toggle('active', tab === 'current');
  document.getElementById('pl-nav-history').classList.toggle('active', tab === 'history');
  document.getElementById('pl-nav-current').setAttribute('aria-selected', tab === 'current');
  document.getElementById('pl-nav-history').setAttribute('aria-selected', tab === 'history');
}

function renderPLDashboard() {
  const active = portfolioItems.filter(i => !i.sold);
  const sold   = portfolioItems.filter(i => i.sold);

  // ── Tab 1: Top Movers (by % ROI) ─────────────────────────────
  const activeCost  = active.reduce((s, i) => s + Number(i.purchasePrice) * (i.quantity||1), 0);
  const activeValue = active.reduce((s, i) => {
    const v = i.currentValue != null ? Number(i.currentValue) : Number(i.purchasePrice);
    return s + v * (i.quantity||1);
  }, 0);
  const activePL = activeValue - activeCost;

  const currentTotalEl = document.getElementById('pl-current-total');
  const currentCostEl  = document.getElementById('pl-current-cost');
  const currentValueEl = document.getElementById('pl-current-value');
  if (currentTotalEl) {
    currentTotalEl.textContent = (activePL >= 0 ? '↑ +' : '↓ ') + 'SGD $' + Math.abs(activePL).toFixed(2);
    currentTotalEl.className   = 'pl-lifetime-val ' + (activePL >= 0 ? 'profit-pos' : 'profit-neg');
  }
  if (currentCostEl)  currentCostEl.textContent  = 'SGD $' + activeCost.toFixed(2);
  if (currentValueEl) currentValueEl.textContent = 'SGD $' + activeValue.toFixed(2);

  // Compute movers — items with known current value, sorted by ROI %
  const movers = active
    .filter(i => i.currentValue != null)
    .map(i => {
      const qty  = i.quantity || 1;
      const cost = Number(i.purchasePrice) * qty;
      const val  = Number(i.currentValue) * qty;
      const pl   = val - cost;
      const roi  = cost > 0 ? (pl / cost) * 100 : 0;
      return { ...i, qty, cost, val, pl, roi };
    })
    .sort((a, b) => Math.abs(b.roi) - Math.abs(a.roi));

  const gainers = movers.filter(i => i.roi > 0).slice(0, 5);
  const losers  = movers.filter(i => i.roi < 0).slice(0, 5);

  const moversEl = document.getElementById('pl-movers-content');
  if (moversEl) {
    if (!movers.length) {
      moversEl.innerHTML = `<div style="text-align:center;padding:32px;color:var(--text3);">
        Refresh your portfolio values to see top movers.
      </div>`;
    } else {
      const renderMoverRow = (item, rank) => {
        const roiStr  = (item.roi >= 0 ? '+' : '') + item.roi.toFixed(1) + '%';
        const plStr   = (item.pl >= 0 ? '+' : '') + 'SGD $' + Math.abs(item.pl).toFixed(2);
        const plCls   = item.pl >= 0 ? 'profit-pos' : 'profit-neg';
        const thumb   = item.imageUrl;
        const imgEl   = thumb
          ? `<img src="${esc(thumb)}" style="width:28px;height:40px;object-fit:contain;border-radius:3px;flex-shrink:0;" />`
          : `<span style="font-size:18px;">${item.type==='sealed'?'📦':'🃏'}</span>`;
        const langFlag = item.language === 'japanese' ? ' 🇯🇵' : '';
        const bar = Math.min(Math.abs(item.roi), 100);
        const barColor = item.pl >= 0 ? 'var(--accent)' : '#e05a5a';
        return `<div class="mover-row">
          <div class="mover-rank">${rank}</div>
          ${imgEl}
          <div class="mover-info">
            <div class="mover-name">${esc(item.name)}${langFlag}</div>
            <div class="mover-meta">${esc(item.set||'—')} · ×${item.qty}</div>
            <div class="mover-bar-wrap">
              <div class="mover-bar" style="width:${bar}%;background:${barColor};"></div>
            </div>
          </div>
          <div class="mover-stats">
            <div class="${plCls}" style="font-family:var(--font-mono);font-weight:700;font-size:14px;">${roiStr}</div>
            <div class="${plCls}" style="font-family:var(--font-mono);font-size:11px;margin-top:2px;">${plStr}</div>
          </div>
        </div>`;
      };

      let html = '';
      if (gainers.length) {
        html += `<div class="movers-section-label">📈 Top Gainers</div>`;
        html += gainers.map((item, i) => renderMoverRow(item, i + 1)).join('');
      }
      if (losers.length) {
        html += `<div class="movers-section-label" style="margin-top:20px;">📉 Biggest Drops</div>`;
        html += losers.map((item, i) => renderMoverRow(item, i + 1)).join('');
      }
      if (!gainers.length && !losers.length) {
        html = `<div style="text-align:center;padding:32px;color:var(--text3);">No P/L data yet — refresh portfolio values.</div>`;
      }
      moversEl.innerHTML = html;
    }
  }

  // ── Tab 2: Past Transactions ──────────────────────────────────
  let lifetimePL   = 0;
  let lifetimeCost = 0;
  let lifetimeRev  = 0;

  sold.forEach(item => {
    const cost = Number(item.purchasePrice) * (item.quantity || 1);
    const rev  = Number(item.soldPrice) || 0;
    lifetimeCost += cost;
    lifetimeRev  += rev;
    lifetimePL   += rev - cost;
  });

  const lifeTotalEl = document.getElementById('pl-lifetime-total');
  const lifeCostEl  = document.getElementById('pl-lifetime-cost');
  const lifeRevEl   = document.getElementById('pl-lifetime-revenue');
  if (lifeTotalEl) {
    lifeTotalEl.textContent = (lifetimePL >= 0 ? '↑ +' : '↓ ') + 'SGD $' + Math.abs(lifetimePL).toFixed(2);
    lifeTotalEl.className   = 'pl-lifetime-val ' + (lifetimePL >= 0 ? 'profit-pos' : 'profit-neg');
  }
  if (lifeCostEl) lifeCostEl.textContent  = 'SGD $' + lifetimeCost.toFixed(2);
  if (lifeRevEl)  lifeRevEl.textContent   = 'SGD $' + lifetimeRev.toFixed(2);

  const lifetimeMetricEl = document.getElementById('pf-metric-lifetime');
  if (lifetimeMetricEl && sold.length > 0) {
    lifetimeMetricEl.textContent = (lifetimePL >= 0 ? '+' : '') + 'SGD $' + lifetimePL.toFixed(2);
    lifetimeMetricEl.className = 'pf-metric-val ' + (lifetimePL >= 0 ? 'profit-pos' : 'profit-neg');
  }

  const tbody2 = document.getElementById('pl-history-table');
  if (tbody2) {
    if (!sold.length) {
      tbody2.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:30px;color:var(--text3);">No sold items yet.</td></tr>';
    } else {
      const sortedSold = [...sold].sort((a, b) => (b.soldDate||'').localeCompare(a.soldDate||''));
      tbody2.innerHTML = sortedSold.map(item => {
        const qty   = item.quantity || 1;
        const cost  = Number(item.purchasePrice) * qty;
        const rev   = Number(item.soldPrice) || 0;
        const pl    = rev - cost;
        const roi   = cost > 0 ? (pl / cost) * 100 : 0;
        const plStr = (pl >= 0 ? '↑ +' : '↓ ') + 'SGD $' + Math.abs(pl).toFixed(2);
        const plCls = pl >= 0 ? 'profit-pos' : 'profit-neg';
        const roiStr = (roi >= 0 ? '+' : '') + roi.toFixed(1) + '%';
        const dateStr = item.soldDate
          ? new Date(item.soldDate).toLocaleDateString('en-SG', { day:'numeric', month:'short', year:'numeric' })
          : '—';
        const thumb  = item.imageUrl;
        const imgEl  = thumb
          ? `<img src="${esc(thumb)}" style="width:24px;height:34px;object-fit:contain;border-radius:2px;vertical-align:middle;margin-right:8px;" />`
          : `<span style="margin-right:6px;">${item.type==='sealed'?'📦':'🃏'}</span>`;
        const langFlag = item.language === 'japanese' ? ' 🇯🇵' : '';
        return `<tr>
          <td style="font-weight:600;">${imgEl}${esc(item.name)}${langFlag}</td>
          <td style="font-family:var(--font-mono);">×${qty}</td>
          <td style="font-family:var(--font-mono);">SGD $${cost.toFixed(2)}</td>
          <td style="font-family:var(--font-mono);">SGD $${rev.toFixed(2)}</td>
          <td style="color:var(--text3);font-size:12px;">${dateStr}</td>
          <td class="${plCls}" style="font-family:var(--font-mono);font-weight:700;">${plStr}</td>
          <td class="${plCls}" style="font-family:var(--font-mono);font-size:12px;">${roiStr}</td>
        </tr>`;
      }).join('');
    }
  }
}

// ══════════════════════════════════════════════════════════════════
//  TRADE ANALYSER
// ══════════════════════════════════════════════════════════════════

function openTradeAnalyser() {
  _tradeMyItems    = [];
  _tradeTheirItems = [];
  renderTradeAnalyser();
  document.getElementById('trade-overlay').classList.add('active');
}

function closeTradeAnalyser(e) {
  if (e && e.target !== document.getElementById('trade-overlay')) return;
  document.getElementById('trade-overlay').classList.remove('active');
}

function renderTradeAnalyser() {
  renderTradeSide('my');
  renderTradeSide('their');
  updateTradeVerdict();
}

function renderTradeSide(side) {
  const items = side === 'my' ? _tradeMyItems : _tradeTheirItems;
  const el = document.getElementById(`trade-${side}-items`);
  if (!el) return;

  if (!items.length) {
    el.innerHTML = `<div class="trade-empty-side">No items added yet</div>`;
    return;
  }

  el.innerHTML = items.map((item, i) => `
    <div class="trade-item-row">
      ${item.imageUrl ? `<img src="${esc(item.imageUrl)}" class="trade-item-thumb" />` : `<span class="trade-item-emoji">${item.isSealed ? '📦' : '🃏'}</span>`}
      <div class="trade-item-info">
        <div class="trade-item-name">${esc(item.name)}</div>
        <div class="trade-item-val">SGD $${Number(item.valueSGD).toFixed(2)}</div>
      </div>
      <button class="trade-remove-btn" onclick="removeTradeItem('${side}',${i})" title="Remove">✕</button>
    </div>
  `).join('');
}

function removeTradeItem(side, index) {
  if (side === 'my') _tradeMyItems.splice(index, 1);
  else _tradeTheirItems.splice(index, 1);
  renderTradeSide(side);
  updateTradeVerdict();
}

// Trade search state
let _tradeSearchSide    = null;
let _tradeSearchResults = [];
let _tradeSearchDebounce = null;

function openTradeSearch(side) {
  _tradeSearchSide = side;
  document.getElementById('trade-search-overlay').classList.add('active');
  document.getElementById('trade-search-input').value = '';
  document.getElementById('trade-search-results-box').innerHTML = '';
  document.getElementById('trade-search-side-label').textContent = side === 'my' ? 'Your item' : 'Their item';
  setTimeout(() => document.getElementById('trade-search-input').focus(), 100);
}

function closeTradeSearch() {
  document.getElementById('trade-search-overlay').classList.remove('active');
  _tradeSearchSide = null;
}

function tradeSearchDebounce() {
  clearTimeout(_tradeSearchDebounce);
  _tradeSearchDebounce = setTimeout(doTradeSearch, 400);
}

async function doTradeSearch() {
  const raw      = (document.getElementById('trade-search-input')?.value || '').trim();
  const typeBtn  = document.querySelector('.trade-type-btn.active');
  const isSealed = typeBtn?.dataset.type === 'sealed';
  const langBtn  = document.querySelector('.trade-lang-btn.active');
  const lang     = langBtn?.dataset.lang || 'english';
  const resultsBox = document.getElementById('trade-search-results-box');

  if (!raw || raw.length < 2) { if (resultsBox) resultsBox.innerHTML = ''; return; }

  resultsBox.innerHTML = '<div style="padding:12px;color:var(--text3);font-size:12px;">Searching…</div>';

  try {
    let params;
    if (isSealed) {
      params = new URLSearchParams({ action: 'sealed', language: lang });
      params.set('name', raw);
    } else if (isCardNumber(raw)) {
      params = new URLSearchParams({ action: 'bynumber', name: raw, language: lang });
    } else {
      params = new URLSearchParams({ action: 'search', name: raw, language: lang });
    }

    const res  = await fetch('/api/pokeprice?' + params);
    const data = await res.json();
    _tradeSearchResults = data.results || [];

    if (!_tradeSearchResults.length) {
      resultsBox.innerHTML = '<div style="padding:12px;color:var(--text3);font-size:12px;">No results found.</div>';
      return;
    }

    resultsBox.innerHTML = _tradeSearchResults.slice(0, 15).map((r, i) => {
      const priceUSD = extractResultPrice(r, isSealed);
      const priceSGD = priceUSD != null ? (priceUSD * USD_TO_SGD).toFixed(2) : null;
      const thumb = r.imageCdnUrl200 || r.imageCdnUrl400 || r.imageCdnUrl || '';
      const imgEl = thumb
        ? `<img src="${esc(thumb)}" style="width:28px;height:40px;object-fit:contain;border-radius:3px;flex-shrink:0;" />`
        : `<span style="font-size:18px;">${isSealed?'📦':'🃏'}</span>`;
      return `<div class="pf-result-row" onclick="addTradeSearchResult(${i},${isSealed})">
        ${imgEl}
        <div class="pf-result-info">
          <div class="pf-result-name">${esc(r.name)}</div>
          <div class="pf-result-sub">${esc(r.setName||'—')}</div>
        </div>
        <div class="pf-result-right">
          <span class="pf-result-price">${priceSGD ? 'SGD $'+priceSGD : '—'}</span>
        </div>
      </div>`;
    }).join('');
  } catch (e) {
    resultsBox.innerHTML = '<div style="padding:12px;color:#e05a5a;font-size:12px;">Search failed.</div>';
  }
}

// Allow user to set custom value in trade search
let _tradePickedResult = null;
let _tradePickedIsSealed = false;

function addTradeSearchResult(index, isSealed) {
  const r = _tradeSearchResults[index];
  if (!r) return;
  _tradePickedResult   = r;
  _tradePickedIsSealed = isSealed;

  const priceUSD = extractResultPrice(r, isSealed);
  const priceSGD = priceUSD != null ? (priceUSD * USD_TO_SGD).toFixed(2) : '';

  // Show custom value input
  document.getElementById('trade-custom-name').textContent = r.name;
  document.getElementById('trade-custom-price').value = priceSGD;
  document.getElementById('trade-custom-panel').style.display = 'block';
  setTimeout(() => document.getElementById('trade-custom-price').focus(), 50);
}

function confirmTradeItem() {
  const r = _tradePickedResult;
  if (!r || !_tradeSearchSide) return;

  const customVal = parseFloat(document.getElementById('trade-custom-price').value);
  if (!customVal || customVal <= 0) { toast('Please enter a valid value.', 'error'); return; }

  const item = {
    name:     r.name,
    valueSGD: customVal,
    imageUrl: r.imageCdnUrl200 || r.imageCdnUrl400 || r.imageCdnUrl || null,
    isSealed: _tradePickedIsSealed,
  };

  if (_tradeSearchSide === 'my') _tradeMyItems.push(item);
  else _tradeTheirItems.push(item);

  closeTradeSearch();
  renderTradeSide(_tradeSearchSide);
  updateTradeVerdict();

  _tradePickedResult   = null;
  _tradePickedIsSealed = false;
  document.getElementById('trade-custom-panel').style.display = 'none';
}

// Also allow adding from portfolio
function addFromPortfolioToTrade(side) {
  const active = portfolioItems.filter(i => !i.sold && i.currentValue != null);
  if (!active.length) { toast('No items with known value in your portfolio. Refresh values first.', 'info'); return; }

  // Simple picker modal inline
  const picker = document.getElementById('trade-portfolio-picker');
  const list   = document.getElementById('trade-portfolio-picker-list');
  if (!picker || !list) return;

  list.innerHTML = active.map((item, i) => {
    const val = Number(item.currentValue) * (item.quantity || 1);
    const thumb = item.imageUrl;
    const imgEl = thumb
      ? `<img src="${esc(thumb)}" style="width:28px;height:40px;object-fit:contain;border-radius:3px;flex-shrink:0;" />`
      : `<span style="font-size:18px;">${item.type==='sealed'?'📦':'🃏'}</span>`;
    return `<div class="pf-result-row" onclick="pickPortfolioForTrade('${side}',${i})">
      ${imgEl}
      <div class="pf-result-info">
        <div class="pf-result-name">${esc(item.name)}</div>
        <div class="pf-result-sub">${esc(item.set||'—')} · ×${item.quantity||1}</div>
      </div>
      <div class="pf-result-right">
        <span class="pf-result-price">SGD $${val.toFixed(2)}</span>
      </div>
    </div>`;
  }).join('');

  picker.dataset.side = side;
  picker.style.display = 'block';
}

function pickPortfolioForTrade(side, index) {
  const active = portfolioItems.filter(i => !i.sold && i.currentValue != null);
  const item = active[index];
  if (!item) return;

  const val = Number(item.currentValue) * (item.quantity || 1);
  const tradeItem = {
    name:     item.name + (item.quantity > 1 ? ` ×${item.quantity}` : ''),
    valueSGD: val,
    imageUrl: item.imageUrl || null,
    isSealed: item.type === 'sealed',
  };

  if (side === 'my') _tradeMyItems.push(tradeItem);
  else _tradeTheirItems.push(tradeItem);

  document.getElementById('trade-portfolio-picker').style.display = 'none';
  renderTradeSide(side);
  updateTradeVerdict();
}

function closePortfolioPicker() {
  document.getElementById('trade-portfolio-picker').style.display = 'none';
}

function updateTradeVerdict() {
  const verdictEl = document.getElementById('trade-verdict');
  if (!verdictEl) return;

  const myTotal    = _tradeMyItems.reduce((s, i) => s + Number(i.valueSGD), 0);
  const theirTotal = _tradeTheirItems.reduce((s, i) => s + Number(i.valueSGD), 0);

  // Cash adjustment
  const cashDir    = document.getElementById('trade-cash-dir')?.value || 'none';
  const cashAmt    = parseFloat(document.getElementById('trade-cash-amount')?.value || '0') || 0;

  let myEffective    = myTotal;
  let theirEffective = theirTotal;

  if (cashDir === 'i_pay' && cashAmt > 0) {
    myEffective += cashAmt;   // I'm giving more total value
  } else if (cashDir === 'they_pay' && cashAmt > 0) {
    theirEffective += cashAmt;
  }

  document.getElementById('trade-my-total').textContent    = 'SGD $' + myTotal.toFixed(2);
  document.getElementById('trade-their-total').textContent = 'SGD $' + theirTotal.toFixed(2);

  const myEffEl    = document.getElementById('trade-my-effective');
  const theirEffEl = document.getElementById('trade-their-effective');
  if (myEffEl)    myEffEl.textContent    = cashDir !== 'none' && cashAmt > 0 ? `SGD $${myEffective.toFixed(2)} effective` : '';
  if (theirEffEl) theirEffEl.textContent = cashDir !== 'none' && cashAmt > 0 ? `SGD $${theirEffective.toFixed(2)} effective` : '';

  if (!_tradeMyItems.length || !_tradeTheirItems.length) {
    verdictEl.innerHTML = `<div class="trade-verdict-placeholder">Add items to both sides to analyse the trade.</div>`;
    return;
  }

  const higher = Math.max(myEffective, theirEffective);
  const lower  = Math.min(myEffective, theirEffective);
  const diffPct = higher > 0 ? ((higher - lower) / higher) * 100 : 0;

  let verdict, verdictClass, emoji, advice;

  if (diffPct <= 5) {
    verdict = 'Fair Trade'; verdictClass = 'verdict-fair'; emoji = '✅';
    advice = `Values are within 5% of each other — this is a fair trade.`;
  } else if (diffPct <= 15) {
    const who = myEffective > theirEffective ? 'You' : 'They';
    const dir = myEffective > theirEffective ? 'giving more' : 'getting more';
    verdict = `${diffPct.toFixed(1)}% Off`; verdictClass = 'verdict-warn'; emoji = '⚠️';
    advice = `${who} are ${dir} value. ${diffPct.toFixed(1)}% gap — consider negotiating.`;
  } else {
    const who = myEffective < theirEffective ? 'you' : 'them';
    verdict = `Unfair — ${diffPct.toFixed(1)}% gap`; verdictClass = 'verdict-bad'; emoji = '❌';
    advice = `Significant imbalance (${diffPct.toFixed(1)}%). This heavily favours ${who}.`;
  }

  const cashNote = cashDir !== 'none' && cashAmt > 0
    ? `<div class="trade-cash-note">${cashDir === 'i_pay' ? '💵 You pay' : '💵 They pay'} SGD $${cashAmt.toFixed(2)} cash included.</div>`
    : '';

  verdictEl.innerHTML = `
    <div class="trade-verdict-card ${verdictClass}">
      <div class="trade-verdict-emoji">${emoji}</div>
      <div class="trade-verdict-title">${esc(verdict)}</div>
      <div class="trade-verdict-advice">${esc(advice)}</div>
      ${cashNote}
      <div class="trade-verdict-breakdown">
        <div class="trade-breakdown-row">
          <span>Your side</span>
          <span style="font-family:var(--font-mono);">SGD $${myEffective.toFixed(2)}</span>
        </div>
        <div class="trade-breakdown-row">
          <span>Their side</span>
          <span style="font-family:var(--font-mono);">SGD $${theirEffective.toFixed(2)}</span>
        </div>
        <div class="trade-breakdown-row" style="border-top:1px solid var(--border);padding-top:8px;margin-top:4px;font-weight:700;">
          <span>Difference</span>
          <span style="font-family:var(--font-mono);" class="${verdictClass === 'verdict-fair' ? 'profit-pos' : 'profit-neg'}">${diffPct.toFixed(1)}%</span>
        </div>
      </div>
    </div>`;
}

function setTradeLang(lang) {
  document.querySelectorAll('.trade-lang-btn').forEach(b => b.classList.toggle('active', b.dataset.lang === lang));
}

function setTradeType(type) {
  document.querySelectorAll('.trade-type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === type));
}

// ══════════════════════════════════════════════════════════════════
//  PORTFOLIO — Load & Render
// ══════════════════════════════════════════════════════════════════

async function loadPortfolioItems() {
  const { data, error } = await _sb.from('portfolio_items').select('*')
    .eq('user_id', _currentUserId).order('created_at', { ascending: true });
  if (error) { console.error('loadPortfolioItems error:', error); return; }
  portfolioItems = data.map(dbToPortfolioItem);
  renderPortfolio();
  updateSearchTabVisibility();
}

function renderPortfolio() {
  const tbody = document.getElementById('portfolio-table');
  if (!tbody) return;

  const active = portfolioItems.filter(i => !i.sold);

  const totalCost  = active.reduce((s, i) => s + Number(i.purchasePrice) * (i.quantity||1), 0);
  const totalValue = active.reduce((s, i) => {
    const val = i.currentValue != null ? Number(i.currentValue) : Number(i.purchasePrice);
    return s + val * (i.quantity||1);
  }, 0);
  const totalPL = totalValue - totalCost;
  const roi     = totalCost > 0 ? (totalPL / totalCost) * 100 : 0;

  const metricCost  = document.getElementById('pf-metric-cost');
  const metricValue = document.getElementById('pf-metric-value');
  const metricPL    = document.getElementById('pf-metric-pl');
  const metricROI   = document.getElementById('pf-metric-roi');

  if (metricCost)  metricCost.textContent  = 'SGD $' + totalCost.toFixed(2);
  if (metricValue) animateValue(metricValue, totalValue, 'SGD ');
  if (metricPL) {
    metricPL.textContent = (totalPL >= 0 ? '↑ +' : '↓ ') + 'SGD $' + Math.abs(totalPL).toFixed(2);
    metricPL.className   = 'pf-metric-val ' + (totalPL >= 0 ? 'profit-pos' : 'profit-neg');
  }
  if (metricROI) {
    metricROI.textContent = (roi >= 0 ? '+' : '') + roi.toFixed(1) + '%';
    metricROI.className   = 'pf-metric-val ' + (roi >= 0 ? 'profit-pos' : 'profit-neg');
  }

  const sold = portfolioItems.filter(i => i.sold);
  const lifetimePL = sold.reduce((s, i) => {
    const cost = Number(i.purchasePrice) * (i.quantity||1);
    const rev  = Number(i.soldPrice) || 0;
    return s + (rev - cost);
  }, 0);
  const lifetimeEl = document.getElementById('pf-metric-lifetime');
  if (lifetimeEl) {
    if (sold.length > 0) {
      lifetimeEl.textContent = (lifetimePL >= 0 ? '+' : '') + 'SGD $' + lifetimePL.toFixed(2);
      lifetimeEl.className   = 'pf-metric-val ' + (lifetimePL >= 0 ? 'profit-pos' : 'profit-neg');
    } else {
      lifetimeEl.textContent = 'No sales yet';
      lifetimeEl.className   = 'pf-metric-val';
    }
  }

  if (!active.length) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state">No active holdings — use the search above to add cards or sealed products</div></td></tr>';
    return;
  }

  tbody.innerHTML = active.map(item => {
    const cost      = Number(item.purchasePrice) * (item.quantity||1);
    const val       = item.currentValue != null ? Number(item.currentValue) * (item.quantity||1) : null;
    const profit    = val != null ? val - cost : null;
    const profitStr = profit != null
      ? (profit >= 0 ? '↑ +' : '↓ ') + 'SGD $' + Math.abs(profit).toFixed(2)
      : '—';
    const profitClass = profit == null ? '' : (profit >= 0 ? 'profit-pos' : 'profit-neg');
    const typeIcon    = item.type === 'sealed' ? '📦' : '🃏';
    const thumb       = item.imageUrl;
    const imgEl       = thumb
      ? `<img src="${esc(thumb)}" style="width:28px;height:40px;object-fit:contain;border-radius:3px;vertical-align:middle;margin-right:8px;cursor:pointer;" onclick="event.stopPropagation();openCardDetailModal('${item.id}')" title="View chart & image" />`
      : `<span style="margin-right:8px;">${typeIcon}</span>`;
    const langFlag = item.language === 'japanese' ? ' 🇯🇵' : '';

    return `<tr class="pf-row-clickable" onclick="toggleRowActions(this, '${item.id}')" title="Click to reveal actions">
      <td style="font-weight:600;">${imgEl}${esc(item.name)}${langFlag}</td>
      <td style="color:var(--text2);">${esc(item.set||'—')}</td>
      <td><span class="badge badge-raw">${esc(item.conditionOrGrade)}</span></td>
      <td style="font-family:var(--font-mono);">×${item.quantity||1}</td>
      <td style="font-family:var(--font-mono);">SGD $${cost.toFixed(2)}</td>
      <td style="font-family:var(--font-mono);">${val != null ? 'SGD $'+val.toFixed(2) : '<span style="color:var(--text3);">—</span>'}</td>
      <td class="${profitClass}" style="font-family:var(--font-mono);font-weight:600;position:relative;">
        <span class="pf-pl-text">${profitStr}</span>
        <div class="row-actions" onclick="event.stopPropagation()">
          <button class="btn-sell"
            onclick="openSellModal('${item.id}')"
            title="Mark as Sold">$ Sell</button>
          <button class="btn-edit"
            onclick="openEditModal('${item.id}')"
            title="Edit item">✎ Edit</button>
          <button class="del-btn" onclick="deletePortfolioItem('${item.id}')" title="Remove">✕</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

// Toggle row action buttons (sell/edit/delete) on click
function toggleRowActions(row, itemId) {
  const isActive = row.classList.contains('row-actions-open');
  // Close all other open rows
  document.querySelectorAll('.pf-row-clickable.row-actions-open').forEach(r => r.classList.remove('row-actions-open'));
  if (!isActive) {
    row.classList.add('row-actions-open');
  }
}

// Edit modal — lets user update purchase price, quantity, condition, notes
function openEditModal(id) {
  const item = portfolioItems.find(i => i.id === id);
  if (!item) return;

  // Re-use the portfolio-add-overlay as an edit modal
  document.getElementById('pf-item-name').textContent  = item.name || '—';
  document.getElementById('pf-item-set').textContent   = item.set  || '—';
  document.getElementById('pf-item-type').textContent  = item.type === 'sealed' ? '📦 Sealed' : '🃏 Card';
  const imgEl = document.getElementById('pf-item-img');
  if (item.imageUrl) { imgEl.src = item.imageUrl; imgEl.style.display = 'block'; }
  else imgEl.style.display = 'none';

  const costPerUnit = (Number(item.purchasePrice) || 0).toFixed(2);
  document.getElementById('pf-purchase-price').value = costPerUnit;
  document.getElementById('pf-quantity').value        = item.quantity || 1;
  document.getElementById('pf-notes').value           = item.notes || '';

  const condSel = document.getElementById('pf-condition');
  const isSealed = item.type === 'sealed';
  condSel.innerHTML = isSealed
    ? `<option value="Sealed">Sealed / Unopened</option><option value="Opened">Opened</option>`
    : `<option value="Near Mint">Near Mint</option>
       <option value="Lightly Played">Lightly Played</option>
       <option value="Moderately Played">Moderately Played</option>
       <option value="Heavily Played">Heavily Played</option>
       <option value="Damaged">Damaged</option>
       <option value="PSA 10">PSA 10</option>
       <option value="PSA 9">PSA 9</option>
       <option value="PSA 8">PSA 8</option>
       <option value="BGS 10">BGS 10</option>
       <option value="BGS 9.5">BGS 9.5</option>`;
  condSel.value = item.conditionOrGrade || 'Near Mint';

  // Change the save button to an "Update" action
  const saveBtn = document.querySelector('#portfolio-add-overlay .btn-search');
  const heading = document.querySelector('#portfolio-add-overlay h2');
  if (heading) heading.textContent = 'Edit Portfolio Item';
  if (saveBtn) {
    saveBtn.textContent = 'Update Item';
    saveBtn.onclick = () => updatePortfolioItem(id);
  }

  document.getElementById('portfolio-add-overlay').classList.add('active');
}

async function updatePortfolioItem(id) {
  const price = parseFloat(document.getElementById('pf-purchase-price').value);
  const qty   = parseInt(document.getElementById('pf-quantity').value, 10);
  const cond  = document.getElementById('pf-condition').value;
  const notes = (document.getElementById('pf-notes').value || '').trim();

  if (isNaN(price) || price < 0) { toast('Please enter a valid price.', 'error'); return; }
  if (isNaN(qty) || qty < 1)     { toast('Quantity must be at least 1.', 'error'); return; }

  const { error } = await _sb.from('portfolio_items')
    .update({ purchase_price: price, quantity: qty, condition_or_grade: cond, notes })
    .eq('id', id).eq('user_id', _currentUserId);

  if (error) { toast('Failed to update item.', 'error'); return; }

  // Update local state
  const idx = portfolioItems.findIndex(i => i.id === id);
  if (idx !== -1) {
    portfolioItems[idx] = { ...portfolioItems[idx], purchasePrice: price, quantity: qty, conditionOrGrade: cond, notes };
  }

  closePortfolioAddModal();
  renderPortfolio();
  toast('Item updated.', 'success');
}

async function deletePortfolioItem(id) {
  const item = portfolioItems.find(i => i.id === id);
  if (!await confirmDialog('Remove "' + (item?.name ?? 'this item') + '" from your portfolio?')) return;
  const { error } = await _sb.from('portfolio_items').delete().eq('id', id).eq('user_id', _currentUserId);
  if (error) { toast('Failed to delete.', 'error'); return; }
  portfolioItems = portfolioItems.filter(i => i.id !== id);
  renderPortfolio();
  toast('Item removed from portfolio.', 'info');
}

// ── Refresh portfolio current values ─────────────────────────────
async function refreshPortfolioValues(silent = false) {
  const active = portfolioItems.filter(i => !i.sold);
  if (!active.length) { if (!silent) toast('No items to refresh.', 'info'); return; }

  const btn = document.querySelector('.btn-refresh-small');
  if (btn) { btn.disabled = true; btn.textContent = '↻ Refreshing…'; }

  let updated = 0;

  for (const item of active) {
    try {
      const lang     = item.language || 'english';
      const isSealed = item.type === 'sealed';
      let params;

      if (isSealed) {
        params = new URLSearchParams({ action: 'sealed', language: lang, includeHistory: 'true', days: String(_allowedHistoryDays) });
        params.set('name', item.name);
      } else {
        params = new URLSearchParams({ action: 'search', name: item.name, language: lang, includeHistory: 'true', days: String(_allowedHistoryDays) });
        if (item.set) params.set('set', item.set);
      }

      const res = await fetch('/api/pokeprice?' + params);
      if (!res.ok) continue;
      const d       = await res.json();
      const results = d.results || [];
      if (!results.length) continue;

      let priceSGD = null;
      const isGraded = !isSealed && /^(PSA|BGS|CGC)\s+/i.test(item.conditionOrGrade || '');

      if (isGraded) {
        const gradedUSD = extractGradedPrice(results[0], item.conditionOrGrade);
        if (gradedUSD != null) priceSGD = Math.round(gradedUSD * USD_TO_SGD * 100) / 100;
      }

      if (priceSGD == null) {
        const priceUSD = extractResultPrice(results[0], isSealed);
        if (priceUSD == null) continue;
        priceSGD = Math.round(priceUSD * USD_TO_SGD * 100) / 100;
      }

      await _sb.from('portfolio_items')
        .update({ current_value: priceSGD, last_value_updated: new Date().toISOString() })
        .eq('id', item.id).eq('user_id', _currentUserId);

      const idx = portfolioItems.findIndex(i => i.id === item.id);
      if (idx > -1) portfolioItems[idx] = { ...portfolioItems[idx], currentValue: priceSGD };
      updated++;
    } catch (e) { console.warn('Portfolio refresh failed for', item.name, e); }
    await new Promise(r => setTimeout(r, 350));
  }

  renderPortfolio();
  if (btn) { btn.disabled = false; btn.textContent = '↻ Refresh values'; }
  if (!silent) {
    toast(updated ? `Updated ${updated} item${updated !== 1 ? 's' : ''}.` : 'No prices found.', updated ? 'success' : 'info');
  }
}

// ── Keyboard shortcut ─────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  ['modal-overlay', 'confirm-overlay', 'portfolio-add-overlay', 'card-detail-overlay',
   'portfolio-chart-overlay', 'pl-overlay', 'sell-overlay', 'trade-overlay', 'trade-search-overlay']
    .forEach(id => document.getElementById(id)?.classList.remove('active'));
  _cardDetailChart = destroyChart(_cardDetailChart);
  _portfolioChart  = destroyChart(_portfolioChart);
});

// ── Bootstrap ─────────────────────────────────────────────────────
init();
