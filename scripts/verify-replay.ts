/**
 * Replay protection.
 *
 * The signature base already covered `created`, and the verifier already
 * refused anything outside ±300s — so replay was never unbounded. But five
 * minutes is ample time to capture a valid enforce_action and resend it, and
 * the replay is indistinguishable from the original: same signature, same
 * digest, genuinely signed by the right agent.
 *
 * The test is the capture-and-resend itself. Sending the EXACT same bytes twice
 * is the attack; anything less proves nothing.
 */
import "./lib/loadEnv";
import { createClient } from "@supabase/supabase-js";
import { generateKeyPair } from "../src/lib/webBotAuth/keys";
import { signRequest } from "../src/lib/webBotAuth/sign";
import { applySeedProducts } from "../src/lib/demo/catalog";

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
const BASE = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
const results: [string, boolean, string][] = [];
const check = (n: string, ok: boolean, d = "") => { results.push([n, ok, d]); console.log(`${ok ? "PASS" : "FAIL"}  ${n.padEnd(52)} ${d}`); };

async function main() {
  const slug = `rp-${Math.random().toString(36).slice(2, 7)}`;
  const { data: m } = await db.from("merchants").insert({ name: "Replay", slug }).select().single();
  await applySeedProducts(db, m!.id);
  const { secretKey, publicKey } = generateKeyPair();
  const { data: agent } = await db.from("agents").insert({ merchant_id: m!.id, name: "Probe", public_key: publicKey }).select().single();

  try {
    const url = new URL(`${BASE}/api/m/${slug}/mcp`);
    const body = JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: {
        name: "enforce_action",
        arguments: { actionType: "order.create", amount: 89900, currency: "INR", category: "electronics", params: { receipt: `replay-${Date.now()}` } },
        _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} },
      },
    });
    const signed = signRequest({ secretKeyBase64: secretKey, keyid: agent!.id, method: "POST", path: url.pathname, authority: url.host, body });
    const headers = { "content-type": "application/json", accept: "application/json", "mcp-method": "tools/call", "mcp-name": "enforce_action", ...signed };

    // Counts money actions, not audit rows. A refused replay correctly writes
    // its own protocol_reject trace, and that trace is mode=enforce -- so a
    // naive enforce-mode count reads the record of the refusal as a second
    // order. The first version of this check did exactly that and failed on the
    // system behaving correctly.
    const orders = async () =>
      (
        await db
          .from("traces")
          .select("*", { count: "exact", head: true })
          .eq("merchant_id", m!.id)
          .eq("mode", "enforce")
          .neq("decision", "protocol_reject")
      ).count ?? 0;
    const before = await orders();

    // The original.
    const first = await fetch(url, { method: "POST", headers, body });
    check("a signed request is accepted", first.status === 200, `HTTP ${first.status}`);

    // The exact same bytes again. This is the attack.
    const replay = await fetch(url, { method: "POST", headers, body });
    check("the identical request replayed is refused", replay.status === 401, `HTTP ${replay.status}`);
    const reason = replay.status === 401 ? ((await replay.json()) as { reason?: string }).reason : "";
    check("refused specifically as a replayed nonce", reason === "replayed_nonce", reason ?? "");

    const after = await orders();
    check("the replay created no second order", after - before === 1, `+${after - before} money action(s)`);

    const { data: rejects } = await db.from("traces").select("decision, reasoning").eq("merchant_id", m!.id).eq("decision", "protocol_reject").order("created_at", { ascending: false }).limit(1);
    check("and is recorded as protocol_reject", rejects?.[0]?.decision === "protocol_reject", (rejects?.[0]?.reasoning ?? "").slice(0, 44));

    // A fresh nonce on otherwise identical content still works — the guard must
    // stop replays, not legitimate repeat purchases of the same thing.
    const signed2 = signRequest({ secretKeyBase64: secretKey, keyid: agent!.id, method: "POST", path: url.pathname, authority: url.host, body });
    const again = await fetch(url, { method: "POST", headers: { ...headers, ...signed2 }, body });
    check("the same purchase re-signed afresh is allowed", again.status === 200, `HTTP ${again.status}`);
  } finally {
    await db.from("merchants").delete().eq("id", m!.id);
  }

  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exitCode = failed === 0 ? 0 : 1;
}
main().catch((e) => { console.error(e); process.exit(1); });
