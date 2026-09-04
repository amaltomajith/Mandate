import type { SupabaseClient } from "@supabase/supabase-js";
import { applySeedRules } from "@/lib/demo/seedData";
import { applySeedProducts } from "@/lib/demo/catalog";
import { computeTrustScore } from "@/lib/trust/score";

/**
 * Clearing a merchant's data, as pure functions over an explicit merchant id.
 *
 * The auth lives one layer up, in `actions/settings.ts`, which resolves the
 * tenant from the Clerk session and calls these. Nothing here reads a session,
 * and nothing here is reachable from the client — the split exists so the
 * destructive logic can be driven directly by a test against throwaway
 * merchants, which is the only way to prove the isolation claim rather than
 * assert it. A reset that quietly took a neighbouring tenant with it is
 * exactly the bug worth a suite.
 *
 * Every statement is scoped by `merchant_id`. There is no code path here that
 * deletes without that filter.
 *
 * Deliberately NOT marked `server-only`, matching `policy/engine.ts` and
 * `demo/catalog.ts`: it takes its client as an argument and never reaches for
 * the service-role one, so there is nothing here for that guard to protect. It
 * also cannot be imported from a client component in practice — its only
 * caller is a "use server" module. The guard stays where the secret is, on
 * `supabase/admin.ts` and `merchant.ts`, and keeping it off here is what lets
 * the destructive logic be driven directly by a test.
 */

/** FK-safe, children first. `escalations.trace_id` and `alerts.trace_id`
 *  cascade from traces and `campaign_targets.campaign_id` from campaigns, but
 *  deleting explicitly in this order means the counts are honest and a partial
 *  failure stops somewhere predictable rather than half-cascading. */
const TRANSACTION_TABLES = ["escalations", "alerts", "campaign_targets", "campaigns", "traces"] as const;

/** What the account keeps across a transaction reset. Named so the preview and
 *  the tests read from one list rather than two that can drift. */
const PRESERVED_TABLES = ["agents", "policy_rules", "products", "customers", "mandates"] as const;

export interface ResetCounts {
  /** Rows a transaction reset would delete, by table. */
  transactions: Record<string, number>;
  /** Rows a transaction reset leaves alone, by table. Shown alongside so the
   *  confirm dialog can state what SURVIVES, not only what dies — the thing
   *  someone under time pressure actually needs to know. */
  preserved: Record<string, number>;
  transactionsTotal: number;
}

async function countIn(db: SupabaseClient, table: string, merchantId: string): Promise<number> {
  const { count, error } = await db
    .from(table)
    .select("*", { count: "exact", head: true })
    .eq("merchant_id", merchantId);
  if (error) throw new Error(`Could not count ${table}: ${error.message}`);
  return count ?? 0;
}

/** The live preview behind both confirm dialogs. Counted before anything is
 *  deleted, so the number shown is the number that goes. */
export async function countResettableRows(db: SupabaseClient, merchantId: string): Promise<ResetCounts> {
  const transactions: Record<string, number> = {};
  const preserved: Record<string, number> = {};

  for (const t of TRANSACTION_TABLES) transactions[t] = await countIn(db, t, merchantId);
  for (const t of PRESERVED_TABLES) preserved[t] = await countIn(db, t, merchantId);

  return {
    transactions,
    preserved,
    transactionsTotal: Object.values(transactions).reduce((a, b) => a + b, 0),
  };
}

async function deleteScoped(db: SupabaseClient, table: string, merchantId: string): Promise<void> {
  const { error } = await db.from(table).delete().eq("merchant_id", merchantId);
  if (error) throw new Error(`Could not clear ${table}: ${error.message}`);
}


