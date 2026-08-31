-- Mandate — remove policy domains
--
-- Domains let a merchant split rules into independently-governed zones. The
-- mechanism worked, but it earned its complexity only for a merchant who
-- actually runs several distinct kinds of agent spend, and it made the
-- product harder to explain for the far more common case: one agent, one
-- rule set. Routing that nothing routes differently is indirection with a
-- canvas on top.
--
-- Rules are now a single flat active set evaluated against every action, and
-- the evaluator no longer filters by domain. Dropping the column before the
-- table because policy_rules.domain_id references it.

alter table policy_rules drop column if exists domain_id;
alter table traces drop column if exists domain_id;
drop table if exists policy_domains;
