/**
 * The self-serve reset, and the one thing that must never be true of it.
 *
 * A reset that quietly took a neighbouring tenant's rows with it would be
 * invisible from the dashboard that ran it — the merchant who pressed the
 * button sees exactly what they expected, and the damage is on an account
 * nobody is looking at. So isolation is asserted directly, on two real
 * merchants with real rows, in the same shape as the tenant-isolation checks
 * in verify-e2e: merchant B is populated first, and its counts are compared
 * before and after A resets.
 *
 * The reset logic is imported as pure functions over an explicit merchant id.
 * The server actions in actions/settings.ts wrap these and resolve the tenant
 * from the Clerk session instead — there is no session in a script, so the
 * session-refusal case is checked against the action itself at the end.
 */
import "./lib/loadEnv";
import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { countResettableRows, resetTransactionsFor, resetEverythingFor } from "../src/lib/reset";
import { applySeedRules } from "../src/lib/demo/seedData";
import { applySeedProducts } from "../src/lib/demo/catalog";

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const results: [string, boolean, string][] = [];
const check = (n: string, ok: boolean, d = "") => {
  results.push([n, ok, d]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${n.padEnd(58)} ${d}`);
};

async function count(table: string, merchantId: string) {
  const { count: c, error } = await db.from(table).select("*", { count: "exact", head: true }).eq("merchant_id", merchantId);
  if (error) throw new Error(`${table}: ${error.message}`);
  return c ?? 0;
}

/** Insert one row and fail loudly. A silent null here would surface later as
 *  an unrelated null-dereference, which is a poor way to learn that a column
 *  does not exist. */
async function ins<T = Record<string, unknown>>(table: string, row: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.from(table).insert(row).select().single();
  if (error) throw new Error(`insert ${table}: ${error.message}`);
  return data as T;
}

/** A merchant with one of everything the reset touches, so no assertion below
 *  can pass vacuously against an empty table. */
async function populate(merchantId: string, tag: string) {
  await applySeedRules(db, merchantId);
  await applySeedProducts(db, merchantId);

  const rnd = Math.random().toString(36).slice(2, 10);
  const agent = await ins<{ id: string }>("agents", {
    merchant_id: merchantId,
    name: `${tag} buyer ${rnd}`,
    public_key: `pk-${tag}-${rnd}`,
  });
  // Reused rather than inserted when one is already there. populate() runs
  // twice on merchant A -- once before each reset -- and a second managed row
  // is exactly what agents_one_managed_per_merchant exists to forbid. Creating
  // one unconditionally made the test fail against a constraint the code under
  // test is careful to respect.
  const { data: existingManaged } = await db
    .from("agents")
    .select("id")
    .eq("merchant_id", merchantId)
    .eq("managed", true)
    .maybeSingle();
  const managed =
    existingManaged ??
    (await ins<{ id: string }>("agents", {
      merchant_id: merchantId,
      name: `Checkout Agent ${rnd}`,
      public_key: `pk-${tag}-managed-${rnd}`,
      managed: true,
    }));
  const customer = await ins<{ id: string }>("customers", {
    merchant_id: merchantId,
    name: `${tag} customer`,
  });

  await ins("mandates", {
    merchant_id: merchantId,
    agent_id: agent.id,
    customer_id: customer.id,
    type: "upi_autopay",
    status: "active",
    raw_payload: {},
  });

  const trace = await ins<{ id: string }>("traces", {
    merchant_id: merchantId,
    agent_id: agent.id,
    action_type: "order.create",
    decision: "allow",
    mode: "enforce",
    params: { amount: 10000, currency: "INR" },
    reasoning: "seeded by verify-settings",
  });
  await ins("escalations", { merchant_id: merchantId, trace_id: trace.id, status: "pending" });
  await ins("alerts", { merchant_id: merchantId, trace_id: trace.id, severity: "info", message: `${tag} alert` });

  const campaign = await ins<{ id: string }>("campaigns", {
    merchant_id: merchantId,
    agent_id: agent.id,
    name: `${tag} campaign ${rnd}`,
    goal: "seeded by verify-settings",
    budget_paise: 100000,
  });
  await ins("campaign_targets", {
    merchant_id: merchantId,
    campaign_id: campaign.id,
    customer_id: customer.id,
    amount_paise: 50000,
  });

  return { agentId: agent.id, managedId: managed.id };
}

async function snapshot(merchantId: string) {
  const tables = ["traces", "escalations", "alerts", "campaigns", "campaign_targets", "agents", "policy_rules", "products", "customers", "mandates"];
  const out: Record<string, number> = {};
  for (const t of tables) out[t] = await count(t, merchantId);
  return out;
}

async function main() {
  const slugA = `set-a-${Math.random().toString(36).slice(2, 7)}`;
  const slugB = `set-b-${Math.random().toString(36).slice(2, 7)}`;
  const { data: A } = await db.from("merchants").insert({ name: "Reset Test A", slug: slugA }).select().single();
  const { data: B } = await db.from("merchants").insert({ name: "Reset Test B", slug: slugB }).select().single();

  try {
    await populate(A!.id, "a");
    await populate(B!.id, "b");

    const bBefore = await snapshot(B!.id);
    const aBefore = await snapshot(A!.id);

    check("CONTROL: both tenants start with history", aBefore.traces > 0 && bBefore.traces > 0, `A ${aBefore.traces} / B ${bBefore.traces} trace(s)`);
    check("CONTROL: both start with agents and mandates", aBefore.agents === 2 && aBefore.mandates === 1, `A ${aBefore.agents} agent(s), ${aBefore.mandates} mandate(s)`);

    // ---- the preview must describe reality, since a confirm dialog quotes it
    const preview = await countResettableRows(db, A!.id);
    check(
      "preview counts match the rows actually there",
      preview.transactions.traces === aBefore.traces && preview.transactions.escalations === aBefore.escalations,
      `${preview.transactionsTotal} row(s) across 5 tables`
    );
    check(
      "preview reports what SURVIVES too, not only what dies",
      preview.preserved.agents === aBefore.agents && preview.preserved.mandates === aBefore.mandates,
      `agents ${preview.preserved.agents}, mandates ${preview.preserved.mandates}`
    );

    // ---- reset transactions on A
    await resetTransactionsFor(db, A!.id);
    const aAfter = await snapshot(A!.id);

    check("history is gone", aAfter.traces === 0 && aAfter.escalations === 0 && aAfter.alerts === 0, `traces ${aAfter.traces}, escalations ${aAfter.escalations}, alerts ${aAfter.alerts}`);
    check("campaigns and their targets are gone", aAfter.campaigns === 0 && aAfter.campaign_targets === 0, `${aAfter.campaigns} campaign(s), ${aAfter.campaign_targets} target(s)`);
    check("agents survive with their keys", aAfter.agents === aBefore.agents, `${aAfter.agents} agent(s)`);
    check("policy rules survive", aAfter.policy_rules === aBefore.policy_rules, `${aAfter.policy_rules} rule(s)`);
    check("catalog survives", aAfter.products === aBefore.products, `${aAfter.products} product(s)`);
    check("customers survive", aAfter.customers === aBefore.customers, `${aAfter.customers} customer(s)`);
    check("mandates survive", aAfter.mandates === aBefore.mandates, `${aAfter.mandates} mandate(s)`);

    // ---- the isolation claim
    const bAfterA = await snapshot(B!.id);
    const isolated = Object.keys(bBefore).every((t) => bBefore[t] === bAfterA[t]);
    check("MERCHANT B IS COMPLETELY UNTOUCHED", isolated, isolated ? `all 10 tables unchanged (${bAfterA.traces} trace(s) still there)` : `drift: ${Object.keys(bBefore).filter((t) => bBefore[t] !== bAfterA[t]).join(", ")}`);

    // ---- reset everything on A
    await populate(A!.id, "a2");
    const aRepop = await snapshot(A!.id);
    check("CONTROL: A has history again before the full reset", aRepop.traces > 0, `${aRepop.traces} trace(s)`);

    await resetEverythingFor(db, A!.id);
    const aFull = await snapshot(A!.id);

    check("full reset clears history", aFull.traces === 0 && aFull.escalations === 0, `traces ${aFull.traces}`);
    check("full reset clears mandates", aFull.mandates === 0, `${aFull.mandates} mandate(s)`);
    check("full reset removes third-party agents", aFull.agents === 1, `${aFull.agents} agent(s) left`);

    const { data: survivors } = await db.from("agents").select("id, managed").eq("merchant_id", A!.id);
    const managedCount = (survivors ?? []).filter((a) => a.managed).length;
    check("exactly one managed identity survives", managedCount === 1, `${managedCount} managed`);
    check("the partial unique index is not violated", (survivors ?? []).length === managedCount, "every survivor is the managed row");

    check("default rules are re-seeded", aFull.policy_rules === 5, `${aFull.policy_rules} rule(s)`);
    check("default catalog is re-seeded", aFull.products > 0, `${aFull.products} product(s)`);

    const { data: retiredCheck } = await db.from("products").select("active").eq("merchant_id", A!.id);
    check("re-seeded catalog is all active", (retiredCheck ?? []).every((p) => p.active), `${(retiredCheck ?? []).filter((p) => p.active).length} active`);

    const bFinal = await snapshot(B!.id);
    const stillIsolated = Object.keys(bBefore).every((t) => bBefore[t] === bFinal[t]);
    check("MERCHANT B SURVIVES THE FULL RESET TOO", stillIsolated, stillIsolated ? "all 10 tables unchanged" : `drift: ${Object.keys(bBefore).filter((t) => bBefore[t] !== bFinal[t]).join(", ")}`);

    // ---- no session, no reset
    //
    // Deliberately NOT "import the action and see it throw": it does throw,
    // but on `server-only` refusing to load outside a server context, which
    // happens before any auth check runs. That check passed identically with
    // the guard deleted, so it proved nothing. These two do.
    const BASE = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    try {
      const res = await fetch(`${BASE}/dashboard/settings`, { redirect: "manual" });
      const location = res.headers.get("location") ?? "";
      const bounced = res.status === 307 || res.status === 302 || res.status === 303;
      check(
        "an unauthenticated request to /dashboard/settings is bounced",
        bounced && /login|sign-in/i.test(location),
        `HTTP ${res.status} -> ${location.slice(0, 44) || "(no location)"}`
      );
    } catch (err) {
      check("an unauthenticated request to /dashboard/settings is bounced", false, `dev server unreachable: ${err instanceof Error ? err.message : ""}`);
    }

    // The invariant the brief is built on: the tenant is never an argument.
    // A static read, because the failure worth catching is someone later
    // adding `resetTransactions(merchantId)` as a convenience -- which no
    // runtime test would fail, since it would work perfectly.
    const actionSrc = await readFile("src/lib/actions/settings.ts", "utf8");
    const exported = [...actionSrc.matchAll(/export async function (\w+)\(([^)]*)\)/g)];
    const takesTenant = exported.filter(([, , params]) => /merchant|tenant|slug\s*:/i.test(params) && !/typedSlug/.test(params));
    check(
      "no exported action accepts a tenant identifier",
      takesTenant.length === 0 && exported.length >= 3,
      `${exported.length} action(s): ${exported.map(([, n]) => n).join(", ")}`
    );
    const resolvesSession = exported.every(([whole]) => {
      const body = actionSrc.slice(actionSrc.indexOf(whole));
      return body.slice(0, 400).includes("getCurrentMerchant()");
    });
    check("every exported action resolves the merchant from the session", resolvesSession, "getCurrentMerchant() in each");

  } finally {
    // Children before parents; merchants cascade the rest.
    for (const id of [A!.id, B!.id]) {
      for (const t of ["escalations", "alerts", "campaign_targets", "campaigns", "traces", "mandates", "agents", "policy_rules", "products", "customers"]) {
        await db.from(t).delete().eq("merchant_id", id);
      }
      await db.from("merchants").delete().eq("id", id);
    }
  }

  const passed = results.filter(([, ok]) => ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
