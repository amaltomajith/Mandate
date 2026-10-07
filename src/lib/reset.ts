import type { SupabaseClient } from "@supabase/supabase-js";
import { applySeedRules } from "@/lib/policy/seed";
import { applySeedProducts } from "@/lib/catalog";
import { applyGuardrails } from "@/lib/policy/guardrails";
import { DEFAULT_SETTINGS, getSettings } from "@/lib/settings";
import { computeTrustScore } from "@/lib/trust/score";

/**
 * Clearing a merchant's data, as pure functions over an explicit merchant id.
 *
 * The auth lives one layer up, in `actions/settings.ts`, which resolves the
 * tenant from the Clerk session and calls these. Nothing here reads a session
 * and nothing here is reachable from the client; the split exists so the
 * destructive logic can be driven directly by a test against throwaway
 * merchants, the only way to PROVE the isolation claim rather than assert it.
 *
 * Every statement is scoped by `merchant_id`. There is no code path here that
 * deletes without that filter.
 *
 * Two levels, and the line between them is "what would be painful to re-enter":
 *
 *   HISTORY  everything that happened: conversations, runs, quotes, orders,
 *            payouts, sales, the wallet, and the audit trail of decisions.
 *   SETUP    what the merchant configured: products, suppliers and their
 *            approved payees, customers, guardrails and rules, the agents and
 *            their keys, and connections (Gmail, WhatsApp, Razorpay).
 *
 * "Clear history" removes the first and keeps the second. "Reset everything"
 * also removes products, suppliers, customers and rules and restores the starting
 * set, but still keeps connections and the in-house agents: re-linking WhatsApp
 * and re-granting Gmail is the slow, error-prone part of starting over, and the
 * agents' keys are an identity, not data.
 */

/** FK-safe order, children first, so counts are honest and a partial failure
 *  stops somewhere predictable instead of half-cascading. */
const HISTORY_TABLES = [
  "messages",
  "threads",
  "agent_runs",
  "payouts",
  "wallet_entries",
  "sales",
  "po_lines",
  "purchase_orders",
  "quotes",
  "escalations",
  "alerts",
  "traces",
  "webhook_events",
] as const;

/** What survives a history reset. Named once so the preview and the tests read
 *  from one list rather than two that can drift. */
const PRESERVED_TABLES = ["agents", "policy_rules", "products", "vendors", "payees", "customers", "connections"] as const;

export interface ResetCounts {
  /** Rows a history reset would delete, by table. */
  transactions: Record<string, number>;
  /** Rows a history reset leaves alone, by table. Shown alongside so the
   *  confirm dialog states what SURVIVES, not only what dies. */
  preserved: Record<string, number>;
  transactionsTotal: number;
}

async function countIn(db: SupabaseClient, table: string, merchantId: string): Promise<number> {
  const { count, error } = await db.from(table).select("*", { count: "exact", head: true }).eq("merchant_id", merchantId);
  if (error) throw new Error(`Could not count ${table}: ${error.message}`);
  return count ?? 0;
}

/** The live preview behind both confirm dialogs, counted before anything is
 *  deleted so the number shown is the number that goes. */
export async function countResettableRows(db: SupabaseClient, merchantId: string): Promise<ResetCounts> {
  const transactions: Record<string, number> = {};
  const preserved: Record<string, number> = {};
  for (const t of HISTORY_TABLES) transactions[t] = await countIn(db, t, merchantId);
  for (const t of PRESERVED_TABLES) preserved[t] = await countIn(db, t, merchantId);
  return { transactions, preserved, transactionsTotal: Object.values(transactions).reduce((a, b) => a + b, 0) };
}

async function deleteScoped(db: SupabaseClient, table: string, merchantId: string): Promise<void> {
  const { error } = await db.from(table).delete().eq("merchant_id", merchantId);
  if (error) throw new Error(`Could not clear ${table}: ${error.message}`);
}

/**
 * Trust back to baseline for every agent on this merchant.
 *
 * `agents.trust_score` is STORED, written only by `recomputeTrust` after a
 * decision. Deleting traces does not move it, so an agent whose history was just
 * wiped would keep a score with no evidence under it, and `trust_floor` gates on
 * that stored value. The baseline comes from `computeTrustScore` with zero
 * decisions so this stays right if the formula changes.
 *
 * Not atomic with the deletes (the REST client cannot wrap them in one
 * transaction); it runs immediately after, so the window is milliseconds.
 */
export async function resetTrustFor(db: SupabaseClient, merchantId: string): Promise<number> {
  const { data: agents, error } = await db.from("agents").select("id, created_at").eq("merchant_id", merchantId);
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

/** History only. Setup (products, suppliers, payees, customers, rules, agents,
 *  connections) all survives. */
export async function resetTransactionsFor(db: SupabaseClient, merchantId: string): Promise<ResetCounts> {
  const before = await countResettableRows(db, merchantId);
  for (const t of HISTORY_TABLES) await deleteScoped(db, t, merchantId);
  // Prices and "last sold" are derived from history, so they go back too.
  const { error } = await db.from("products").update({ compare_at_price_paise: null, last_sold_at: null }).eq("merchant_id", merchantId);
  if (error) throw new Error(`Could not reset products: ${error.message}`);
  await resetTrustFor(db, merchantId);
  return before;
}

/**
 * Back to the state a brand-new sign-up gets.
 *
 * Rules and products are deleted before being re-seeded, because the seed
 * functions are skip-if-exists: seeding over the top would quietly keep an
 * edited cap or a retired product, which is not "exactly as a new sign-up gets
 * them". Suppliers go with their payees (a payee cascades from its supplier);
 * outside agents go; the in-house agents and every connection stay, for the
 * reasons in the module comment. Settings return to their defaults and the
 * guardrail rules are rebuilt from them.
 */
export async function resetEverythingFor(db: SupabaseClient, merchantId: string): Promise<ResetCounts> {
  const before = await countResettableRows(db, merchantId);

  // History first: traces reference rules and agents, orders reference suppliers.
  for (const t of HISTORY_TABLES) await deleteScoped(db, t, merchantId);

  const { error: agentError } = await db.from("agents").delete().eq("merchant_id", merchantId).eq("kind", "external");
  if (agentError) throw new Error(`Could not clear agents: ${agentError.message}`);

  await deleteScoped(db, "vendors", merchantId); // payees cascade
  await deleteScoped(db, "customers", merchantId);
  await deleteScoped(db, "policy_rules", merchantId);
  await deleteScoped(db, "products", merchantId);

  const { error: settingsError } = await db
    .from("merchant_settings")
    .update({ ...DEFAULT_SETTINGS, updated_at: new Date().toISOString() })
    .eq("merchant_id", merchantId);
  if (settingsError) throw new Error(`Could not reset settings: ${settingsError.message}`);

  await applySeedRules(db, merchantId);
  await applySeedProducts(db, merchantId);
  await applyGuardrails(db, merchantId, await getSettings(db, merchantId));

  // After the agent deletion, so the surviving in-house agents are covered.
  await resetTrustFor(db, merchantId);
  return before;
}
