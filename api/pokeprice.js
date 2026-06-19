// api/pokeprice.js
// Vercel serverless proxy for PokémonPriceTracker API v2.
//
// Required env vars (set in Vercel dashboard):
//   POKEPRICE_API_KEY      — PokémonPriceTracker API bearer token
//   SUPABASE_URL           — your Supabase project URL
//   SUPABASE_SERVICE_KEY   — Supabase service_role key (never sent to client)

const BASE = 'https://www.pokemonpricetracker.com/api/v2';

// ── Supabase cache writer (fire-and-forget, never blocks the response) ────────
async function sbInsertCacheRows(rows) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key || !rows.length) return;
  try {
    await fetch(`${url}/rest/v1/price_history_cache`, {
      method: 'POST',
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=ignore-duplicates',
      },
      body: JSON.stringify(rows),
    });
  } catch (e) {
    console.warn('Supabase cache write failed (non-fatal):', e.message);
  }
}

// ── Supabase graded sales writer (fire-and-forget) ────────────────────────────
// Writes eBay graded sales into price_history_cache using a composite key:
//   item_id  = "<tcgPlayerId>__<gradingCompany>_<grade>"   e.g. "12345__PSA_10"
//   type     = "graded"
//   price    = sale price in USD (stored; converted to SGD on the client)
// The 'Prefer: resolution=ignore-duplicates' header means duplicate
// (item_id, recorded_date) pairs are silently skipped — safe to call repeatedly.
async function sbInsertGradedSales(itemId, ebaySales) {
  if (!Array.isArray(ebaySales) || !ebaySales.length || !itemId) return;

  const today = new Date().toISOString().split('T')[0];

  const rows = ebaySales
    .map(sale => {
      // Normalise field names — API may use different casings
      const company = (sale.gradingCompany || sale.grading_company || sale.company || '').trim().toUpperCase();
      const grade   = String(sale.grade ?? sale.gradeNumber ?? sale.grade_number ?? '').trim();
      const price   = parseFloat(sale.salePrice ?? sale.sale_price ?? sale.price ?? 0);
      const saleDate = (sale.saleDate || sale.sale_date || sale.date || today).split('T')[0];

      // Skip rows missing essential fields
      if (!company || !grade || !price || price <= 0) return null;

      return {
        item_id:       `${itemId}__${company}_${grade}`,
        type:          'graded',
        price:         price,
        language:      'english',
        recorded_date: saleDate,
        // Extra context stored as JSON string in a notes column if your schema supports it.
        // If your price_history_cache table doesn't have a 'notes' column, remove this line.
        // notes: JSON.stringify({ gradingCompany: company, grade, rawItemId: itemId }),
      };
    })
    .filter(Boolean);

  if (rows.length) sbInsertCacheRows(rows); // intentionally not awaited
}

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // CORS — allows the browser to call /api/pokeprice from the same Vercel domain
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.POKEPRICE_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'POKEPRICE_API_KEY is not set in Vercel environment variables.' });

  const headers = { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' };

  const {
    action,
    name,
    set,
    id,
    language,
    days,
    includeHistory,
    includeEbay,
  } = req.query;

  const lang        = language === 'japanese' ? 'japanese' : 'english';
  const historyDays = parseInt(days, 10) || 0;
  const wantHistory = includeHistory === 'true' && historyDays > 0;

  // ── eBay graded data is ALWAYS requested ─────────────────────────────────
  // includeEbay=true activates PSA/CGC/BGS sale data from the API.
  // When active, the API caps responses at 50 results max, so we enforce
  // that limit ourselves to avoid upstream 400 errors.
  const wantEbay = true; // always on — overrides any client-supplied value

  const today = new Date().toISOString().split('T')[0];

  // Build upstream query params
  // limit is capped at 50 whenever eBay data is active (API requirement)
  function baseParams(searchStr, rawLimit = 20) {
    const p = new URLSearchParams({ language: lang });
    if (searchStr)   p.set('search', searchStr);
    if (wantHistory) { p.set('includeHistory', 'true'); p.set('days', String(historyDays)); }
    // Always include eBay graded data; cap limit at 50 as required by the API
    p.set('includeEbay', 'true');
    p.set('limit', String(Math.min(rawLimit, 50)));
    return p;
  }

  // Normalise API response shape to a flat results array
  function toResults(data) {
    return Array.isArray(data.data) ? data.data : (data.data ? [data.data] : []);
  }

  // Extract the best available market price from a result object
  function extractPrice(r) {
    return r.prices?.market    ?? r.prices?.lowPrice ?? r.prices?.midPrice
        ?? r.japanesePrice     ?? r.averagePrice     ?? r.marketPrice
        ?? r.price             ?? null;
  }

  // Write standard price snapshots + any graded eBay sales to Supabase cache
  function cacheResults(results, type) {
    const priceRows = results
      .map(r => {
        const price  = type === 'sealed' ? (r.unopenedPrice ?? null) : extractPrice(r);
        const itemId = String(r.tcgPlayerId || r.id || r.productId || '').trim();
        if (price == null || !itemId) return null;
        return { item_id: itemId, type, price: Number(price), language: lang, recorded_date: today };
      })
      .filter(Boolean);

    if (priceRows.length) sbInsertCacheRows(priceRows); // fire-and-forget

    // Cache graded eBay sales for every result that carries them
    for (const r of results) {
      const itemId   = String(r.tcgPlayerId || r.id || r.productId || '').trim();
      const ebay     = r.ebaySales ?? r.ebay_sales ?? r.gradedSales ?? [];
      if (itemId && Array.isArray(ebay) && ebay.length) {
        sbInsertGradedSales(itemId, ebay); // fire-and-forget
      }
    }
  }

  // ── action=search  (card name / set search) ───────────────────────────────
  if (action === 'search') {
    if (!name) return res.status(400).json({ error: 'Missing param: name' });
    const searchStr = set ? `${name.trim()} ${set.trim()}` : name.trim();
    const params = baseParams(searchStr, 20); // cap: 50 enforced inside baseParams
    try {
      const upstream = await fetch(`${BASE}/cards?${params}`, { headers });
      const body = await upstream.text();
      if (!upstream.ok) return res.status(upstream.status).json({ error: 'Upstream error', detail: body });
      const data    = JSON.parse(body);
      const results = toResults(data);
      cacheResults(results, 'card');
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
      return res.status(200).json({ results, metadata: data.metadata ?? {} });
    } catch (err) {
      return res.status(500).json({ error: 'Fetch failed', detail: err.message });
    }
  }

  // ── action=bynumber  (exact card number, e.g. 199/165) ───────────────────
  if (action === 'bynumber') {
    if (!name) return res.status(400).json({ error: 'Missing param: name (card number)' });
    const params = baseParams(name.trim(), 30); // cap: 50 enforced inside baseParams
    if (set) params.set('set', set.trim());
    try {
      const upstream = await fetch(`${BASE}/cards?${params}`, { headers });
      const body = await upstream.text();
      if (!upstream.ok) return res.status(upstream.status).json({ error: 'Upstream error', detail: body });
      const data = JSON.parse(body);
      const all  = toResults(data);
      const num  = name.trim().toLowerCase();
      // Prefer exact number match; fall back to full result set if nothing matches
      const matched = all.filter(r => {
        const cn   = (r.cardNumber || '').toLowerCase();
        const full = `${cn}/${r.totalSetNumber || ''}`.toLowerCase();
        return cn === num || full === num || full.startsWith(num + '/');
      });
      const results = matched.length ? matched : all;
      cacheResults(results, 'card');
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
      return res.status(200).json({ results, metadata: data.metadata ?? {} });
    } catch (err) {
      return res.status(500).json({ error: 'Fetch failed', detail: err.message });
    }
  }

  // ── action=sealed  (sealed products — MUST use /sealed-products endpoint) ─
  if (action === 'sealed') {
    const params = baseParams(name ? name.trim() : undefined, 20);
    if (set) params.set('set', set.trim());
    try {
      // NOTE: endpoint is /sealed-products, NOT /sealed
      const upstream = await fetch(`${BASE}/sealed-products?${params}`, { headers });
      const body = await upstream.text();
      if (!upstream.ok) return res.status(upstream.status).json({ error: 'Upstream error', detail: body });
      const data    = JSON.parse(body);
      const results = toResults(data);
      cacheResults(results, 'sealed');
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
      return res.status(200).json({ results, metadata: data.metadata ?? {} });
    } catch (err) {
      return res.status(500).json({ error: 'Fetch failed', detail: err.message });
    }
  }

  // ── action=card  (single card by TCGPlayer ID) ────────────────────────────
  if (action === 'card') {
    if (!id) return res.status(400).json({ error: 'Missing param: id' });
    const params = baseParams(undefined, 1);
    params.set('tcgPlayerId', id.trim());
    try {
      const upstream = await fetch(`${BASE}/cards?${params}`, { headers });
      const body = await upstream.text();
      if (!upstream.ok) return res.status(upstream.status).json({ error: 'Upstream error', detail: body });
      const data    = JSON.parse(body);
      const results = toResults(data);
      cacheResults(results, 'card');
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
      return res.status(200).json({ results, metadata: data.metadata ?? {} });
    } catch (err) {
      return res.status(500).json({ error: 'Fetch failed', detail: err.message });
    }
  }

  return res.status(400).json({ error: 'Invalid action. Valid values: search | bynumber | sealed | card' });
}
