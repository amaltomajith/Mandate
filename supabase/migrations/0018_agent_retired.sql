-- Retire an agent without destroying what it did.
--
-- WHY NOT `agents.status`. That column already exists and is `active | paused`,
-- and it is the COOPERATIVE channel: an agent polls /agent-control, reads it,
-- and a well-behaved one complies. Nothing is enforced by it. Retirement is the
-- opposite kind of thing -- the key stops verifying, so requests are refused at
-- the protocol layer before any policy runs, whether the agent cooperates or
-- not.
--
-- Folding an enforced state into the cooperative field would put a merchant
-- reaching for "stop" in the position of not knowing which of the two they just
-- got, which is the exact conflation the Agents panel is built to keep apart.
-- Two different guarantees, two different columns.
--
-- RETIRE, DO NOT DELETE, for the same reason products are retired rather than
-- deleted: traces carry `agent_id`, and the audit trail is the product.
-- Deleting an agent row to tidy a roster would leave every trace it ever
-- produced pointing at nobody -- or, with a cascade, would delete the record of
-- money that genuinely moved. Neither is a rename of history; both are a loss
-- of it. Hard delete stays available in the one case where it is safe: an agent
-- with no traces at all.
alter table agents
  add column if not exists retired boolean not null default false;

comment on column agents.retired is
  'True removes the agent from the roster and the entity graph, and stops its key verifying (requests refused as protocol_reject before any policy runs). Its past traces still resolve to its name -- retirement hides the agent, never its history. Distinct from `status`, which is the cooperative pause an agent polls for and may ignore; this one is enforced.';

-- Every key lookup in the verification path filters on this, so it is worth an
-- index: it is read on the hot path of every signed request.
create index if not exists agents_merchant_retired_idx
  on agents (merchant_id, retired);
