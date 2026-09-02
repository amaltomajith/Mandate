/**
 * The cooperative-pause contract.
 *
 * The property under test is a negative one, and negatives are where this
 * design is easiest to get wrong: pausing an agent must change what it is TOLD
 * and nothing else. If it also changed what the engine does, a paused agent
 * that kept calling would flood the trace log with refusals, spend its velocity
 * budget on them, and lose trust for having been paused — which is the trust
 * trapdoor from the handover in a new costume, and is exactly what an earlier
 * version of this feature did.
 *
 * So the central case is deliberately adversarial: pause an agent, then have it
 * ignore that and transact anyway. It must be judged exactly as before.
 *
 * Usage: npx tsx scripts/verify-agent-control.ts   (needs the dev server running)
 */
import { randomUUID } from "node:crypto";
import "./lib/loadEnv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as ed from "@noble/ed25519";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { generateKeyPair } from "../src/lib/webBotAuth/keys";
import { MandateClient } from "../src/lib/demo/mandateClient";
import { applySeedProducts, fetchCatalog } from "../src/lib/demo/catalog";

ed.hashes.sha512 = sha512;

const db: SupabaseClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);
const BASE = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(58)} ${detail}`);
}

/** Signs a GET the same way the buyer does. Copied rather than imported so this
 *  test exercises the wire format, not a shared helper agreeing with itself. */
async function control(slug: string, agentId: string, secret: string) {
  const url = new URL(`${BASE}/api/m/${slug}/agent-control`);
  const digest = `sha-256=:${Buffer.from(sha256(new TextEncoder().encode(""))).toString("base64")}:`;
  const created = Math.floor(Date.now() / 1000);
  const sigInput = `sig1=("@method" "@path" "@authority" "content-digest");created=${created};keyid="${agentId}";alg="ed25519";nonce="${randomUUID()}"`;
  const base = [
    `"@method": GET`,
    `"@path": ${url.pathname}`,
    `"@authority": ${url.host}`,
    `"content-digest": ${digest}`,
    `"@signature-params": ${sigInput.replace(/^sig1=/, "")}`,
  ].join("\n");
  const sig = ed.sign(new TextEncoder().encode(base), Buffer.from(secret, "base64"));
  const res = await fetch(url, {
    headers: {
      "content-digest": digest,
      "signature-input": sigInput,
      signature: `sig1=:${Buffer.from(sig).toString("base64")}:`,
    },
  });
  return { status: res.status, body: res.ok ? ((await res.json()) as Record<string, unknown>) : null };
}

async function makeTenant(label: string) {
  const slug = `ac-${label}-${Math.random().toString(36).slice(2, 7)}`;
  const { data: merchant } = await db
    .from("merchants")
    .insert({ name: `Control ${label}`, slug })
    .select()
    .single();
  await applySeedProducts(db, merchant!.id);
  const { secretKey, publicKey } = generateKeyPair();
  const { data: agent } = await db
    .from("agents")
    .insert({ merchant_id: merchant!.id, name: "Buyer", public_key: publicKey })
    .select()
    .single();
  return { merchantId: merchant!.id, slug, agentId: agent!.id, secret: secretKey };
}

async function enforceCount(merchantId: string) {
  const { count } = await db
    .from("traces")
    .select("*", { count: "exact", head: true })
    .eq("merchant_id", merchantId)
    .eq("mode", "enforce");
  return count ?? 0;
}

async function main() {
  const A = await makeTenant("a");
  const B = await makeTenant("b");
  console.log(`tenant A ${A.slug}\ntenant B ${B.slug}\n`);

  try {
    const catalog = await fetchCatalog(db, A.merchantId);
    const mouse = catalog.find((c) => c.sku === "mouse-01")!;
    const client = new MandateClient(BASE, A.slug, A.agentId, A.secret);

    // ---- Defaults, and that the endpoint answers at all.
    const active = await control(A.slug, A.agentId, A.secret);
    check(
      "a signed agent is told it may work",
      active.status === 200 && active.body?.status === "active",
      `HTTP ${active.status}, status ${active.body?.status}, pace ${active.body?.pace_ms}`
    );

    // ---- It must not leak policy. This endpoint says whether to work, never
    //      how the work will be judged.
    const leaked = JSON.stringify(active.body ?? {}).toLowerCase();
    check(
      "the answer carries no policy, thresholds or catalog",
      !/threshold|max_amount|cap|rule|trust_score|sku|price/.test(leaked),
      Object.keys(active.body ?? {}).join(", ")
    );

    // ---- Polling must be free. An agent asked to poll every 30s that paid a
    //      rate slot for each poll would be rate-limited by obeying.
    const before = await enforceCount(A.merchantId);
    for (let i = 0; i < 5; i++) await control(A.slug, A.agentId, A.secret);
    const after = await enforceCount(A.merchantId);
    check("polling writes no trace and spends no budget", after === before, `${before} -> ${after}`);

    // ---- Cross-tenant. A's key is not in B's roster.
    const cross = await control(B.slug, A.agentId, A.secret);
    check("A cannot read its status from B's endpoint", cross.status === 401, `HTTP ${cross.status}`);

    // ---- Unsigned.
    const bare = await fetch(`${BASE}/api/m/${A.slug}/agent-control`);
    check("an unsigned request is refused", bare.status === 401, `HTTP ${bare.status}`);

    // ---- THE CASE. Pause, then ignore the pause and transact anyway.
    await db.from("agents").update({ status: "paused" }).eq("id", A.agentId);

    const told = await control(A.slug, A.agentId, A.secret);
    check(
      "a paused agent is told to stop",
      told.body?.status === "paused",
      String(told.body?.message ?? "").slice(0, 46)
    );

    const { data: beforeTrust } = await db.from("agents").select("trust_score").eq("id", A.agentId).single();
    const beforeCount = await enforceCount(A.merchantId);

    const defiant = await client.callTool<{ decision: string; reasoning: string }>("enforce_action", {
      actionType: "order.create",
      amount: mouse.priceInPaise,
      currency: "INR",
      category: mouse.category,
      params: { receipt: `defy-${Date.now()}`, notes: { sku: mouse.sku } },
    });

    check(
      "a paused agent that transacts anyway is judged normally",
      defiant.decision === "allow",
      `${defiant.decision} — ${defiant.reasoning.slice(0, 44)}`
    );

    const { data: afterTrust } = await db.from("agents").select("trust_score").eq("id", A.agentId).single();
    check(
      "being paused did not cost it trust",
      (afterTrust?.trust_score ?? 0) >= (beforeTrust?.trust_score ?? 0),
      `${beforeTrust?.trust_score.toFixed(1)} -> ${afterTrust?.trust_score.toFixed(1)}`
    );

    // One trace, for the one action it actually took — not a refusal on top.
    check(
      "exactly one trace for one action, no refusal added",
      (await enforceCount(A.merchantId)) === beforeCount + 1,
      `+${(await enforceCount(A.merchantId)) - beforeCount}`
    );

    // ---- Resuming, and pace.
    await db.from("agents").update({ status: "active", pace_ms: 45000 }).eq("id", A.agentId);
    const resumed = await control(A.slug, A.agentId, A.secret);
    check(
      "resuming and pace are reported back",
      resumed.body?.status === "active" && resumed.body?.pace_ms === 45000,
      `${resumed.body?.status}, pace ${resumed.body?.pace_ms}`
    );

    // ---- The spec is public and carries no secret.
    const specRes = await fetch(`${BASE}/api/m/${A.slug}/agent-spec`);
    const spec = (await specRes.json()) as { rules?: unknown[]; endpoints?: Record<string, string> };
    // Looks for key MATERIAL, not the word "private". The first version of
    // this check matched /private/ and failed on the spec's own sentence
    // telling the reader we never want their private key -- flagging the exact
    // text that makes the point as a leak of it.
    const specText = JSON.stringify(spec);
    check(
      "the compatibility contract is public and complete",
      specRes.status === 200 && (spec.rules?.length ?? 0) >= 10,
      `${spec.rules?.length} rules`
    );
    check(
      "and contains no key material",
      !/-----BEGIN|[A-Za-z0-9+/]{43}=/.test(specText),
      "no private key, by construction"
    );
    check(
      "with this merchant's real URLs",
      Object.values(spec.endpoints ?? {}).every((u) => u.includes(A.slug)),
      spec.endpoints?.agentControl ?? ""
    );
  } finally {
    await db.from("merchants").delete().in("id", [A.merchantId, B.merchantId]);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  for (const f of failed) console.log(`  FAILED: ${f.name} — ${f.detail}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