/**
 * Trust back to baseline for every agent on this merchant.
 *
 * `agents.trust_score` and `agents.trust_components` are STORED, written only
 * by `recomputeTrust` after an enforce decision or an escalation resolution.
 * Deleting traces therefore does not move them: an agent whose history was
 * just wiped kept reading "39 allowed, 8 escalated, 3 blocked" with zero
 * traces behind it, and would have kept reading that indefinitely, because
 * the only thing that rewrites the row is traffic the agent may never get.
 *
 * That is not merely cosmetic. `trust_floor` gates on this same stored value
 * (getAgentPolicyFacts -> the engine), so leaving it behind means a policy
 * decision made against a number with no evidence under it.
 *
 * The baseline comes from `computeTrustScore` with zero decisions rather than
 * a hardcoded 50, so this stays correct if the formula moves. With no
 * decisions the tenure bonus does not apply either, which is the formula's own
 * choice and not something to second-guess here.
 *
 * NOT ATOMIC WITH THE DELETES, and worth being straight about: supabase-js
 * speaks REST, so there is no way to wrap these statements in one transaction
 * from here. The deletes above are already sequential and non-transactional
 * for the same reason. This runs immediately after them, so the window where
 * traces are gone but trust is stale is milliseconds rather than forever —
 * closing it properly would mean moving the whole reset into a Postgres
 * function, which is a bigger change than this fix.
 */
export async function resetTrustFor(db: SupabaseClient, merchantId: string): Promise<number> {
  const { data: agents, error } = await db
    .from("agents")
    .select("id, created_at")
    .eq("merchant_id", merchantId);
  if (error) throw new Error(`Could not read agents: ${error.message}`);

  for (const agent of agents ?? []) {
    const accountAgeDays = (Date.now() - new Date(agent.created_at).getTime()) / (1000 * 60 * 60 * 24);
    const components = computeTrustScore({ approvals: 0, blocks: 0, escalations: 0, accountAgeDays });
    const { error: updateError } = await db
      .from("agents")
      .update({ trust_score: components.score, trust_components: components })
      .eq("id", agent.id)
      .eq("merchant_id", merchantId);
    if (updateError) throw new Error(`Could not reset trust for ${agent.id}: ${updateError.message}`);
  }
  return (agents ?? []).length;
}

/**
 * History only. Agents, rules, catalog, customers and mandates all survive.
 *
 * That preservation is the entire point of having this separate from the full
 * reset: re-registering three external keypairs is the slow, error-prone part
 * of starting over, and it is never what someone clearing yesterday's traffic
 * actually wants.
 */
export async function resetTransactionsFor(db: SupabaseClient, merchantId: string): Promise<ResetCounts> {
  const before = await countResettableRows(db, merchantId);
  for (const t of TRANSACTION_TABLES) await deleteScoped(db, t, merchantId);
  // Derived state is part of the history this claims to clear.
  await resetTrustFor(db, merchantId);
  return before;
}

/**
 * Back to the state a brand-new sign-up gets.
 *
 * Two details that are easy to get wrong:
 *
 * AGENTS. `agents_one_managed_per_merchant` is a partial unique index allowing
 * at most one `managed` row per merchant. The managed row is the simulation's
 * own identity, whose public key Mandate rotates on restart; deleting it would
 * mint a fresh one on the next boot and lose its accumulated history for no
 * benefit. So non-managed agents go and the managed one stays. Nothing here
 * ever inserts an agent, so the index cannot be violated by this path.
 *
 * RULES AND CATALOG are deleted before being re-seeded. `applySeedRules` and
 * `applySeedProducts` are both skip-if-exists rather than upsert, so seeding
 * over the top would silently preserve an edited cap, a renamed rule or a
 * retired product — which is not "exactly as a brand-new sign-up gets", and
 * the retired product in particular would survive a reset meant to clear it.
 *
 * Customers are deliberately kept: they are the merchant's own records, not
 * agent activity, and the seed customer is restored by applySeedRules anyway.
 */
export async function resetEverythingFor(db: SupabaseClient, merchantId: string): Promise<ResetCounts> {
  const before = await countResettableRows(db, merchantId);

  // History first — traces reference policy_rules.rule_fired_id and agents,
  // so the rules and agents below cannot go until these are gone.
  for (const t of TRANSACTION_TABLES) await deleteScoped(db, t, merchantId);

  await deleteScoped(db, "mandates", merchantId);

  const { error: agentError } = await db
    .from("agents")
    .delete()
    .eq("merchant_id", merchantId)
    .eq("managed", false);
  if (agentError) throw new Error(`Could not clear agents: ${agentError.message}`);

  await deleteScoped(db, "policy_rules", merchantId);
  await deleteScoped(db, "products", merchantId);

  await applySeedRules(db, merchantId);
  await applySeedProducts(db, merchantId);

  // After the agent deletion, so the surviving managed identity is covered.
  await resetTrustFor(db, merchantId);

  return before;
}
