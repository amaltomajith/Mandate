import type { Session } from "../session";
import { getReceivables, type Receivable } from "@/lib/credit";
import { money, polish } from "./messages";

/**
 * Collecting what customers owe, politely and without nagging.
 *
 * The Selling agent only ever reminds. It cannot lend, forgive or change what is
 * owed: every figure in a reminder is read from the credit ledger, and the ledger
 * can only be written by the merchant. Reminders are rate-limited and then stop:
 * at most MAX_REMINDERS per stretch of non-payment, at least GAP_DAYS apart, and
 * after the last one the owner is told once, so a person takes over.
 */

export const REMINDER_GAP_DAYS = 3;
export const MAX_REMINDERS = 3;
const ESCALATED = "[escalated]";

export type ReminderPlan = "none" | "remind" | "escalate";

/**
 * What to do about one customer. `reminders` are the times earlier reminders were
 * sent, and `escalatedAt` when the owner was last told.
 */
export function planReminder(r: Receivable, reminders: Date[], escalatedAt: Date | null, now: Date): ReminderPlan {
  if (r.overduePaise <= 0) return "none";
  // Only reminders since the customer last paid count; paying starts a fresh stretch.
  const since = r.lastPaymentAt ? new Date(r.lastPaymentAt).getTime() : 0;
  const recent = reminders.filter((d) => d.getTime() > since).sort((a, b) => a.getTime() - b.getTime());
  if (recent.length >= MAX_REMINDERS) return escalatedAt && escalatedAt.getTime() > since ? "none" : "escalate";
  const last = recent[recent.length - 1];
  if (last && now.getTime() - last.getTime() < REMINDER_GAP_DAYS * 86_400_000) return "none";
  return "remind";
}

export function reminderMessage(p: { customer: string; store: string; overduePaise: number; owedPaise: number }): { text: string; facts: { required: string[] } } {
  const total = p.owedPaise !== p.overduePaise ? ` (${money(p.owedPaise)} in all)` : "";
  const text =
    `Hi ${p.customer}, a friendly reminder from ${p.store}: ${money(p.overduePaise)} on your account is now due${total}. ` +
    `Could you let us know when you can settle it? If you have already paid, please ignore this and tell us, and we will update our records.\n\nThank you,\n${p.store}`;
  return { text, facts: { required: [p.customer, money(p.overduePaise), p.store] } };
}

export async function runCollections(s: Session, store: string, now = new Date()): Promise<string[]> {
  const out: string[] = [];
  const receivables = (await getReceivables(s.db, s.merchant.id, now)).filter((r) => r.overduePaise > 0);
  if (receivables.length === 0) return out;
  const { data: rows } = await s.db.from("credit_reminders").select("customer_id, message, created_at").eq("merchant_id", s.merchant.id).in("customer_id", receivables.map((r) => r.customerId));

  for (const r of receivables) {
    const mine = (rows ?? []).filter((x) => x.customer_id === r.customerId);
    const sent = mine.filter((x) => !String(x.message).startsWith(ESCALATED)).map((x) => new Date(x.created_at));
    const esc = mine.filter((x) => String(x.message).startsWith(ESCALATED)).map((x) => new Date(x.created_at)).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    const plan = planReminder(r, sent, esc, now);

    if (plan === "escalate") {
      const days = r.oldestDueAt ? Math.max(1, Math.floor((now.getTime() - new Date(r.oldestDueAt).getTime()) / 86_400_000)) : 0;
      await s.db.from("alerts").insert({ merchant_id: s.merchant.id, trace_id: null, severity: "notable", message: `${r.name} still owes ${money(r.owedPaise)} (${money(r.overduePaise)} overdue${days ? `, about ${days} days` : ""}) after ${MAX_REMINDERS} reminders. A person should follow up.` });
      await s.db.from("credit_reminders").insert({ merchant_id: s.merchant.id, customer_id: r.customerId, message: `${ESCALATED} owner told` });
      out.push(`${r.name} has not paid after ${MAX_REMINDERS} reminders; the owner has been told.`);
      continue;
    }
    if (plan !== "remind") continue;

    const template = reminderMessage({ customer: r.name, store, overduePaise: r.overduePaise, owedPaise: r.owedPaise });
    const body = await polish(template.text, template.facts, "polite, warm and brief; a small shop gently reminding a regular customer about an amount due");
    try {
      await s.call("channels_send_message_to_customer", { customer_id: r.customerId, body });
      await s.db.from("credit_reminders").insert({ merchant_id: s.merchant.id, customer_id: r.customerId, message: body.slice(0, 1000) });
      out.push(`Reminded ${r.name} about ${money(r.overduePaise)} due.`);
    } catch (err) {
      out.push(`Could not remind ${r.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}
