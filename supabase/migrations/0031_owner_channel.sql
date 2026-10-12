-- The owner on WhatsApp: a daily briefing, and approving a held payout by replying
-- with a short one-time code. Everything the owner is sent is recorded in
-- owner_messages; in sandbox mode it stays there (undelivered) and is shown in the
-- dashboard, so nothing real is messaged until the merchant goes live.

alter table merchant_settings
  add column if not exists owner_phone text,
  add column if not exists owner_approvals_enabled boolean not null default false,
  add column if not exists owner_approval_max_paise bigint not null default 1000000 check (owner_approval_max_paise > 0),
  add column if not exists owner_briefing_enabled boolean not null default false,
  add column if not exists owner_briefing_sent_on date;

-- One row per code sent. Only a hash of the code is kept. A code is for one
-- escalation, expires, and can be used once.
create table if not exists owner_approvals (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id) on delete cascade,
  escalation_id uuid not null references escalations(id) on delete cascade,
  code_hash text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
-- At most one live code per escalation, and no two live codes the same for a merchant.
create unique index if not exists owner_approvals_one_open on owner_approvals (escalation_id) where used_at is null;
create unique index if not exists owner_approvals_code_open on owner_approvals (merchant_id, code_hash) where used_at is null;

-- Wrong guesses, for locking out guessing.
create table if not exists owner_attempts (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists owner_attempts_idx on owner_attempts (merchant_id, created_at desc);

create table if not exists owner_messages (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id) on delete cascade,
  kind text not null check (kind in ('briefing', 'approval', 'reply')),
  body text not null,
  escalation_id uuid references escalations(id) on delete set null,
  delivered boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists owner_messages_idx on owner_messages (merchant_id, created_at desc);

alter table owner_approvals enable row level security;
alter table owner_attempts enable row level security;
alter table owner_messages enable row level security;
