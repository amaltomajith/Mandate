-- Mandate — cooperative agent control
--
-- Two pauses, and the difference between them is the whole point of this
-- migration existing separately from the mandate system.
--
--   MANDATE pause/revoke   ENFORCEMENT. Runs inside the request path, before
--                          the policy engine. Survives a hostile agent, because
--                          the agent's compliance is not required.
--
--   AGENT pause (here)     COOPERATION. The agent asks whether it should be
--                          working and complies. It saves the agent's tokens
--                          and keeps the merchant's trace log clean. It is NOT
--                          security, and nothing in this schema pretends it is.
--
-- `status` is therefore deliberately NOT read anywhere in the MCP request path.
-- An earlier version of this did read it there, refusing a paused agent's calls
-- at the evaluator, and that was wrong in a way worth recording: a refused agent
-- keeps calling. It burns its model tokens on decisions that cannot land, floods
-- the trace log with refusals, and those refusals are enforce-mode traces --
-- which means they consume the agent's velocity budget in getAggregates. Pausing
-- an agent would have quietly rate-limited it. That is the trust trapdoor from
-- the handover's section 6 in a new costume: a control that punishes the thing
-- it was meant to protect.
--
-- The only reader of `status` is /api/m/<slug>/agent-control, which an agent
-- polls to ask whether to work. Enforcement, when it is needed, is what mandates
-- are for.

alter table agents
  add column if not exists status text not null default 'active';

alter table agents drop constraint if exists agents_status_check;
alter table agents add constraint agents_status_check
  check (status in ('active', 'paused'));

-- How long the merchant would like this agent to wait between actions. A
-- request, not a limit: velocity rules are the limit, and they are enforced.
-- This exists so a well-behaved agent can be slowed down without being refused,
-- which is a different and much cheaper thing than rate-limiting it.
alter table agents
  add column if not exists pace_ms integer not null default 30000;

alter table agents drop constraint if exists agents_pace_check;
alter table agents add constraint agents_pace_check
  check (pace_ms >= 0 and pace_ms <= 3600000);

-- What the agent is for, in the merchant's words. Shown on the Agents page and
-- exported with an agent's definition; never a key.
alter table agents
  add column if not exists persona text;

alter table agents
  add column if not exists endpoint_url text;

create index if not exists agents_status_idx on agents (merchant_id, status);
