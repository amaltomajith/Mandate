-- Mandate — pausing an agent
--
-- Mandates are per agent-and-customer, which is the right granularity for
-- "this customer withdrew their authorization" and the wrong one for the thing
-- a merchant actually wants during an incident: make this agent stop, now,
-- everywhere. Without it the only lever is revoking each mandate one at a time,
-- and revoke is deliberately terminal -- so the merchant's options were a
-- tedious loop or an irreversible one.
--
-- Reversible on purpose, and gated before everything else. A paused agent is
-- not misbehaving, it is stopped, so the check belongs above the mandate gate
-- rather than beside the spend rules: "not authorized at all right now" should
-- short-circuit questions about amounts.
--
-- The trust score deliberately does NOT count the refusals this produces. Every
-- action a paused agent attempts would otherwise be a block, blocks cost trust,
-- and an agent paused for an afternoon would come back below the trust floor --
-- held by a rule, generating escalations, for having been paused. That is the
-- same one-way trapdoor the escalation weight had (see the trust section of the
-- handover), arrived at from a different direction.

alter table agents
  add column if not exists status text not null default 'active';

alter table agents drop constraint if exists agents_status_check;
alter table agents add constraint agents_status_check
  check (status in ('active', 'paused'));

create index if not exists agents_status_idx on agents (merchant_id, status);
