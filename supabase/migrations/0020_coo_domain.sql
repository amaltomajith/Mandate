-- The COO domain: inventory economics, suppliers, quotes, purchase orders,
-- payouts, the sales/wallet ledger, channel conversations, agent runs,
-- encrypted connections and per-merchant guardrail settings.
--
-- Conventions, as everywhere else in this schema:
--   * every row carries merchant_id and cascades on merchant delete;
--   * RLS is enabled with no policies -- all access is the service-role key
--     (Clerk gates the dashboard, not Supabase auth);
--   * money is integer paise.
--
-- `payees` is the one table the agents must never be able to write. The service
-- role cannot tell callers apart, so this is enforced in application code (only
-- dashboard server actions touch it) and backstopped by a CHECK: a payee cannot
-- be `active` unless a human approval is recorded on it.

-- ── Products: unit economics and stock ──────────────────────────────────────
alter table products
  add column if not exists cost_price_paise integer check (cost_price_paise is null or cost_price_paise >= 0),
  add column if not exists stock_qty integer not null default 0 check (stock_qty >= 0),
  add column if not exists reorder_point integer not null default 0 check (reorder_point >= 0),
  add column if not exists lead_time_days integer not null default 7 check (lead_time_days >= 0),
  add column if not exists last_sold_at timestamptz;
comment on column products.cost_price_paise is
  'Landed unit cost. NULL means unknown, and the margin rule treats unknown as "escalate", never as "free".';

-- ── Agents: in-house kinds ──────────────────────────────────────────────────
alter table agents
  add column if not exists kind text not null default 'external' check (kind in ('selling', 'buying', 'external')),
  add column if not exists secret_key_enc text;
comment on column agents.secret_key_enc is
  'In-house agents only: Ed25519 secret key, AES-256-GCM encrypted with MANDATE_SECRET_KEY. Never returned to the browser.';
create unique index if not exists agents_one_inhouse_kind_per_merchant
  on agents (merchant_id, kind) where kind in ('selling', 'buying') and retired = false;

-- ── Policy: new rule types ──────────────────────────────────────────────────
alter table policy_rules drop constraint if exists policy_rules_type_check;
alter table policy_rules add constraint policy_rules_type_check
  check (type in ('cap', 'velocity', 'category_block', 'catalog_scope', 'step_up', 'trust_floor',
                  'whitelisted_payee', 'min_margin_floor', 'payout_budget'));

-- ── Vendors and payees ──────────────────────────────────────────────────────
create table if not exists vendors (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id) on delete cascade,
  name text not null,
  channel text not null default 'email' check (channel in ('email', 'whatsapp', 'sandbox')),
  email text,
  phone text,
  website text,
  status text not null default 'candidate' check (status in ('candidate', 'approved', 'blocked')),
  source text not null default 'manual' check (source in ('manual', 'research')),
  categories text[] not null default '{}',
  reliability numeric not null default 50 check (reliability between 0 and 100),
  notes text,
  simulated boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists vendors_merchant_idx on vendors (merchant_id);
create unique index if not exists vendors_merchant_name_key on vendors (merchant_id, lower(name));

create table if not exists payees (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id) on delete cascade,
  vendor_id uuid not null references vendors(id) on delete cascade,
  kind text not null check (kind in ('bank', 'upi')),
  display_name text not null,
  masked_identifier text not null,            -- e.g. "••••4821" or "ra••@okhdfc"; the full value lives only at Razorpay
  razorpay_contact_id text,
  razorpay_fund_account_id text,
  status text not null default 'pending' check (status in ('pending', 'active', 'revoked')),
  approved_by text,
  approved_at timestamptz,
  simulated boolean not null default false,
  created_at timestamptz not null default now(),
  constraint payees_active_needs_approval check (status <> 'active' or (approved_by is not null and approved_at is not null))
);
create index if not exists payees_merchant_idx on payees (merchant_id);
create index if not exists payees_vendor_idx on payees (vendor_id);

