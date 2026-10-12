/**
 * Collecting on credit: the agent reminds politely, never nags, and stops. Checks
 * the reminder schedule (pure), then the real thing against the database with a
 * stubbed send: who is reminded, how often, the cap, the hand-over to the owner,
 * that a payment starts a fresh stretch, that every figure in a message comes
 * from the ledger, and the morning briefing's line about what is owed.
 *
 *   npx tsx --tsconfig worker/tsconfig.json scripts/verify-collections.ts
 */
import "./lib/loadEnv";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "../src/lib/supabase/admin";
import { ensureWorkspace } from "../src/lib/workspace";
import { getSettings } from "../src/lib/settings";
import { receivePayment, sellOnCredit, type Receivable } from "../src/lib/credit";
import type { Session } from "../worker/src/session";
import { MAX_REMINDERS, REMINDER_GAP_DAYS, planReminder, reminderMessage, runCollections } from "../worker/src/agents/collections";
import { sendBriefingIfDue } from "../worker/src/owner/owner";
import { ChannelService } from "../worker/src/channels/service";
import { SandboxDriver } from "../worker/src/channels/sandbox";
import type { Channel } from "../src/types/db";
import type { ChannelDriver } from "../worker/src/channels/types";

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
const DAY = 86_400_000;

const recv = (over: Partial<Receivable> = {}): Receivable => ({ customerId: "c", name: "Ravi", limitPaise: rupees(5000), termsDays: 15, owedPaise: rupees(3000), overduePaise: rupees(2000), oldestDueAt: new Date(Date.now() - 5 * DAY).toISOString(), lastPaymentAt: null, ...over });

