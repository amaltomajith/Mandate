-- Mandate — per-merchant scoping
--
-- Until now every table was global. Two people signing in with different Clerk
-- accounts saw the same traces, the same agents, the same policy rules. That is
-- fine for one person demoing on one laptop and wrong for anything anyone else
-- can clone and run, which is what a handover has to survive.
--
-- The tenancy key is the merchant. What makes it work cleanly here is that the
-- agent is already the bridge: an MCP request proves which agent sent it by
-- verifying an Ed25519 signature against `agents.public_key`, so the tenant is
-- resolved from cryptography rather than from a field in a request body that a
-- caller could simply set to someone else's id. There is no code path where an
-- agent can claim a merchant it does not belong to.
--
-- `merchant_id` is NOT NULL everywhere on purpose. A nullable tenant column is
-- an invitation to write a row that belongs to nobody and then show up in every
-- tenant's queries or none of them; making it required means a query that
-- forgets to set it fails loudly at insert time rather than leaking quietly at
-- read time.
--
-- Cascade on delete, also on purpose: removing a merchant must not leave
-- traces, mandates or campaign targets behind referencing a tenant that no
-- longer exists.

create table if not exists merchants (
  id uuid primary key default gen_random_uuid(),
  -- Null means unclaimed. The bootstrap merchant below starts unclaimed so the
  -- data that predates this migration is not silently handed to whoever signs
  -- in first -- see src/lib/merchant.ts for the deliberate, env-gated claim.
  clerk_user_id text unique,
  name text not null,
  -- Used in public URLs (/api/m/<slug>/catalog), so it is the merchant's
  -- externally visible identity and has to be unique across the instance.
  slug text unique not null,
  created_at timestamptz not null default now()
);

alter table merchants enable row level security;

-- Everything that exists today belongs to one merchant.
insert into merchants (name, slug)
select 'Demo Storefront', 'demo'
where not exists (select 1 from merchants where slug = 'demo');

do $$
declare
  demo_id uuid;
  t text;
begin
  select id into demo_id from merchants where slug = 'demo';

  foreach t in array array[
    'agents', 'policy_rules', 'customers', 'products', 'traces',
    'mandates', 'escalations', 'alerts', 'campaigns', 'campaign_targets'
  ]
  loop
    -- Added nullable, backfilled, then made required. Adding a NOT NULL column
    -- to a table with rows in it would fail outright.
    execute format('alter table %I add column if not exists merchant_id uuid references merchants(id) on delete cascade', t);
    execute format('update %I set merchant_id = $1 where merchant_id is null', t) using demo_id;
    execute format('alter table %I alter column merchant_id set not null', t);
    execute format('create index if not exists %I on %I (merchant_id)', t || '_merchant_idx', t);
  end loop;
end $$;

-- Uniqueness was global and would collide the moment a second merchant
-- existed: two shops cannot both stock a "mouse-01", and two merchants cannot
-- both name an agent "Checkout Agent". Both become per-merchant.
drop index if exists products_sku_key;
create unique index if not exists products_merchant_sku_key on products (merchant_id, sku);

drop index if exists agents_name_key;
create unique index if not exists agents_merchant_name_key on agents (merchant_id, name);

-- Campaign targets already guarantee one offer per customer per campaign, and
-- a campaign belongs to exactly one merchant, so that constraint stays correct
-- as written. Noted so its absence here reads as deliberate.