-- ── Agent runs ──────────────────────────────────────────────────────────────
create table if not exists agent_runs (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id) on delete cascade,
  agent_id uuid references agents(id) on delete set null,
  kind text not null check (kind in ('selling', 'buying')),
  status text not null default 'running' check (status in ('running', 'ok', 'error', 'halted')),
  dry_run boolean not null default false,
  summary text,
  steps jsonb not null default '[]'::jsonb,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists agent_runs_merchant_idx on agent_runs (merchant_id, started_at desc);
-- At most one live run per merchant and agent kind: the scheduler's lock.
create unique index if not exists agent_runs_one_running on agent_runs (merchant_id, kind) where status = 'running';

-- ── Conversations ───────────────────────────────────────────────────────────
create table if not exists threads (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id) on delete cascade,
  channel text not null check (channel in ('email', 'whatsapp', 'sandbox')),
  kind text not null check (kind in ('vendor', 'buyer')),
  counterparty text not null,                 -- email address or phone
  external_thread_id text,
  vendor_id uuid references vendors(id) on delete set null,
  customer_id uuid references customers(id) on delete set null,
  subject text,
  status text not null default 'open' check (status in ('open', 'closed')),
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists threads_merchant_idx on threads (merchant_id, last_message_at desc);
create unique index if not exists threads_external_key on threads (merchant_id, channel, external_thread_id) where external_thread_id is not null;

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id) on delete cascade,
  thread_id uuid not null references threads(id) on delete cascade,
  direction text not null check (direction in ('in', 'out')),
  body text not null,
  external_id text,
  -- Inbound text is written by someone else and is data, never instruction.
  untrusted boolean not null default true,
  agent_run_id uuid references agent_runs(id) on delete set null,
  simulated boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists messages_thread_idx on messages (thread_id, created_at);
create unique index if not exists messages_external_key on messages (merchant_id, thread_id, external_id) where external_id is not null;

-- ── Quotes and purchase orders ──────────────────────────────────────────────
create table if not exists quotes (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id) on delete cascade,
  vendor_id uuid not null references vendors(id) on delete cascade,
  product_id uuid references products(id) on delete set null,
  thread_id uuid references threads(id) on delete set null,
  unit_price_paise integer not null check (unit_price_paise > 0),
  moq integer not null default 1 check (moq > 0),
  lead_time_days integer check (lead_time_days is null or lead_time_days >= 0),
  valid_until timestamptz,
  raw_excerpt text,                           -- the vendor's own words the numbers were parsed from
  status text not null default 'open' check (status in ('open', 'accepted', 'expired', 'rejected')),
  created_at timestamptz not null default now()
);
create index if not exists quotes_merchant_idx on quotes (merchant_id, created_at desc);

create table if not exists purchase_orders (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id) on delete cascade,
  vendor_id uuid not null references vendors(id) on delete restrict,
  payee_id uuid references payees(id) on delete set null,
  quote_id uuid references quotes(id) on delete set null,
  agent_id uuid references agents(id) on delete set null,
  status text not null default 'draft' check (status in
    ('draft', 'quoting', 'awaiting_approval', 'approved', 'paid', 'received', 'cancelled')),
  total_paise bigint not null default 0 check (total_paise >= 0),
  advance_paise bigint not null default 0 check (advance_paise >= 0),
  currency text not null default 'INR',
  rationale text,
  expected_at timestamptz,
  received_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists purchase_orders_merchant_idx on purchase_orders (merchant_id, created_at desc);

create table if not exists po_lines (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id) on delete cascade,
  po_id uuid not null references purchase_orders(id) on delete cascade,
  product_id uuid not null references products(id) on delete restrict,
  qty integer not null check (qty > 0),
  unit_price_paise integer not null check (unit_price_paise > 0)
);
create index if not exists po_lines_po_idx on po_lines (po_id);

-- ── Money ledger ────────────────────────────────────────────────────────────
create table if not exists payouts (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id) on delete cascade,
  po_id uuid references purchase_orders(id) on delete set null,
  payee_id uuid references payees(id) on delete set null,
  trace_id uuid references traces(id) on delete set null,
  amount_paise bigint not null check (amount_paise > 0),
  status text not null default 'queued' check (status in ('queued', 'processing', 'processed', 'failed', 'reversed')),
  razorpay_payout_id text,
  simulated boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists payouts_merchant_idx on payouts (merchant_id, created_at desc);
