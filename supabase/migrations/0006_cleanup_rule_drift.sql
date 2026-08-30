-- Mandate — clear out accumulated experiment drift
--
-- Live inspection found the rule set had drifted well away from the seed
-- (src/lib/demo/seedData.ts): 20 rules where the seed defines 7, including
-- five near-duplicate "UPI Autopay ..." rules produced by repeatedly pressing
-- the policy-draft example button, two ad-hoc test rules, and three canonical
-- seed rules that had been superseded and never restored. Meanwhile
-- `payout.create` was removed as an action type (RazorpayX needs a registered
-- business, so it could never execute), which left one domain routing on an
-- action type that can no longer exist.
--
-- Safe to re-run: every statement is conditional on current state.

-- 1. Delete orphaned junk rules — but ONLY those no trace points at.
--    A rule referenced by `traces.rule_fired_id` is the recorded explanation
--    for why a past transaction was blocked or escalated; deleting it would
--    orphan that trace's reasoning, which is the one thing this product
--    exists to preserve. Those stay, superseded, as history.
delete from policy_rules r
where r.id not in (
        select t.rule_fired_id from traces t where t.rule_fired_id is not null
      )
  and (
        r.name like 'UPI Autopay%'
     or r.name = 'AllowAllPayouts'
     or r.name = 'Transaction amount cap'   -- ₹10,000 cap in the mandates domain,
                                            -- permanently shadowed by the stricter
                                            -- ₹2,000 cap beside it: could never fire
     or r.name = 'daily_spend_limit'        -- ad-hoc test rule, snake_case name
                                            -- inconsistent with every other rule
      );

-- 2. Restore canonical seed rules that had been superseded.
--    Without these, category blocking did not exist at all despite being part
--    of the pitch, and the purchases domain had no absolute per-transaction
--    ceiling.
--
--    Deliberately NOT restoring "Max 30 actions/hour per agent": the tighter
--    "Rapid-repeat guard: 10 actions / 5 min per agent" already covers runaway
--    loops, and 30/hour starts blocking mid-demo once a couple of demo runs
--    plus a background-traffic burst land in the same hour.
update policy_rules
set status = 'active'
where status = 'superseded'
  and name in ('Per-transaction cap ₹20,000', 'Blocked categories');

-- 3. Drop `payout.create` from any domain's routing — it is no longer an
--    accepted action type, so matching on it is dead configuration.
update policy_domains
set match_action_types = array_remove(match_action_types, 'payout.create')
where 'payout.create' = any(match_action_types);

-- 4. Remove any domain left with no routing and no rules. The "Logistics"
--    domain matched `payout.create` alone, so step 3 leaves it unable to ever
--    match anything, and it has no rules of its own. The default domain is
--    never removed — every action needs somewhere to land.
--
--    Traces pointing at such a domain must be released first, or the
--    `traces_domain_id_fkey` constraint (added in 0005) blocks the delete.
--    Nulling is the honest value here rather than a loss of history: those
--    references were not recorded at decision time, they were assigned by
--    0005's best-effort retroactive backfill, and the traces in question
--    predate domains existing at all. `traces.domain_id` is nullable by
--    design for exactly this "no domain governed it" case.
update traces
set domain_id = null
where domain_id in (
  select d.id from policy_domains d
  where d.is_default = false
    and cardinality(d.match_action_types) = 0
    and cardinality(d.match_categories) = 0
    and not exists (select 1 from policy_rules r where r.domain_id = d.id)
);

delete from policy_domains d
where d.is_default = false
  and cardinality(d.match_action_types) = 0
  and cardinality(d.match_categories) = 0
  and not exists (select 1 from policy_rules r where r.domain_id = d.id);
