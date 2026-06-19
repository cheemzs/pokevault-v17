-- ═══════════════════════════════════════════════════════════════
--  PokéVault v15 — Supabase Schema
--  Run this in your Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- ═══════════════════════════════════════════════════════════════

-- ── profiles ─────────────────────────────────────────────────────
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  username     text not null,
  is_premium   boolean not null default false,
  created_at   timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "Users can view own profile"
  on public.profiles for select using (auth.uid() = id);

create policy "Users can insert own profile"
  on public.profiles for insert with check (auth.uid() = id);

create policy "Users can update own profile"
  on public.profiles for update using (auth.uid() = id);


-- ── portfolio_items ───────────────────────────────────────────────
-- This table is the PORTFOLIO (what you own / owned).
-- P/L is always computed at query time from these rows — it is never stored.
--
-- • sold = false  →  active holding  (Tab 1: Current Portfolio)
-- • sold = true   →  closed position (Tab 2: Past Transactions)
--
-- Realised P/L for a sold row = (sold_price - purchase_price) * quantity
-- Unrealised P/L for an active row = (current_value - purchase_price) * quantity

create table if not exists public.portfolio_items (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,

  -- card / product identity
  item_id             text not null,          -- tcgPlayerId or productId
  type                text not null,          -- 'card' | 'sealed'
  name                text not null,
  set_name            text,
  image_url           text,
  language            text not null default 'english',

  -- purchase details
  purchase_price      numeric(10,2) not null, -- SGD, per-unit
  quantity            integer not null default 1,
  condition_or_grade  text not null default 'Near Mint',
  notes               text,

  -- live market value (refreshed by user action, stored per-unit in SGD)
  current_value       numeric(10,2),
  last_value_updated  timestamptz,

  -- sale details (populated when user clicks "Mark as Sold")
  sold                boolean not null default false,
  sold_price          numeric(10,2),          -- SGD, total received for the lot
  sold_date           date,

  created_at          timestamptz not null default now()
);

alter table public.portfolio_items enable row level security;

create policy "Users can select own portfolio items"
  on public.portfolio_items for select using (auth.uid() = user_id);

create policy "Users can insert own portfolio items"
  on public.portfolio_items for insert with check (auth.uid() = user_id);

create policy "Users can update own portfolio items"
  on public.portfolio_items for update using (auth.uid() = user_id);

create policy "Users can delete own portfolio items"
  on public.portfolio_items for delete using (auth.uid() = user_id);

-- Index for fast per-user queries
create index if not exists idx_portfolio_items_user_id on public.portfolio_items(user_id);
create index if not exists idx_portfolio_items_sold    on public.portfolio_items(user_id, sold);


-- ── price_history ─────────────────────────────────────────────────
-- Append-only log of market values scraped at refresh time.
-- Used to draw the portfolio & card-detail price charts.

create table if not exists public.price_history (
  id              bigint generated always as identity primary key,
  user_id         uuid not null references auth.users(id) on delete cascade,
  portfolio_item_id uuid not null references public.portfolio_items(id) on delete cascade,
  recorded_date   date not null,
  value_sgd       numeric(10,2) not null,
  created_at      timestamptz not null default now(),

  unique (portfolio_item_id, recorded_date)   -- one record per card per day
);

alter table public.price_history enable row level security;

create policy "Users can select own price history"
  on public.price_history for select using (auth.uid() = user_id);

create policy "Users can insert own price history"
  on public.price_history for insert with check (auth.uid() = user_id);

-- Index for fast chart queries
create index if not exists idx_price_history_item_date
  on public.price_history(portfolio_item_id, recorded_date);


-- ── MIGRATION NOTE ────────────────────────────────────────────────
-- If upgrading from v14, run only the ALTER statements below
-- instead of CREATE TABLE (the tables already exist):
--
-- alter table public.portfolio_items
--   add column if not exists sold       boolean not null default false,
--   add column if not exists sold_price numeric(10,2),
--   add column if not exists sold_date  date;
--
-- (sold, sold_price, sold_date were already present in v14 schema
--  so you likely only need to verify they exist — no action needed.)
