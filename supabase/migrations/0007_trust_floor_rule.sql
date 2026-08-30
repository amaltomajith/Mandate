-- Mandate — make the trust score consequential
--
-- Until now the trust score was computed on every enforce decision, stored,
-- and displayed — but no rule ever read it. An agent at trust 12 was treated
-- exactly like an agent at trust 95. A reputation signal nothing acts on is
-- decoration, not a control.
--
-- `trust_floor` closes that: below a given score, an agent's actions require
-- human approval (or are refused) regardless of amount. That is the ordinary
-- shape of reputation-based controls — a caller with a bad history gets less
-- rope — and it is the piece that turns the score into a working input rather
-- than a number on a wall.

alter table policy_rules drop constraint if exists policy_rules_type_check;
alter table policy_rules add constraint policy_rules_type_check
  check (type in ('cap', 'velocity', 'category_block', 'step_up', 'trust_floor'));
