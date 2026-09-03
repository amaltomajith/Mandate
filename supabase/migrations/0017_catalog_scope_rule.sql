-- The `catalog_scope` rule type.
--
-- Separate from 0016 (which added agents.catalog_scope) because they enable
-- different things: 0016 is inert data, this is what makes the engine able to
-- act on it. Splitting them keeps rollback cheap -- dropping this constraint
-- change disables the rule everywhere without touching any agent's assigned
-- scope, so re-enabling loses nothing.
--
-- The rule itself carries no categories. It is one merchant-wide statement --
-- "agents are held to their assigned catalog" -- and the scope it compares
-- against lives on each agent. That is the same shape as trust_floor, which
-- states a threshold while the score lives on the agent, and it is deliberate:
-- putting categories on the rule would mean one rule per agent, which is
-- per-rule targeting under another name. Built once, removed once, recorded in
-- handover section 17.
alter table policy_rules drop constraint if exists policy_rules_type_check;
alter table policy_rules add constraint policy_rules_type_check
  check (type in ('cap', 'velocity', 'category_block', 'catalog_scope', 'step_up', 'trust_floor'));
