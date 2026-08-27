-- Mandate — policy domains
-- Generalizes the policy engine from one implicit domain into merchant-
-- defined ones: each domain is a real row (name, description, routing
-- rules, canvas position), not a hardcoded list in application code. A
-- merchant can add a domain for any category their agents transact in
-- (e.g. "Logistics" for order.create/payout.create tagged category
-- "logistics") and give it its own independent policy rules.

create table if not exists policy_domains (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  -- Routing: an action belongs to this domain if its action_type is in
  -- match_action_types OR its category is in match_categories. Both empty
  -- + is_default true = the catch-all domain every merchant needs one of.
  match_action_types text[] not null default '{}',
  match_categories text[] not null default '{}',
  is_default boolean not null default false,
  position_x numeric not null default 0,
  position_y numeric not null default 0,
  color text not null default '#4f9dff',
  created_at timestamptz not null default now()
);
create unique index if not exists policy_domains_name_key on policy_domains (name);

-- Only one default (catch-all) domain makes sense — partial unique index
-- rather than a check constraint, since "at most one true" isn't expressible
-- as a simple column check.
create unique index if not exists policy_domains_single_default
  on policy_domains ((is_default)) where is_default;

alter table policy_rules add column if not exists domain_id uuid references policy_domains(id);

alter table policy_domains enable row level security;
create policy "authenticated read policy_domains" on policy_domains for select to authenticated using (true);
