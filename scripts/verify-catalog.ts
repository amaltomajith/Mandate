/**
 * Retiring a product has to reach every reader of the catalog.
 *
 * Four things read it: the public /catalog route, the headroom probe,
 * counter-offer candidates and campaign planning. Three go through
 * `fetchCatalog`; /catalog runs its own query. That split is exactly the shape
 * of bug worth a test — a deactivated SKU that is still offerable would look
 * completely fine from the dashboard, because the dashboard reads the table
 * directly and would show it retired while an agent was still being sold it.
 *
 * The counter-offer check is the one most likely to pass for the wrong reason,
 * so it is written to fail loudly if it ever stops proving anything: it asserts
 * the retired SKU can be offered BEFORE retiring it, so "not offered after" is
 * a change rather than a vacuous truth about an empty candidate list.
 */
import "./lib/loadEnv";
import { createClient } from "@supabase/supabase-js";
import { fetchCatalog, applySeedProducts, PRODUCT_CATEGORIES } from "../src/lib/demo/catalog";
import { generateKeyPair } from "../src/lib/webBotAuth/keys";
import { signRequest } from "../src/lib/webBotAuth/sign";
import { computeContentDigest } from "../src/lib/webBotAuth/canonical";
import { evaluatePolicy } from "../src/lib/policy/engine";
import type { PolicyRule } from "../src/lib/policy/types";

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const BASE = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

