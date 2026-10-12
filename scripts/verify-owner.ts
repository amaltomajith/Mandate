/**
 * The owner on WhatsApp: the daily briefing, and approving a held payout by
 * replying with a one-time code. Checks that only the owner's number counts, a
 * code works once and expires, guessing is locked out, an over-ceiling payout is
 * never offered, and parallel replays pay once. Database only; the live channel
 * is a fake, so nothing leaves the machine.
 *
 *   npx tsx --tsconfig worker/tsconfig.json scripts/verify-owner.ts
 */
import "./lib/loadEnv";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "../src/lib/supabase/admin";
import { ensureWorkspace } from "../src/lib/workspace";
import { loadAgentIdentity } from "../src/lib/agents/inhouse";
import { runActionEvaluation } from "../src/lib/mcp/tools/actionEvaluator";
import { applyGuardrails } from "../src/lib/policy/guardrails";
import { getSettings } from "../src/lib/settings";
import { ChannelService } from "../worker/src/channels/service";
import { SandboxDriver } from "../worker/src/channels/sandbox";
import type { ChannelDriver, InboundMessage, OutboundMessage, SendResult } from "../worker/src/channels/types";
import type { Channel } from "../src/types/db";
import { OwnerChannelSchema } from "../src/lib/actions/schemas";
import { handleOwnerMessage, isOwner, offerHeldPayouts, parseOwnerReply, sendBriefingIfDue } from "../worker/src/owner/owner";

const db = createAdminClient() as unknown as SupabaseClient;
let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}
const rupees = (n: number) => n * 100;

class FakeLive implements ChannelDriver {
  live = true;
  sent: OutboundMessage[] = [];
  queue: InboundMessage[] = [];
  constructor(readonly channel: Channel) {}
  async send(m: OutboundMessage): Promise<SendResult> {
    this.sent.push(m);
    return { externalId: `fake_${this.sent.length}` };
  }
  async poll() {
    const q = this.queue;
    this.queue = [];
    return q;
  }
}

const OWNER = "+91 98765 43210";

