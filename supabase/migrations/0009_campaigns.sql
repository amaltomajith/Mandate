-- Mandate — campaigns: the agent going out to find revenue
--
-- Cross-sell is reactive. It waits for a purchase and increases its size. That
-- is real revenue but it is bounded by traffic the merchant already had. A
-- campaign is the other direction: pick customers out of the order history,
-- decide an offer, and create the money action that might bring them back.
--
-- Which is also the reason it belongs in *this* project rather than beside it.
-- A discount is money given away. An agent running a campaign is spending the
-- merchant's money, unattended, across hundreds of customers, and every one of
-- those sends is exactly the kind of action Mandate exists to bound. The
-- guardrails need no new concepts: a `cap` on discount exposure, a
-- `per_customer` velocity rule so nobody is contacted repeatedly, a `step_up`
-- so a discount past some size needs a human. All of it lands in the same
-- audit trail as everything else.
--
-- Two deliberate choices in the shape below.
--
-- There is no `spent_paise` column. Committed discount is derived by summing
-- the targets, the same reasoning as `totalExecuted` in src/lib/revenue.ts: a
-- stored total is a second source of truth that drifts the first time an
-- update fails halfway, and a budget figure that has drifted is worse than no
-- budget figure.
--
-- `unique (campaign_id, customer_id)` puts "one offer per customer per
-- campaign" in the database rather than in the orchestrator loop. It is the
-- guarantee a customer would most notice the absence of, and enforcing it in
-- code alone means a retry or a double-click can break it.

create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  -- What the merchant asked for, in their own words. Kept alongside the
  -- machine-readable offer so a campaign can always be explained as the thing
  -- someone actually requested, not only as the parameters it became.
  goal text not null,
  -- { discount_pct, sku | null, segment: { ... } } — the offer and who it is
  -- for, as resolved when the campaign was created.
  plan jsonb not null default '{}'::jsonb,
  -- Ceiling on *discount given away*, not on link value. The giveaway is the
  -- merchant's money; the link value is the customer's.
  budget_paise bigint not null check (budget_paise > 0),
  status text not null default 'draft'
    check (status in ('draft', 'running', 'paused', 'done')),
  agent_id uuid references agents(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists campaign_targets (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  customer_id uuid references customers(id) on delete set null,
  -- The governed action this target produced. Null when policy refused it
  -- before anything was created, which is itself worth recording: a campaign
  -- that was stopped by its own budget cap should show that, not show nothing.
  trace_id uuid references traces(id) on delete set null,
  payment_link_id text,
  payment_link_url text,
  -- pending: chosen, not yet acted on. offered: link created. paid/expired:
  -- read back from Razorpay. refused: policy said no. held: escalated.
  status text not null default 'pending'
    check (status in ('pending', 'offered', 'paid', 'expired', 'refused', 'held')),
  amount_paise bigint not null,
  discount_paise bigint not null default 0,
  created_at timestamptz not null default now(),
  unique (campaign_id, customer_id)
);

create index if not exists campaign_targets_campaign_idx on campaign_targets (campaign_id);
create index if not exists campaign_targets_status_idx on campaign_targets (status);

-- Traces already accept any action_type (it is plain text, deliberately, so a
-- new action never needs a migration to be recordable). Nothing to alter here
-- for payment_link.create — noted so the absence reads as a decision rather
-- than an oversight.
