-- Mandate — initial schema
-- Entities: agents, mandates, customers, policy_rules, traces, escalations, alerts

create extension if not exists "pgcrypto";

create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text,
  razorpay_contact_id text,
  created_at timestamptz not null default now()
);

create table if not exists agents (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  public_key text not null,                -- base64 raw Ed25519 public key
  key_algorithm text not null default 'ed25519',
  key_registered_at timestamptz not null default now(),
  trust_score numeric not null default 50,
  trust_components jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create unique index if not exists agents_name_key on agents (name);

create table if not exists mandates (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references agents(id) on delete set null,
  customer_id uuid references customers(id) on delete set null,
  type text not null check (type in ('upi_autopay', 'ap2_style')),
  status text not null default 'active' check (status in ('active', 'paused', 'revoked', 'expired')),
  raw_payload jsonb not null default '{}'::jsonb,
  razorpay_ref text,
  created_at timestamptz not null default now()
);

create table if not exists policy_rules (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('cap', 'velocity', 'category_block', 'step_up')),
  name text not null,
  params jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active', 'pending_review', 'rejected', 'superseded')),
  source text not null default 'human' check (source in ('human', 'horizon')),
  rationale text,
  superseded_by uuid references policy_rules(id),
  created_at timestamptz not null default now(),
  created_by text
);

create table if not exists traces (
  id uuid primary key default gen_random_uuid(),
  parent_trace_id uuid references traces(id) on delete set null,
  mode text not null check (mode in ('simulate', 'enforce')),
  action_type text not null,               -- e.g. 'payment.capture', 'refund.create', 'payout.create'
  params jsonb not null default '{}'::jsonb,
  agent_id uuid references agents(id) on delete set null,
  decision text not null check (decision in ('allow', 'block', 'escalate', 'protocol_reject')),
  rule_fired_id uuid references policy_rules(id),
  reasoning text,
  razorpay_response jsonb,
  created_at timestamptz not null default now()
);
create index if not exists traces_agent_id_idx on traces (agent_id);
create index if not exists traces_parent_trace_id_idx on traces (parent_trace_id);
create index if not exists traces_created_at_idx on traces (created_at desc);

create table if not exists escalations (
  id uuid primary key default gen_random_uuid(),
  trace_id uuid not null references traces(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  resolved_by text,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists escalations_status_idx on escalations (status);

create table if not exists alerts (
  id uuid primary key default gen_random_uuid(),
  trace_id uuid references traces(id) on delete cascade,
  severity text not null check (severity in ('info', 'notable', 'high')),
  message text not null,
  created_at timestamptz not null default now()
);

-- Row Level Security: dashboard reads via authenticated session, all writes via service role only.
alter table customers enable row level security;
alter table agents enable row level security;
alter table mandates enable row level security;
alter table policy_rules enable row level security;
alter table traces enable row level security;
alter table escalations enable row level security;
alter table alerts enable row level security;

create policy "authenticated read customers" on customers for select to authenticated using (true);
create policy "authenticated read agents" on agents for select to authenticated using (true);
create policy "authenticated read mandates" on mandates for select to authenticated using (true);
create policy "authenticated read policy_rules" on policy_rules for select to authenticated using (true);
create policy "authenticated read traces" on traces for select to authenticated using (true);
create policy "authenticated read escalations" on escalations for select to authenticated using (true);
create policy "authenticated read alerts" on alerts for select to authenticated using (true);

-- Writes go through the service role key from server-side routes only (MCP server, dashboard
-- server actions for approvals). No insert/update/delete policies are granted to `authenticated`
-- or `anon` — the service role bypasses RLS by design.

-- Realtime: the dashboard subscribes to these so the graph and panels update live
-- as agents act, without a polling loop.
alter publication supabase_realtime add table agents, traces, escalations, alerts, policy_rules;
