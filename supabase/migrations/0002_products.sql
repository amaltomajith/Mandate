-- Mandate — product catalog
-- A real merchant catalog, not a hardcoded fixture: the demo agent reasons
-- over this table (via an LLM call, see src/lib/demo/crossSell.ts) to decide
-- what to cross-sell, instead of a static pairing map. Small on purpose — see
-- HANDOVER.md's note on why this doesn't use vector/embedding retrieval yet.

create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  sku text not null,
  name text not null,
  description text not null,
  price_paise integer not null check (price_paise > 0),
  category text not null,
  created_at timestamptz not null default now()
);
create unique index if not exists products_sku_key on products (sku);

alter table products enable row level security;
create policy "authenticated read products" on products for select to authenticated using (true);
-- Writes go through the service-role client only, same as every other table
-- — see migration 0001's note; Clerk gates the dashboard routes now, not
-- Supabase RLS (HANDOVER.md §5b).
