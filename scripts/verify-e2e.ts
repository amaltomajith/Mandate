/**
 * End-to-end verification, with tenant isolation as the point.
 *
 * Multi-tenancy that is not tested is not multi-tenancy — an unscoped read
 * compiles perfectly and leaks silently, so the only way to know the boundary
 * holds is to stand on both sides of it and push. This creates two throwaway
 * merchants, gives each a real agent with a real Ed25519 keypair, and then
 * tries to make each one see or touch the other.
 *
 * Every isolation check is written so it FAILS if scoping is removed. A test
 * that passes against an unscoped database is worse than no test: it certifies
 * the bug. Where a check could pass trivially (an empty table returns nothing
 * whether or not it is filtered), it asserts a control first — the owner must
 * see the row in the same instant the outsider does not.
 *
 * Cleans up after itself: both merchants are deleted at the end, and every
 * table cascades from them, so a run leaves the database as it found it.
 *
 * Usage: npx tsx scripts/verify-e2e.ts     (needs the dev server running)
 */
import "./lib/loadEnv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { generateKeyPair } from "../src/lib/webBotAuth/keys";
import { MandateClient } from "../src/lib/demo/mandateClient";
import { applySeedRules } from "../src/lib/demo/seedData";
import { applySeedProducts, fetchCatalog } from "../src/lib/demo/catalog";

