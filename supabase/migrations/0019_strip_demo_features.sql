-- Phase 0 of the pivot to an in-house COO: remove the schema owned by features
-- that no longer exist (counter-offers, campaigns) and the single-managed-agent
-- constraint, which would block running a Selling and a Buying agent per merchant.
-- Apply by hand in the Supabase SQL editor (or via the Supabase MCP apply_migration).

drop index if exists traces_offer_id_key;

drop table if exists campaign_targets;
drop table if exists campaigns;

drop index if exists agents_one_managed_per_merchant;
