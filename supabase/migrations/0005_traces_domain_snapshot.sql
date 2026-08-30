-- Mandate — pin a trace's domain at decision time
--
-- Domain resolution (src/lib/policy/domains.ts) is content-based: an action's
-- domain is computed from its action_type/category against whichever
-- policy_domains rows exist *right now*. That's the right way to decide
-- which rules apply to a NEW action, but it made "which domain governed this
-- past transaction" a derived, current-config view rather than a historical
-- fact — editing a domain's routing later silently reclassified old traces
-- too, even though the rules that actually fired never changed.
--
-- This snapshots the resolved domain onto the trace itself, once, at
-- evaluation time (see runActionEvaluation in
-- src/lib/mcp/tools/actionEvaluator.ts) — same pattern as rule_fired_id.
-- Going forward, "what domain decided this" is an immutable historical
-- record. It stays nullable: protocol_reject and mandate-gate blocks never
-- reach domain resolution at all, so they legitimately have no domain.

alter table traces add column if not exists domain_id uuid references policy_domains(id);

-- Best-effort backfill for traces that predate this column: apply today's
-- routing once, retroactively. Same "first non-default match, else default"
-- shape as resolveDomain() — not a perfect replay of history (a trace's
-- domain may have already drifted under the old recompute-on-read behavior),
-- but better than leaving every existing transaction with no domain at all.
update traces t
set domain_id = d.id
from policy_domains d
where t.domain_id is null
  and d.is_default = false
  and (
    t.action_type = any(d.match_action_types)
    or (t.params ->> 'category') = any(d.match_categories)
  );

update traces t
set domain_id = d.id
from policy_domains d
where t.domain_id is null
  and d.is_default = true;
