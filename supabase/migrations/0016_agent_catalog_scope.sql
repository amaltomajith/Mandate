-- Per-agent catalog scope: which parts of the catalog an agent may transact.
--
-- The scope lives on the AGENT, not on the rule. This mirrors trust_floor
-- exactly -- one global merchant rule whose input is a per-agent fact -- and it
-- is deliberate. Handover section 17 records that merchant-defined per-rule
-- targeting was built and then removed, because it amounted to a hardcoded
-- string match wearing a nicer coat. Rules stay global per merchant; what
-- varies per agent is the data the rule reads.
--
-- NULL means the full catalog, and every existing agent gets NULL, so nothing
-- already running changes meaning.
--
-- An EMPTY array is meaningful and different: it means this agent may transact
-- nothing. That is a real thing a merchant might want (a newly registered agent
-- held at arm's length until it is configured), so it is allowed rather than
-- coerced to NULL -- but the UI has to say which of the two it is showing,
-- because "no categories listed" reads identically for both and they are
-- opposites.
alter table agents
  add column if not exists catalog_scope text[];

comment on column agents.catalog_scope is
  'Categories this agent may transact. NULL = the full catalog (the default, and what every agent had before this column). An EMPTY array = nothing at all, which is a deliberate state, not an unset one. Read by the catalog_scope policy rule; the engine itself never touches the database.';

-- The vocabulary is closed for a reason, and this is where it stops being a
-- convention and starts being enforced. `category_block` and `catalog_scope`
-- both match category strings EXACTLY -- a scope naming "electronic" would
-- match no product at all and silently behave as if the agent were scoped to
-- nothing. Rejecting it here means that typo is a constraint violation the
-- merchant sees, not a permission boundary that quietly moves.
--
-- `<@` is array containment: every element of catalog_scope must appear in the
-- allowed set. It is true for the empty array, which is what we want -- empty
-- is legal and means nothing is permitted.
alter table agents
  drop constraint if exists agents_catalog_scope_known_categories;
alter table agents
  add constraint agents_catalog_scope_known_categories
  check (
    catalog_scope is null
    or catalog_scope <@ array['electronics','office','fitness','furniture','apparel','gambling','crypto']::text[]
  );
