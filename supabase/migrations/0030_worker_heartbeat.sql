-- A run proves it is alive by beating, instead of being presumed dead after a fixed
-- time: a legitimately slow run (several model calls) is no longer reaped, and a
-- crashed one is noticed in minutes rather than after the old ten-minute guess.
alter table agent_runs add column if not exists heartbeat_at timestamptz;

-- The worker's own pulse, so the dashboard can say "the worker is not running"
-- even when no agent has any reason to run (team off, nothing to do).
create table if not exists worker_status (
  id text primary key,
  beat_at timestamptz not null default now(),
  info jsonb not null default '{}'::jsonb
);
alter table worker_status enable row level security;
