-- Mandate — consolidate onto a single simulated agent
--
-- Not a schema migration; a one-off data cleanup, safe to skip if the roster
-- already looks right.
--
-- Mandate never stores an agent's secret key, so an agent whose identity isn't
-- pinned in the environment cannot be signed as again — every process that
-- needed one registered a fresh row. Over a few runs that produced a roster of
-- near-duplicate "Checkout Agent (hh:mm:ss)" entries plus the retired
-- "Background Traffic Bot", none of which can ever act again.
--
-- Fixed properly by pinning SIM_AGENT_ID / SIM_AGENT_SECRET_KEY in .env.local,
-- which makes every run reuse one identity. This clears up what accumulated
-- before that.
--
-- Deletes their traces too, rather than letting `on delete set null` orphan
-- them: a trace whose agent no longer exists is unattributable, and an
-- unattributable row in an audit log is worse than no row. Escalations and
-- alerts cascade from traces automatically.

begin;

create temporary table _defunct_agents on commit drop as
select id
from agents
where name like 'Checkout Agent (%'      -- timestamp-suffixed duplicates
   or name like 'Background Traffic Bot%' -- the retired second agent
;

delete from traces where agent_id in (select id from _defunct_agents);
delete from agents where id in (select id from _defunct_agents);

commit;

-- Expect exactly one agent left, "Checkout Agent", with its history intact.
select name, trust_score from agents order by name;