const db: SupabaseClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);
const BASE = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(52)} ${detail}`);
}

interface Tenant {
  id: string;
  slug: string;
  agentId: string;
  secret: string;
  client: MandateClient;
}

async function makeTenant(label: string): Promise<Tenant> {
  const slug = `t-${label}-${Math.random().toString(36).slice(2, 8)}`;
  const { data: merchant, error } = await db
    .from("merchants")
    .insert({ name: `Test ${label}`, slug })
    .select()
    .single();
  if (error) throw new Error(`merchant insert: ${error.message}`);

  await applySeedRules(db, merchant.id);
  await applySeedProducts(db, merchant.id);

  const { secretKey, publicKey } = generateKeyPair();
  const { data: agent, error: agentErr } = await db
    .from("agents")
    .insert({ merchant_id: merchant.id, name: "Checkout Agent", public_key: publicKey })
    .select()
    .single();
  if (agentErr) throw new Error(`agent insert: ${agentErr.message}`);

  const client = new MandateClient(BASE, slug, agent.id, secretKey);
  await client.initialize(`e2e-${label}`);
  return { id: merchant.id, slug, agentId: agent.id, secret: secretKey, client };
}

interface ActionResult {
  decision: "allow" | "block" | "escalate";
  reasoning: string;
  traceId: string;
  razorpayResponse?: { id?: string; short_url?: string; status?: string } | null;
}

async function main() {
  console.log(`base url: ${BASE}\n`);

  const A = await makeTenant("a");
  const B = await makeTenant("b");
  console.log(`tenant A: ${A.slug}\ntenant B: ${B.slug}\n`);

  try {
    // ---- 1. Baseline: each tenant can transact on its own endpoint.
    const catalogA = await fetchCatalog(db, A.id);
    const item = catalogA.find((c) => c.sku === "hub-01") ?? catalogA[0];
    const buyA = await A.client.callTool<ActionResult>("enforce_action", {
      actionType: "order.create",
      amount: item.priceInPaise,
      currency: "INR",
      category: item.category,
      params: { receipt: `e2e-a-${Date.now()}`, notes: { sku: item.sku, item: item.name } },
    });
    check("tenant A can transact on its own endpoint", buyA.decision === "allow", buyA.reasoning);

    // ---- 2. THE boundary: A's agent against B's endpoint.
    // A's keyid is not in B's agent table, so verification fails before any
    // policy runs. If key lookup were global this would succeed and act on B.
    const crossClient = new MandateClient(BASE, B.slug, A.agentId, A.secret);
    let crossBlocked = false;
    let crossDetail = "";
    try {
      await crossClient.initialize("e2e-cross");
      const r = await crossClient.callTool<ActionResult>("enforce_action", {
        actionType: "order.create",
        amount: 10000,
        currency: "INR",
        category: "electronics",
        params: { receipt: "e2e-cross" },
      });
      crossDetail = `ACTED ON B: ${r.decision}`;
    } catch (err) {
      crossBlocked = true;
      crossDetail = (err instanceof Error ? err.message : String(err)).slice(0, 58);
    }
    check("A's agent is rejected by B's MCP endpoint", crossBlocked, crossDetail);

    // ---- 3. A's trace must not be readable through B's agent.
    let explainLeaked = true;
    let explainDetail = "";
    try {
      const e = await B.client.callTool<{ explanation: string }>("explain", { traceId: buyA.traceId });
      explainDetail = `LEAKED: ${e.explanation.slice(0, 40)}`;
    } catch (err) {
      explainLeaked = false;
      explainDetail = (err instanceof Error ? err.message : String(err)).slice(0, 50);
    }
    check("B cannot explain A's trace", !explainLeaked, explainDetail);

    // ---- 4. Trace rows are scoped. Control first: A's own query must find it,
    //         or "B sees nothing" would pass against an empty table.
    const { data: ownTrace } = await db.from("traces").select("id").eq("id", buyA.traceId).eq("merchant_id", A.id);
    const { data: bTrace } = await db.from("traces").select("id").eq("id", buyA.traceId).eq("merchant_id", B.id);
    check("A's trace is visible to A (control)", (ownTrace ?? []).length === 1, `${ownTrace?.length ?? 0} row(s)`);
    check("A's trace is invisible under B's scope", (bTrace ?? []).length === 0, "0 rows while A saw 1");

    // ---- 5. Public catalog is per-merchant, and an unknown slug 404s.
    const catRes = await fetch(`${BASE}/api/m/${A.slug}/catalog`);
    const catJson = (await catRes.json()) as { catalog?: { sku: string }[] };
    const aSkus = new Set((await fetchCatalog(db, A.id)).map((c) => c.sku));
    const servedSkus = (catJson.catalog ?? []).map((c) => c.sku);
    check(
      "A's public catalog serves only A's products",
      servedSkus.length > 0 && servedSkus.every((s) => aSkus.has(s)),
      `${servedSkus.length} item(s)`
    );
    const missRes = await fetch(`${BASE}/api/m/definitely-not-a-merchant/catalog`);
    check("unknown merchant slug returns 404", missRes.status === 404, `HTTP ${missRes.status}`);

    // ---- 6. Key directory lists only that merchant's agents.
    const dirRes = await fetch(`${BASE}/api/m/${A.slug}/wba-directory`);
    const dirJson = (await dirRes.json()) as { keys?: { keyid: string }[] };
    const keyids = (dirJson.keys ?? []).map((k) => k.keyid);
    check(
      "A's key directory excludes B's agent",
      keyids.includes(A.agentId) && !keyids.includes(B.agentId),
      `${keyids.length} key(s)`
    );

    // ---- 7. A forged request is attributed to the endpoint it targeted, not
    //         to whatever identity it claims.
    const before = new Date().toISOString();
    await B.client.sendTamperedRequest();
    const { data: rejects } = await db
      .from("traces")
      .select("merchant_id, decision")
      .eq("decision", "protocol_reject")
      .gt("created_at", before);
    const attributed = (rejects ?? []).filter((r) => r.merchant_id === B.id).length;
    const misattributed = (rejects ?? []).filter((r) => r.merchant_id === A.id).length;
    check("forged request is recorded against the targeted merchant", attributed >= 1, `${attributed} trace(s)`);
    check("forged request is not attributed to the other merchant", misattributed === 0, `${misattributed} stray`);

    // ---- 8. Policy still works per-tenant: a banned category is refused.
    const banned = await A.client.callTool<ActionResult>("enforce_action", {
      actionType: "order.create",
      amount: 50000,
      currency: "INR",
      category: "crypto",
      params: { receipt: `e2e-banned-${Date.now()}` },
    });
    check("banned category is refused", banned.decision === "block", banned.reasoning.slice(0, 46));

    // ---- 9. The new action type executes against Razorpay test mode.
    const { data: cust } = await db
      .from("customers")
      .insert({ merchant_id: A.id, name: "E2E Buyer", email: "e2e@example.com" })
      .select()
      .single();
    const link = await A.client.callTool<ActionResult>("enforce_action", {
      actionType: "payment_link.create",
      amount: 103900,
      currency: "INR",
      category: "electronics",
      customerId: cust!.id,
      params: {
        description: "E2E 20% off",
        customerName: "E2E Buyer",
        customerEmail: "e2e@example.com",
        discountPaise: 26000,
        notify: false,
      },
    });
    check(
      "payment_link.create returns a live Razorpay link",
      link.decision === "allow" && !!link.razorpayResponse?.short_url,
      link.razorpayResponse?.short_url ?? link.reasoning.slice(0, 46)
    );

    // ---- 10. Velocity budget is per-merchant. A's traffic above must not have
    //          consumed B's, so B's first action still clears.
    const catalogB = await fetchCatalog(db, B.id);
    const buyB = await B.client.callTool<ActionResult>("enforce_action", {
      actionType: "order.create",
      amount: catalogB[0].priceInPaise,
      currency: "INR",
      category: catalogB[0].category,
      params: { receipt: `e2e-b-${Date.now()}` },
    });
    check("B's rate budget is unaffected by A's traffic", buyB.decision === "allow", buyB.reasoning.slice(0, 46));

    // ---- 11. Seeded rules are per-merchant, not shared rows.
    const { data: aRules } = await db.from("policy_rules").select("id").eq("merchant_id", A.id).eq("status", "active");
    const { data: bRules } = await db.from("policy_rules").select("id").eq("merchant_id", B.id).eq("status", "active");
    const aIds = new Set((aRules ?? []).map((r) => r.id));
    const overlap = (bRules ?? []).filter((r) => aIds.has(r.id)).length;
    check(
      "each merchant has its own rule rows",
      (aRules ?? []).length > 0 && (bRules ?? []).length > 0 && overlap === 0,
      `A ${aRules?.length} · B ${bRules?.length} · shared ${overlap}`
    );
  } finally {
    // Cascade takes agents, traces, rules, products, customers with it.
    await db.from("merchants").delete().in("id", [A.id, B.id]);
    const { count } = await db.from("traces").select("*", { count: "exact", head: true }).eq("merchant_id", A.id);
    check("test tenants cascade-delete cleanly", (count ?? 0) === 0, `${count ?? 0} orphan trace(s)`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log("FAILED:");
    for (const f of failed) console.log(`  · ${f.name} — ${f.detail}`);
  }
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
