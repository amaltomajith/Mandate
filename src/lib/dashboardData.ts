import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentMerchant } from "@/lib/merchant";

/**
 * Dashboard reads go through the service-role client (Clerk gates the routes;
 * see HANDOVER.md §5b). Supabase-js doesn't throw on a failed query — it
 * returns `{ data: null, error }` — so without checking `error` explicitly,
 * a real failure (e.g. a network/TLS problem between this server and
 * Supabase) silently renders as "no data yet" instead of a visible error.
 * That's exactly what happened once already: the banner showed 0/3 done
 * after a TLS interception issue broke every query, and nothing said why.
 */

interface SupabaseResult<T> {
  data: T | null;
  error: { message: string } | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Two known-transient failure shapes, retried; everything else still fails
 * immediately, on the first try, same as before:
 *
 * 1. Supabase's newer `sb_secret_...` key format mints a fresh internal JWT
 *    per request at the gateway in front of PostgREST; a clock disagreement
 *    between whichever internal service minted it and whichever verified it
 *    surfaces as `"JWT issued at future"` — confirmed (via a direct
 *    out-of-band probe against the same credentials, moments after hitting
 *    it) to be a transient upstream hiccup, not a real credentials/config
 *    problem here.
 * 2. A raw network/TLS exception below Supabase's own layer — surfaces as
 *    `"TypeError: fetch failed"` (undici's generic wrapper) with no `cause`
 *    Supabase-js preserves. Reproduced directly against this exact project:
 *    a bare request intermittently fails the TLS handshake and succeeds on
 *    the very next attempt, no config change involved — a one-off network
 *    blip, not a broken project. Distinct from #1's message shape, so it
 *    needed its own check rather than a broader regex on the same pattern.
 */
function isTransientJwtClockError(error: { message: string }): boolean {
  return /jwt/i.test(error.message) && /future|clock skew/i.test(error.message);
}

function isTransientNetworkError(error: { message: string }): boolean {
  return /fetch failed|econnreset|etimedout|enotfound|socket hang up/i.test(error.message);
}

/**
 * The single answer to "is this worth panicking about", used by both the retry
 * loop and the logging below.
 *
 * They were separate, and drifted: the retry loop treated the JWT clock error
 * as transient and retried it four times, then the logging branch checked only
 * the network predicate and reported it with console.error -- which throws
 * Next's full-screen dev overlay. So the code retried an error *because it knew
 * it was transient* and then announced it as fatal. One predicate for both
 * decisions is the only way that stays consistent when the next failure shape
 * gets added.
 */
function isTransient(error: { message: string }): boolean {
  return isTransientJwtClockError(error) || isTransientNetworkError(error);
}

async function withRetry<T>(query: () => PromiseLike<SupabaseResult<T>>, attempts = 4): Promise<SupabaseResult<T>> {
  let result = await query();
  for (
    let attempt = 1;
    attempt < attempts && result.error && isTransient(result.error);
    attempt++
  ) {
    // Grows faster than linearly: on a TLS-inspecting network the failures
    // that get through the first retry tend to be a proxy renegotiating
    // rather than a single dropped packet, and that takes longer to clear
    // than 300ms.
    await sleep(400 * attempt * attempt);
    result = await query();
  }
  return result;
}

export async function getDashboardData() {
  const supabase = createAdminClient();
  // Every query below is scoped to this merchant. An unscoped read compiles
  // perfectly and returns other tenants' rows, which is why the filter is
  // applied here at the single place all dashboard reads funnel through rather
  // than trusted to be remembered at each call site.
  const merchant = await getCurrentMerchant();
  const mine = <T,>(q: T & { eq: (c: string, v: string) => T }) => q.eq("merchant_id", merchant.id);

  const [agents, rules, traces, escalations, alerts, mandates, customers, products] = await Promise.all([
    withRetry(() => mine(supabase.from("agents").select("*").order("trust_score", { ascending: false }))),
    withRetry(() => mine(supabase.from("policy_rules").select("*").order("created_at", { ascending: false }))),
    withRetry(() => mine(supabase.from("traces").select("*").order("created_at", { ascending: false }).limit(300))),
    // Matched to the trace limit above, not a smaller number of its own. The
    // revenue panel reads an escalated trace with no matching escalation row as
    // "still awaiting a decision", so with a tighter cap here approvals would
    // silently fall out of the fetched set and settled revenue would start
    // reporting as pending.
    //
    // Matching the numbers does NOT mean the two sets cover the same period,
    // and assuming it did caused a real bug. Escalations are rare -- 40 against
    // 449 traces on a live merchant -- so 300 of them reach much further back
    // than the newest 300 traces do. Ten escalations referenced traces that had
    // fallen out of the window, and five of those were pending, which rendered
    // as approve/deny cards with nothing above them. The backfill below is what
    // actually fixes that; this limit only stops the reverse problem.
    withRetry(() => mine(supabase.from("escalations").select("*").order("created_at", { ascending: false }).limit(300))),
    withRetry(() => mine(supabase.from("alerts").select("*").order("created_at", { ascending: false }).limit(50))),
    withRetry(() => mine(supabase.from("mandates").select("*").order("created_at", { ascending: false }))),
    withRetry(() => mine(supabase.from("customers").select("*").order("created_at", { ascending: false }))),
    // Unlimited on purpose: the order history names the product behind each
    // trace by SKU lookup, and a truncated product list would silently turn
    // some orders into unnamed ones. Handful of rows either way.
    withRetry(() => mine(supabase.from("products").select("*").order("name"))),
  ]);

  // Any trace an escalation points at, that the window above did not reach.
  //
  // Fetched by id rather than by widening the window, because the window exists
  // to bound the page and widening it to cover the oldest escalation would mean
  // loading every trace since. This asks for exactly the handful that are
  // actually referenced.
  //
  // A failure here is not fatal: the escalation panel refuses to act on a card
  // whose trace it cannot show, so the worst case is a card that says so rather
  // than one that quietly offers to approve something invisible.
  const fetchedTraceIds = new Set((traces.data ?? []).map((t) => t.id));
  const missingTraceIds = [...new Set((escalations.data ?? []).map((e) => e.trace_id))].filter(
    (id) => !fetchedTraceIds.has(id)
  );
  const backfilled = missingTraceIds.length
    ? await withRetry(() => mine(supabase.from("traces").select("*").in("id", missingTraceIds)))
    : { data: [], error: null };
  if (backfilled.error) {
    console.warn("[dashboardData] could not backfill traces for escalations:", backfilled.error.message);
  }

  const errors = [agents, rules, traces, escalations, alerts, mandates, customers, products]
    .map((r) => r.error)
    .filter((e): e is NonNullable<typeof e> => e !== null);

  if (errors.length > 0) {
    for (const e of errors) {
      // supabase-js flattens a raw network/TLS exception down to just
      // `{ message }` — the underlying reason (ECONNREFUSED, a cert error,
      // ENOTFOUND, ...) normally lives on the original error's `.cause`, but
      // gets dropped in that flattening. Logging it separately when present
      // is the difference between "TypeError: fetch failed" (tells you
      // nothing) and the actual OS-level reason underneath it.
      const cause = (e as { cause?: unknown }).cause;
      const detail = cause ? { cause } : e;

      // A known-transient failure that survived four retries is still very
      // likely transient — the dashboard re-polls every few seconds and the
      // next attempt usually succeeds. console.error throws Next's full-screen
      // dev overlay, which during a live demo is a far worse outcome than the
      // momentary gap it is reporting. The failure is NOT hidden: it still
      // logs, and `loadError` still renders a visible banner on the page.
      // Anything that isn't a known-transient shape stays a hard error.
      if (isTransient(e)) {
        console.warn("[dashboardData] transient failure, will retry on next poll:", e.message, detail);
      } else {
        console.error("[dashboardData] Supabase query failed:", e.message, detail);
      }
    }
  }

  return {
    agents: agents.data ?? [],
    rules: rules.data ?? [],
    // The window, plus whatever the escalation queue still needs to be
    // explicable. Order is preserved for the window itself; the backfilled
    // rows are older by construction and go on the end.
    traces: [...(traces.data ?? []), ...(backfilled.data ?? [])],
    escalations: escalations.data ?? [],
    alerts: alerts.data ?? [],
    mandates: mandates.data ?? [],
    customers: customers.data ?? [],
    products: products.data ?? [],
    merchant,
    loadError: errors[0]?.message ?? null,
  };
}

export type DashboardData = ReturnType<typeof getDashboardData> extends Promise<infer T> ? T : never;