create unique index if not exists payouts_trace_key on payouts (trace_id) where trace_id is not null;

create table if not exists sales (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id) on delete cascade,
  product_id uuid references products(id) on delete set null,
  qty integer not null default 1 check (qty > 0),
  amount_paise bigint not null check (amount_paise >= 0),
  source text not null default 'payment_link' check (source in ('payment_link', 'order', 'manual')),
  razorpay_payment_id text,
  razorpay_order_id text,
  captured_at timestamptz not null default now()
);
create index if not exists sales_merchant_idx on sales (merchant_id, captured_at desc);
create unique index if not exists sales_payment_key on sales (merchant_id, razorpay_payment_id) where razorpay_payment_id is not null;

create table if not exists wallet_entries (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id) on delete cascade,
  direction text not null check (direction in ('credit', 'debit')),
  amount_paise bigint not null check (amount_paise > 0),
  kind text not null check (kind in ('sale', 'payout', 'refund', 'float', 'adjustment')),
  ref_type text,
  ref_id uuid,
  note text,
  simulated boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists wallet_entries_merchant_idx on wallet_entries (merchant_id, created_at desc);

-- Razorpay delivers webhooks at least once; the event id makes handling idempotent.
create table if not exists webhook_events (
  id text primary key,
  merchant_id uuid references merchants(id) on delete cascade,
  event text not null,
  received_at timestamptz not null default now()
);

-- ── Connections and settings ────────────────────────────────────────────────
create table if not exists connections (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id) on delete cascade,
  kind text not null check (kind in ('gmail', 'whatsapp', 'razorpay', 'razorpayx', 'search')),
  status text not null default 'pending' check (status in ('pending', 'connected', 'error', 'disconnected')),
  account_label text,                         -- e.g. the connected Gmail address; safe to show
  secret_enc text,                            -- encrypted blob; never selected into client code
  meta jsonb not null default '{}'::jsonb,    -- non-secret state (e.g. the pending WhatsApp QR)
  updated_at timestamptz not null default now(),
  unique (merchant_id, kind)
);

create table if not exists merchant_settings (
  merchant_id uuid primary key references merchants(id) on delete cascade,
  max_single_payout_paise bigint not null default 5000000 check (max_single_payout_paise > 0),
  approval_threshold_paise bigint not null default 1000000 check (approval_threshold_paise > 0),
  min_margin_bps integer not null default 1500 check (min_margin_bps between 0 and 9000),
  weekly_payout_budget_paise bigint not null default 10000000 check (weekly_payout_budget_paise >= 0),
  payout_budget_pct integer not null default 70 check (payout_budget_pct between 0 and 100),
  require_approved_vendors boolean not null default true,
  agents_enabled boolean not null default true,
  dry_run boolean not null default false,
  channel_mode text not null default 'sandbox' check (channel_mode in ('sandbox', 'live')),
  whatsapp_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

-- ── Derived: per-product sales velocity ─────────────────────────────────────
create or replace view product_stats with (security_invoker = true) as
select
  p.id as product_id,
  p.merchant_id,
  coalesce(sum(s.qty) filter (where s.captured_at > now() - interval '14 days'), 0)::int as units_14d,
  coalesce(sum(s.qty) filter (where s.captured_at > now() - interval '30 days'), 0)::int as units_30d,
  coalesce(sum(s.amount_paise) filter (where s.captured_at > now() - interval '30 days'), 0)::bigint as revenue_30d_paise,
  max(s.captured_at) as last_sale_at
from products p
left join sales s on s.product_id = p.id
group by p.id, p.merchant_id;

-- ── RLS: enabled, no policies (service role only) ───────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'vendors', 'payees', 'threads', 'messages', 'agent_runs', 'quotes',
    'purchase_orders', 'po_lines', 'payouts', 'sales', 'wallet_entries',
    'webhook_events', 'connections', 'merchant_settings'
  ] loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;
