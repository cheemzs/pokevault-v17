# PokéVault v17

A Pokémon card portfolio tracker with live prices, P/L tracking, and trade analysis.

## What's new in v17

- **Sealed products fully fixed** — correct `/sealed-products` API endpoint, handles `unopenedPrice` / `marketPrice` / `prices.*` fields, set filter supported
- **Price filter** — search results hide cards under $2 USD (noise reduction)
- **Interactive metric cards** — P/L Dashboard, Price History, and Trade Analyser cards are now fully clickable: teal border on hover, pointer cursor, elegant `+` icon indicator; old text links removed
- **Edit button** — click any portfolio row to reveal Sell / Edit / Remove buttons in-place; no persistent Actions column
- **Responsive layout** — full-width on desktop, stacks cleanly on mobile

## Deploy to Vercel

1. Push this folder to a new GitHub repo
2. Import into Vercel — it auto-detects the project
3. Set environment variables in the Vercel dashboard:
   - `POKEPRICE_API_KEY` — your PokémonPriceTracker API key
   - `SUPABASE_URL` — your Supabase project URL
   - `SUPABASE_SERVICE_KEY` — Supabase service role key (never exposed to client)

## Supabase setup

Run `supabase_schema_v16.sql` in your Supabase SQL editor (Schema → SQL Editor → New Query).
If upgrading from v15, only the `trade_analyses` table is new — see migration note in the SQL file.
