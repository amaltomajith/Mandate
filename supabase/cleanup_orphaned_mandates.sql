-- Mandate — remove mandates that authorize nobody
--
-- Not a schema migration; a one-off data cleanup, safe to skip and safe to
-- re-run.
--
-- `mandates.agent_id` is declared `on delete set null`, so removing the
-- duplicate simulated agents (supabase/cleanup_duplicate_agents.sql) left
-- their mandates behind with no agent attached.
--
-- A mandate authorizes ONE agent to act for ONE customer. With no agent it
-- authorizes nobody: checkMandateGate looks a mandate up by
-- (agent_id, customer_id) and can never match one of these, so it gates
-- nothing. They are inert rows that still read as "active" in the UI, which is
-- worse than absent — the Mandates tab implies an authorization exists and the
-- entity graph drew them as unowned nodes floating away from any agent.
--
-- Nothing references mandates, so no cascade is involved.

begin;

delete from mandates where agent_id is null;

commit;

-- Every remaining mandate should name a real agent.
select m.status, a.name as agent, c.name as customer
from mandates m
join agents a on a.id = m.agent_id
left join customers c on c.id = m.customer_id
order by m.status, c.name;
