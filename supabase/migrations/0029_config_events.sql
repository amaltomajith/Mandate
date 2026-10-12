-- Who changed what, and when, on the settings that stand between the agents and
-- the merchant's money: guardrail limits, the team switch, dry run, sandbox/live,
-- payout mode. Append-only; written by the dashboard's server actions.
create table if not exists config_events (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id) on delete cascade,
  actor text not null,
  field text not null,
  old_value text,
  new_value text,
  created_at timestamptz not null default now()
);
create index if not exists config_events_merchant_idx on config_events (merchant_id, created_at desc);
alter table config_events enable row level security;