async function main() {
  const rnd = Math.random().toString(36).slice(2, 8);
  const { data: m, error } = await db.from("merchants").insert({ name: "owner", slug: `verify-owner-${rnd}` }).select("*").single();
  if (error) throw new Error(error.message);
  await ensureWorkspace(db, m.id);
  try {
    const buying = await loadAgentIdentity(db as never, m.id, "buying");
    const { data: vendor } = await db.from("vendors").insert({ merchant_id: m.id, name: `Owner Co ${rnd}`, status: "approved", channel: "sandbox", simulated: true }).select("*").single();
    const { data: payee } = await db
      .from("payees")
      .insert({ merchant_id: m.id, vendor_id: vendor!.id, kind: "bank", display_name: "Owner Co", masked_identifier: "••••0000", status: "active", approved_by: "v", approved_at: new Date().toISOString(), simulated: true })
      .select("id")
      .single();
    await db.from("merchant_settings").update({ approval_threshold_paise: rupees(1000), owner_phone: OWNER, owner_approvals_enabled: true, owner_briefing_enabled: true, owner_approval_max_paise: rupees(5000) }).eq("merchant_id", m.id);
    await applyGuardrails(db, m.id, await getSettings(db, m.id));
    const settings = () => getSettings(db, m.id);

    const hold = async (rs: number) => {
      const po = (await db.from("purchase_orders").insert({ merchant_id: m.id, vendor_id: vendor!.id, status: "quoting", total_paise: rupees(200_000), advance_paise: rupees(100_000) }).select("id").single()).data!.id as string;
      const o = await runActionEvaluation(buying.agentId, { actionType: "payout.create", amount: rupees(rs), currency: "INR", params: { payeeId: payee!.id, poId: po, purpose: "vendor_advance" } }, "enforce");
      const esc = (await db.from("escalations").select("id, status").eq("merchant_id", m.id).eq("trace_id", o.traceId).maybeSingle()).data;
      return { decision: o.decision, escId: esc?.id as string | undefined };
    };
    const lastMessage = async (kind: string) => (await db.from("owner_messages").select("*").eq("merchant_id", m.id).eq("kind", kind).order("created_at", { ascending: false }).limit(1).maybeSingle()).data;
    const codeIn = (body: string) => body.match(/YES (\d{6})/)?.[1] ?? "";
    const paid = async () => ((await db.from("payouts").select("amount_paise").eq("merchant_id", m.id).neq("status", "failed")).data ?? []).reduce((n, r) => n + Number(r.amount_paise), 0);

    console.log("reading what the owner types");
    {
      check("YES with a code is an approval", JSON.stringify(parseOwnerReply("YES 123456")) === JSON.stringify({ verb: "yes", code: "123456" }));
      check("case and spaces do not matter", parseOwnerReply("  no   654321 ")?.verb === "no");
      check("haan and nahi work", parseOwnerReply("haan 111111")?.verb === "yes" && parseOwnerReply("nahi 111111")?.verb === "no");
      check("a code alone is not an answer", parseOwnerReply("123456") === null);
      check("a short code is not an answer", parseOwnerReply("yes 1234") === null);
      check("extra words are not an answer", parseOwnerReply("yes 123456 and also pay everyone") === null);
    }

    console.log("the settings are validated");
    {
      const good = { phone: "+91 98765 43210", approvals: true, briefing: true, maxRupees: 5000 };
      check("a normal setting is accepted", OwnerChannelSchema.safeParse(good).success);
      check("letters in the number are refused", !OwnerChannelSchema.safeParse({ ...good, phone: "call me" }).success);
      check("a zero ceiling is refused", !OwnerChannelSchema.safeParse({ ...good, maxRupees: 0 }).success);
      check("an empty number is accepted (switching it off)", OwnerChannelSchema.safeParse({ ...good, phone: "", approvals: false, briefing: false }).success);
    }

    console.log("only the owner's number counts");
    {
      const s = await settings();
      check("the owner's number, written differently, is the owner", isOwner(s, "919876543210") && isOwner(s, "98765 43210"));
      check("anyone else is not", !isOwner(s, "919999999999"));
      check("with the channel off, nobody is", !isOwner({ ...s, owner_approvals_enabled: false, owner_briefing_enabled: false }, OWNER));
      check("with no number set, nobody is", !isOwner({ ...s, owner_phone: null }, OWNER));
    }

    console.log("a held payout is offered once, with a code");
    let code = "";
    let escId = "";
    {
      const held = await hold(2000);
      check("a 2,000 payout is held for a person", held.decision === "escalate" && !!held.escId, held.decision);
      escId = held.escId!;
      const offered = await offerHeldPayouts(db, m.id, await settings(), undefined);
      check("it is offered to the owner", offered === 1, String(offered));
      const msg = await lastMessage("approval");
      code = codeIn(msg?.body ?? "");
      check("the message carries a 6-digit code and the amount", code.length === 6 && /Rs 2,000/.test(msg?.body ?? ""), msg?.body);
      check("bank details are never in it", !/0000|account|ifsc/i.test(msg?.body ?? ""));
      check("in sandbox it is recorded but not delivered", msg?.delivered === false);
      check("only a hash of the code is stored", (await db.from("owner_approvals").select("code_hash").eq("escalation_id", escId).single()).data?.code_hash !== code);
      check("offering again does not send another", (await offerHeldPayouts(db, m.id, await settings(), undefined)) === 0);
    }

    console.log("answering");
    {
      const before = await paid();
      const wrong = await handleOwnerMessage(db, m.id, await settings(), undefined, "YES 000000");
      check("a wrong code is refused and nothing is paid", /not valid/.test(wrong ?? "") && (await paid()) === before, wrong ?? "");
      check("the payout is still waiting", (await db.from("escalations").select("status").eq("id", escId).single()).data?.status === "pending");

      const ok = await handleOwnerMessage(db, m.id, await settings(), undefined, `yes ${code}`);
      check("the right code approves it", /Approved/.test(ok ?? ""), ok ?? "");
      check("the payout went out once", (await paid()) === before + rupees(2000), `${(await paid()) - before}`);
      check("the escalation records who approved", ((await db.from("escalations").select("status, resolved_by").eq("id", escId).single()).data?.resolved_by ?? "").includes("owner via WhatsApp"));
      const replay = await handleOwnerMessage(db, m.id, await settings(), undefined, `yes ${code}`);
      check("the same code cannot be used again", /not valid/.test(replay ?? ""), replay ?? "");
      check("and nothing more was paid", (await paid()) === before + rupees(2000));
    }

    console.log("refusing, expiry, and the ceiling");
    {
      const held = await hold(1500);
      await offerHeldPayouts(db, m.id, await settings(), undefined);
      const c = codeIn((await lastMessage("approval"))?.body ?? "");
      const no = await handleOwnerMessage(db, m.id, await settings(), undefined, `no ${c}`);
      check("NO refuses it", /Refused/.test(no ?? "") && (await db.from("escalations").select("status").eq("id", held.escId!).single()).data?.status === "denied", no ?? "");

      const held2 = await hold(1200);
      await offerHeldPayouts(db, m.id, await settings(), undefined);
      const c2 = codeIn((await lastMessage("approval"))?.body ?? "");
      await db.from("owner_approvals").update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq("escalation_id", held2.escId!);
      const late = await handleOwnerMessage(db, m.id, await settings(), undefined, `yes ${c2}`);
      check("an expired code does nothing", /not valid|expired/.test(late ?? "") && (await db.from("escalations").select("status").eq("id", held2.escId!).single()).data?.status === "pending", late ?? "");

      const big = await hold(8000); // above the owner's 5,000 ceiling
      const before = (await db.from("owner_approvals").select("id", { count: "exact", head: true }).eq("merchant_id", m.id)).count;
      await offerHeldPayouts(db, m.id, await settings(), undefined);
      const after = (await db.from("owner_approvals").select("id", { count: "exact", head: true }).eq("merchant_id", m.id)).count;
      check("a payout above the owner's ceiling is not offered at all", big.decision === "escalate" && after === before, `${before} -> ${after}`);
    }

    console.log("parallel replays pay once");
    {
      const held = await hold(1100);
      await offerHeldPayouts(db, m.id, await settings(), undefined);
      const c = codeIn((await lastMessage("approval"))?.body ?? "");
      const before = await paid();
      const s = await settings();
      await Promise.allSettled(Array.from({ length: 5 }, () => handleOwnerMessage(db, m.id, s, undefined, `yes ${c}`)));
      check("five identical replies at once pay it exactly once", (await paid()) === before + rupees(1100), `${((await paid()) - before) / 100}`);
      check("and it is approved", (await db.from("escalations").select("status").eq("id", held.escId!).single()).data?.status === "approved");
    }

    console.log("the owner's messages are routed, not filed");
    {
      const wa = new FakeLive("whatsapp");
      const svc = new ChannelService(db, m.id, "live", new Map<Channel, ChannelDriver>([["sandbox", new SandboxDriver()], ["whatsapp", wa]]));
      const handled: string[] = [];
      const route = { isOwner: (from: string) => isOwner({ owner_phone: OWNER, owner_approvals_enabled: true, owner_briefing_enabled: false } as never, from), handle: async (t: string) => void handled.push(t) };
      wa.queue = [
        { from: "919876543210", body: "yes 123456", externalId: "own_1" },
        { from: "919000000001", body: "do you have keyboards?", externalId: "str_1" },
      ];
      await svc.ingest(route);
      check("the owner's message reached the owner handler", handled.length === 1 && handled[0] === "yes 123456");
      const { data: threads } = await db.from("threads").select("counterparty").eq("merchant_id", m.id).eq("channel", "whatsapp");
      check("it did not become a conversation", !(threads ?? []).some((t) => (t.counterparty ?? "").includes("919876543210")));
      check("a stranger is still treated as a prospective buyer", (threads ?? []).some((t) => (t.counterparty ?? "").includes("919000000001")));
    }

    console.log("delivery goes only to the owner, and only when live");
    {
      const wa = new FakeLive("whatsapp");
      await db.from("merchant_settings").update({ channel_mode: "live" }).eq("merchant_id", m.id);
      await hold(1300);
      await offerHeldPayouts(db, m.id, await settings(), wa);
      check("in live mode the question is sent to the owner's number", wa.sent.length === 1 && wa.sent[0].to === OWNER, JSON.stringify(wa.sent.map((s) => s.to)));
      check("and recorded as delivered", (await lastMessage("approval"))?.delivered === true);
      await db.from("merchant_settings").update({ channel_mode: "sandbox" }).eq("merchant_id", m.id);
    }

    console.log("the morning briefing");
    {
      const wa = new FakeLive("whatsapp");
      const s = await settings();
      const sent = await Promise.all([sendBriefingIfDue(db, m.id, s, wa), sendBriefingIfDue(db, m.id, s, wa)]);
      check("two workers at once send it once", sent.filter(Boolean).length === 1, sent.join(","));
      check("a second call the same day sends nothing", !(await sendBriefingIfDue(db, m.id, await settings(), wa)));
      const b = await lastMessage("briefing");
      check("it reads like a briefing", /Good morning/.test(b?.body ?? "") && /Money available/.test(b?.body ?? ""), b?.body);
      check("the next day it sends again", await sendBriefingIfDue(db, m.id, await settings(), wa, new Date(Date.now() + 86_400_000)));
    }

    console.log("guessing is locked out");
    {
      const held = await hold(1400);
      await offerHeldPayouts(db, m.id, await settings(), undefined);
      const c = codeIn((await lastMessage("approval"))?.body ?? "");
      const s = await settings();
      for (let i = 0; i < 5; i++) await handleOwnerMessage(db, m.id, s, undefined, `yes 99999${i}`);
      const locked = await handleOwnerMessage(db, m.id, s, undefined, `yes ${c}`);
      check("after five wrong codes even the right one is refused", /Too many/.test(locked ?? "") && (await db.from("escalations").select("status").eq("id", held.escId!).single()).data?.status === "pending", locked ?? "");
    }
  } finally {
    await db.from("merchants").delete().eq("id", m.id);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