const results: [string, boolean, string][] = [];
const check = (n: string, ok: boolean, d = "") => {
  results.push([n, ok, d]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${n.padEnd(54)} ${d}`);
};

async function main() {
  const slug = `cat-${Math.random().toString(36).slice(2, 7)}`;
  const { data: m } = await db.from("merchants").insert({ name: "Catalog Test", slug }).select().single();
  await applySeedProducts(db, m!.id);

  try {
    const before = await fetchCatalog(db, m!.id);
    check("the live catalog starts populated", before.length >= 2, `${before.length} product(s)`);

    const victim = before[0];

    // /catalog serves it, and still withholds the thresholds.
    const res = await fetch(`${BASE}/api/m/${slug}/catalog`);
    const body = (await res.json()) as { catalog: { sku: string }[] };
    check(
      "/catalog serves the active product",
      body.catalog.some((c) => c.sku === victim.sku),
      victim.sku
    );
    const raw = JSON.stringify(body);
    check(
      "/catalog still withholds policy thresholds",
      !/threshold_amount|max_amount|min_score|step_up/.test(raw),
      "no rule internals in the payload"
    );

    // The candidate pool a counter-offer draws from is the live catalog minus
    // the parent. Asserted BEFORE retiring, so the check below is a change.
    const candidatesBefore = (await fetchCatalog(db, m!.id)).filter((c) => c.sku !== before[1].sku);
    check(
      "the retired-to-be sku is offerable beforehand",
      candidatesBefore.some((c) => c.sku === victim.sku),
      `${candidatesBefore.length} candidate(s)`
    );

    // ---- retire it
    const { error } = await db.from("products").update({ active: false }).eq("merchant_id", m!.id).eq("sku", victim.sku);
    if (error) throw new Error(error.message);

    const after = await fetchCatalog(db, m!.id);
    check("fetchCatalog drops it", !after.some((c) => c.sku === victim.sku), `${after.length} left`);

    const candidatesAfter = after.filter((c) => c.sku !== before[1].sku);
    check(
      "it is no longer a counter-offer candidate",
      !candidatesAfter.some((c) => c.sku === victim.sku),
      `${candidatesAfter.length} candidate(s)`
    );

    // The route caches for 60s, so ask past it -- otherwise this asserts the
    // cache, not the filter.
    const res2 = await fetch(`${BASE}/api/m/${slug}/catalog?t=${Date.now()}`, { cache: "no-store" });
    const body2 = (await res2.json()) as { catalog: { sku: string }[] };
    check(
      "/catalog stops advertising it",
      !body2.catalog.some((c) => c.sku === victim.sku),
      `${body2.catalog.length} advertised`
    );

    // The row survives, so history still resolves.
    const { data: still } = await db
      .from("products")
      .select("sku, active")
      .eq("merchant_id", m!.id)
      .eq("sku", victim.sku)
      .maybeSingle();
    check("the row survives so past traces still resolve", !!still && still.active === false, victim.sku);

    // Restoring puts it back everywhere.
    await db.from("products").update({ active: true }).eq("merchant_id", m!.id).eq("sku", victim.sku);
    const restored = await fetchCatalog(db, m!.id);
    check("restoring brings it back", restored.some((c) => c.sku === victim.sku), `${restored.length} product(s)`);

    // ------------------------------------------------------- per-agent scope
    //
    // The listing is not the enforcement -- that is verify-policy's job -- but
    // the two answers this route gives have to differ, and each check needs a
    // control or it proves nothing.
    const { secretKey, publicKey } = generateKeyPair();
    const { data: scopedAgent } = await db
      .from("agents")
      .insert({
        merchant_id: m!.id,
        name: "Scoped Reader",
        public_key: publicKey,
        catalog_scope: ["office"],
      })
      .select()
      .single();

    const signedGet = async () => {
      // Fresh nonce per call: the route verifies, and a replayed one is refused.
      const u = new URL(`${BASE}/api/m/${slug}/catalog?t=${Date.now()}${Math.random()}`);
      const signed = signRequest({
        secretKeyBase64: secretKey,
        keyid: scopedAgent!.id,
        method: "GET",
        path: u.pathname + u.search,
        authority: u.host,
        body: "",
      });
      const r = await fetch(u, { headers: { accept: "application/json", ...signed } });
      return { status: r.status, body: (await r.json()) as { catalog: { sku: string; category: string }[]; scope?: { categories: string[] | null } } };
    };

    const scopedView = await signedGet();
    const officeOnly = scopedView.body.catalog.every((c) => c.category === "office");
    check(
      "a signed request gets the agent's scoped catalog",
      scopedView.status === 200 && officeOnly && scopedView.body.catalog.length > 0,
      `${scopedView.body.catalog.length} item(s), all office`
    );

    // THE CONTROL. Same route, same instant, no signature.
    const publicView = await (await fetch(`${BASE}/api/m/${slug}/catalog?t=${Date.now()}`, { cache: "no-store" })).json() as { catalog: { sku: string }[] };
    check(
      "CONTROL: an unsigned request still gets the full active catalog",
      publicView.catalog.length > scopedView.body.catalog.length,
      `${publicView.catalog.length} unsigned vs ${scopedView.body.catalog.length} scoped`
    );

    check(
      "the scoped answer says what the scope is",
      JSON.stringify(scopedView.body.scope?.categories) === JSON.stringify(["office"]),
      JSON.stringify(scopedView.body.scope?.categories)
    );

    // A signature that is present but wrong is refused, not silently downgraded
    // to the public view -- an agent that signed and got the unscoped catalog
    // would propose purchases the engine then blocks, with no visible cause.
    const badUrl = new URL(`${BASE}/api/m/${slug}/catalog?t=${Date.now()}`);
    const badRes = await fetch(badUrl, {
      headers: {
        accept: "application/json",
        "content-digest": computeContentDigest(""),
        "signature-input": `sig1=("@method" "@path" "@authority" "content-digest");created=${Math.floor(Date.now() / 1000)};keyid="${scopedAgent!.id}";alg="ed25519";nonce="${crypto.randomUUID()}"`,
        signature: "sig1=:AAAA:",
      },
    });
    check("a present-but-invalid signature is refused", badRes.status === 401, `HTTP ${badRes.status}`);

    // counter-offer candidacy follows the scope. Asserted BEFORE scoping so
    // "not a candidate" is a change rather than a fact about an empty list.
    const wideCandidates = await fetchCatalog(db, m!.id, null);
    const scopedCandidates = await fetchCatalog(db, m!.id, ["office"]);
    check(
      "an electronics product is a candidate for an unscoped agent",
      wideCandidates.some((c) => c.category === "electronics"),
      `${wideCandidates.length} candidate(s)`
    );
    check(
      "and is NOT a candidate for an office-scoped agent",
      !scopedCandidates.some((c) => c.category === "electronics") && scopedCandidates.length > 0,
      `${scopedCandidates.length} candidate(s), all office`
    );
    check(
      "an empty scope yields no candidates at all",
      (await fetchCatalog(db, m!.id, [])).length === 0,
      "0 candidates"
    );

    // ------------------------------------------------------------- headroom
    //
    // THE CLAIM section 10 has been overstating: the same catalog renders
    // differently per agent, for a reason the merchant chose. Pass one found it
    // false -- the view took no agent and probed as the merchant's own identity,
    // so it was identical for everyone. Asserted here directly rather than
    // described.
    //
    // Evaluated through the same pure engine the wire path uses. Signing as a
    // third-party agent is impossible by design (its private key is never
    // generated, stored or reachable here), so a per-agent probe cannot go over
    // the wire -- and if it could, the isolation the buyer demonstrates would be
    // a claim rather than a fact.
    await db.from("policy_rules").insert({
      merchant_id: m!.id,
      type: "catalog_scope" as never,
      name: "Agents keep to their assigned catalog",
      params: {},
      status: "active",
      source: "human",
      rationale: "verify-catalog",
    });

    const wideKeys = generateKeyPair();
    const { data: wideAgent } = await db
      .from("agents")
      .insert({ merchant_id: m!.id, name: "Unscoped Buyer", public_key: wideKeys.publicKey })
      .select()
      .single();

    // Rules read straight from the table rather than through getActiveRules:
    // that module imports "server-only", which throws outside Next's server
    // context, and this is a CLI script. Same reason src/lib/demo/shared.ts
    // builds its own admin client.
    const { data: ruleRows } = await db
      .from("policy_rules")
      .select("id, type, name, params")
      .eq("merchant_id", m!.id)
      .eq("status", "active");
    const rules = (ruleRows ?? []) as PolicyRule[];

    // Empty aggregates are correct HERE and only here: this merchant is fresh,
    // so catalog_scope is the only active rule and nothing being asserted
    // depends on velocity counts or daily totals.
    const aggregates = { velocityCounts: {}, dailyAmountSoFar: {} };

    const verdictsFor = async (agent: { id: string; trust_score: number; catalog_scope: string[] | null }) => {
      const live = await fetchCatalog(db, m!.id);
      return live.map((item) => ({
        sku: item.sku,
        category: item.category,
        decision:
          evaluatePolicy(
            {
              actionType: "order.create",
              amount: item.priceInPaise,
              currency: "INR",
              category: item.category,
              agentId: agent.id,
              agentTrustScore: agent.trust_score,
              agentCatalogScope: agent.catalog_scope,
            },
            rules,
            aggregates
          )?.decision ?? "allow",
      }));
    };

    const { data: scopedFull } = await db.from("agents").select("id, trust_score, catalog_scope").eq("id", scopedAgent!.id).single();
    const { data: wideFull } = await db.from("agents").select("id, trust_score, catalog_scope").eq("id", wideAgent!.id).single();

    const scopedVerdicts = await verdictsFor(scopedFull!);
    const wideVerdicts = await verdictsFor(wideFull!);

    const differing = scopedVerdicts.filter(
      (v, i) => v.decision !== wideVerdicts[i].decision
    );
    check(
      "HEADROOM: two agents render the SAME catalog differently",
      differing.length > 0,
      `${differing.length} of ${scopedVerdicts.length} products differ`
    );
    check(
      "the difference is the scope, on non-office products",
      differing.every((d) => d.category !== "office") && differing.every((d) => d.decision === "block"),
      differing.map((d) => `${d.sku}:${d.decision}`).slice(0, 3).join(" ")
    );
    // CONTROL: both agents see the same NUMBER of products -- the catalog is
    // unscoped for headroom on purpose, so the difference is in the verdicts
    // rather than in things quietly vanishing.
    check(
      "CONTROL: both see every product, they just judge them differently",
      scopedVerdicts.length === wideVerdicts.length && scopedVerdicts.length > 0,
      `${scopedVerdicts.length} products each`
    );

    // Seeded products must all carry a category the engine can match on, or a
    // category_block rule silently misses them.
    const unknown = restored.filter((c) => !(PRODUCT_CATEGORIES as readonly string[]).includes(c.category));
    check("every seeded product has a known category", unknown.length === 0, unknown.map((u) => u.category).join(", "));
  } finally {
    await db.from("merchants").delete().eq("id", m!.id);
  }

  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
