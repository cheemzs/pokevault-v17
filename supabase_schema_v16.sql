-- ═══════════════════════════════════════════════════════════════════
--  PokéVault v16 — Supabase Schema
--  Run this in: Supabase Dashboard → SQL Editor → New Query
--
--  NEW in v16:
--    • trade_analyses table — stores saved trade evaluations
-- ═══════════════════════════════════════════════════════════════════

-- ── profiles ──────────────────────────────────────────────────────
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
create table if not exists public.portfolio_items (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,

  item_id             text not null,
  type                text not null,          -- 'card' | 'sealed'
  name                text not null,
  set_name            text,
  image_url           text,
  language            text not null default 'english',

  purchase_price      numeric(10,2) not null,
  quantity            integer not null default 1,
  condition_or_grade  text not null default 'Near Mint',
  notes               text,

  current_value       numeric(10,2),
  last_value_updated  timestamptz,

  sold                boolean not null default false,
  sold_price          numeric(10,2),
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

create index if not exists idx_portfolio_items_user_id on public.portfolio_items(user_id);
create index if not exists idx_portfolio_items_sold    on public.portfolio_items(user_id, sold);


-- ── price_history ─────────────────────────────────────────────────
create table if not exists public.price_history (
  id                bigint generated always as identity primary key,
  user_id           uuid not null references auth.users(id) on delete cascade,
  portfolio_item_id uuid not null references public.portfolio_items(id) on delete cascade,
  recorded_date     date not null,
  value_sgd         numeric(10,2) not null,
  created_at        timestamptz not null default now(),

  unique (portfolio_item_id, recorded_date)
);

alter table public.price_history enable row level security;

create policy "Users can select own price history"
  on public.price_history for select using (auth.uid() = user_id);

create policy "Users can insert own price history"
  on public.price_history for insert with check (auth.uid() = user_id);

create index if not exists idx_price_history_item_date
  on public.price_history(portfolio_item_id, recorded_date);


-- ── trade_analyses  (NEW v16) ─────────────────────────────────────
-- Stores the user's saved trade evaluations.
-- my_items / their_items are JSON arrays of { name, value_sgd, image_url? }
-- cash_direction: 'i_pay' | 'they_pay' | null
-- verdict: 'fair' | 'advantage_me' | 'advantage_them'

create table if not exists public.trade_analyses (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,

  my_items        jsonb not null default '[]',
  their_items     jsonb not null default '[]',
  my_total_sgd    numeric(10,2) not null,
  their_total_sgd numeric(10,2) not null,

  cash_direction  text,                       -- 'i_pay' | 'they_pay' | null
  cash_amount_sgd numeric(10,2),

  diff_pct        numeric(6,2) not null,      -- absolute % difference
  verdict         text not null,              -- 'fair' | 'advantage_me' | 'advantage_them'

  created_at      timestamptz not null default now()
);

alter table public.trade_analyses enable row level security;

create policy "Users can select own trade analyses"
  on public.trade_analyses for select using (auth.uid() = user_id);

create policy "Users can insert own trade analyses"
  on public.trade_analyses for insert with check (auth.uid() = user_id);

create policy "Users can delete own trade analyses"
  on public.trade_analyses for delete using (auth.uid() = user_id);

create index if not exists idx_trade_analyses_user_id
  on public.trade_analyses(user_id, created_at desc);


-- ── MIGRATION NOTE (upgrading from v15) ───────────────────────────
-- If your v15 tables already exist, run ONLY:
--
--   CREATE TABLE IF NOT EXISTS public.trade_analyses ( ... );  -- (the block above)
--
-- Everything else is unchanged from v15.