async function main() {
  const now = new Date();
  console.log("the schedule");
  {
    check("nothing overdue means nothing sent", planReminder(recv({ overduePaise: 0 }), [], null, now) === "none");
    check("the first overdue reminder goes out", planReminder(recv(), [], null, now) === "remind");
    check("not again within the gap", planReminder(recv(), [new Date(now.getTime() - (REMINDER_GAP_DAYS - 1) * DAY)], null, now) === "none");
    check("again once the gap has passed", planReminder(recv(), [new Date(now.getTime() - (REMINDER_GAP_DAYS + 1) * DAY)], null, now) === "remind");
    const three = Array.from({ length: MAX_REMINDERS }, (_, i) => new Date(now.getTime() - (30 - i * 5) * DAY));
    check("after the maximum, the owner is told", planReminder(recv(), three, null, now) === "escalate");
    check("and told only once", planReminder(recv(), three, new Date(now.getTime() - DAY), now) === "none");
    check("a payment starts a fresh stretch: earlier reminders no longer count", planReminder(recv({ lastPaymentAt: new Date(now.getTime() - DAY).toISOString() }), three, null, now) === "remind");
    const msg = reminderMessage({ customer: "Ravi", store: "Demo", overduePaise: rupees(2000), owedPaise: rupees(3000) });
    check("the message states what is due and what is owed in all", msg.text.includes("₹2,000") && msg.text.includes("₹3,000 in all"));
    check("and offers a way out if they already paid", /already paid/.test(msg.text));
  }

  const rnd = Math.random().toString(36).slice(2, 8);
  const { data: m } = await db.from("merchants").insert({ name: "collect", slug: `verify-collect-${rnd}` }).select("*").single();
  await ensureWorkspace(db, m.id);
  try {
    const settings = await getSettings(db, m.id);
    const { data: product } = await db.from("products").select("id, sku").eq("merchant_id", m.id).limit(1).single();
    const sku = product!.sku as string;
    await db.from("products").update({ price_paise: rupees(1000), stock_qty: 100, active: true }).eq("id", product!.id);
    const mk = async (name: string, limit: number) => (await db.from("customers").insert({ merchant_id: m.id, name, email: `${name}-${rnd}@c.sandbox.test`, credit_limit_paise: rupees(limit), credit_terms_days: 10 }).select("*").single()).data!;
    const ravi = await mk("Ravi", 5000);
    const fine = await mk("Fine", 5000);
    const sent: { customer_id: string; body: string }[] = [];
    const session = {
      db,
      merchant: { id: m.id, slug: m.slug },
      settings,
      call: async (tool: string, args: Record<string, unknown>) => {
        if (tool === "channels_send_message_to_customer") sent.push({ customer_id: args.customer_id as string, body: String(args.body) });
        return {};
      },
    } as unknown as Session;
    const overdue = async (customer: string, daysAgo: number) => db.from("credit_entries").update({ due_at: new Date(Date.now() - daysAgo * DAY).toISOString() }).eq("customer_id", customer).eq("kind", "sale");
    const reminders = async (customer: string) => (await db.from("credit_reminders").select("message, created_at").eq("customer_id", customer).order("created_at")).data ?? [];

    await sellOnCredit(db, m.id, ravi.id, [{ sku, qty: 2 }], "owner");
    await sellOnCredit(db, m.id, fine.id, [{ sku, qty: 1 }], "owner");

    console.log("only the overdue are reminded");
    {
      const out = await runCollections(session, "Demo Store", now);
      check("nobody is reminded while nothing is due", sent.length === 0 && out.length === 0, JSON.stringify(out));
      await overdue(ravi.id, 3);
      const out2 = await runCollections(session, "Demo Store", now);
      check("the customer whose sale is past due is reminded", sent.length === 1 && sent[0].customer_id === ravi.id, JSON.stringify(out2));
      check("the amount in the message is the ledger's, ₹2,000", sent[0].body.includes("₹2,000"), sent[0].body);
      check("the customer who is within terms is not", !sent.some((x) => x.customer_id === fine.id));
      check("the reminder is recorded", (await reminders(ravi.id)).length === 1);
    }

    console.log("it does not nag");
    {
      await runCollections(session, "Demo Store", now);
      check("running again straight away sends nothing", sent.length === 1);
      await runCollections(session, "Demo Store", new Date(now.getTime() + 4 * DAY));
      check("after the gap, a second reminder", sent.length === 2);
      await runCollections(session, "Demo Store", new Date(now.getTime() + 8 * DAY));
      check("and a third", sent.length === 3);
    }

    console.log("then a person takes over, once");
    {
      const later = new Date(now.getTime() + 12 * DAY);
      const out = await runCollections(session, "Demo Store", later);
      check("no fourth reminder to Ravi", sent.filter((x) => x.customer_id === ravi.id).length === 3, String(sent.length));
      const { data: alerts } = await db.from("alerts").select("message, severity").eq("merchant_id", m.id);
      check("the owner is told, with the amount owed", (alerts ?? []).some((a) => /Ravi still owes ₹2,000/.test(a.message) && a.severity === "notable"), JSON.stringify(alerts));
      check("and the run says so", out.some((o) => /owner has been told/.test(o)));
      await runCollections(session, "Demo Store", new Date(now.getTime() + 16 * DAY));
      check("the owner is not told twice about Ravi", ((await db.from("alerts").select("message").eq("merchant_id", m.id)).data ?? []).filter((a) => /Ravi/.test(a.message)).length === 1);
    }

    console.log("paying starts a fresh stretch");
    {
      await receivePayment(db, m.id, ravi.id, rupees(500), "owner");
      // still owes 1,500, overdue; the earlier reminders were before this payment
      const before = sent.length;
      await runCollections(session, "Demo Store", new Date(Date.now() + DAY));
      check("a customer who paid something is reminded again about the rest", sent.length === before + 1 && sent[sent.length - 1].body.includes("₹1,500"), sent[sent.length - 1]?.body);
    }

    console.log("a customer who has paid in full is left alone");
    {
      await receivePayment(db, m.id, ravi.id, rupees(1500), "owner");
      const before = sent.length;
      await runCollections(session, "Demo Store", new Date(Date.now() + 30 * DAY));
      check("no reminder", sent.length === before || sent.slice(before).every((x) => x.customer_id !== ravi.id));
    }

    console.log("a credit customer may be messaged even if they never opted in");
    {
      const wa: ChannelDriver = { channel: "sandbox" as Channel, live: false, send: async () => ({ externalId: "x" }), poll: async () => [] };
      void wa;
      const svc = new ChannelService(db, m.id, "sandbox", new Map<Channel, ChannelDriver>([["sandbox", new SandboxDriver()]]));
      const lone = await mk("Lone", 1000);
      await db.from("customers").update({ marketing_opt_in: false }).eq("id", lone.id);
      const noRelationship = await svc.send({ kind: "buyer", customerId: lone.id, body: "hello" }).then(() => "sent", (e) => String(e.message));
      check("with no relationship at all, it is refused as before", /not opted in/.test(noRelationship), noRelationship);
      await sellOnCredit(db, m.id, lone.id, [{ sku, qty: 1 }], "owner");
      const withCredit = await svc.send({ kind: "buyer", customerId: lone.id, body: "reminder" }).then(() => "sent", (e) => String(e.message));
      check("with a credit account it is allowed", withCredit === "sent", withCredit);
    }

    console.log("the morning briefing mentions what is owed");
    {
      await db.from("merchant_settings").update({ owner_phone: "+919876543210", owner_briefing_enabled: true }).eq("merchant_id", m.id);
      const s2 = await getSettings(db, m.id);
      await sendBriefingIfDue(db, m.id, s2, undefined, new Date());
      const b = (await db.from("owner_messages").select("body").eq("merchant_id", m.id).eq("kind", "briefing").order("created_at", { ascending: false }).limit(1)).data?.[0];
      check("it says how much is owed on credit", /Owed to you on credit: Rs /.test(b?.body ?? ""), b?.body);
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
