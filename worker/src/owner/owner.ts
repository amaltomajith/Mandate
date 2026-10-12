import { createHash, randomInt } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MerchantSettings } from "@/types/db";
import { approveEscalationCore, denyEscalationCore } from "@/lib/approvals";
import { getCooData } from "@/lib/cooData";
import { getReceivables } from "@/lib/credit";
import { normalizePhone } from "../channels/phone";
import type { ChannelDriver } from "../channels/types";

/**
 * The owner on WhatsApp.
 *
 * Two things only: a daily briefing, and answering a held payout with a short
 * one-time code. Nothing the owner types can do anything else, and nothing here
 * decides a payment: an approval goes through approveEscalationCore, which
 * re-checks every limit under the merchant lock exactly as the dashboard does.
 *
 * Why this is safe to put on a chat app:
 *  - only the merchant's own number is ever treated as the owner, and only if the
 *    merchant switched this on and set that number;
 *  - a code is for one held payout, expires after ten minutes and works once;
 *  - only a hash of the code is stored;
 *  - repeated wrong guesses lock the owner channel for a while;
 *  - a payout above the merchant's own ceiling cannot be approved this way at all.
 */

export const CODE_TTL_MS = 10 * 60_000;
export const MAX_BAD_ATTEMPTS = 5;
export const ATTEMPT_WINDOW_MS = 10 * 60_000;

const hashCode = (merchantId: string, code: string) => createHash("sha256").update(`${merchantId}:${code}`).digest("hex");
const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0");
const rupees = (paise: number) => `Rs ${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export type OwnerReply = { verb: "yes" | "no"; code: string };

/** "YES 483920" / "no 483920" (also "haan"/"nahi"). Anything else is not an answer. */
export function parseOwnerReply(text: string): OwnerReply | null {
  const m = text.trim().match(/^(yes|y|approve|ok|haan|ha|no|n|deny|reject|nahi)\s+(\d{6})$/i);
  if (!m) return null;
  return { verb: /^(yes|y|approve|ok|haan|ha)$/i.test(m[1]) ? "yes" : "no", code: m[2] };
}

/** Is this the merchant's own number, and have they switched the owner channel on? */
export function isOwner(settings: MerchantSettings, from: string): boolean {
  if (!settings.owner_phone) return false;
  if (!settings.owner_approvals_enabled && !settings.owner_briefing_enabled) return false;
  return normalizePhone(from) === normalizePhone(settings.owner_phone);
}

async function recordOwnerMessage(db: SupabaseClient, merchantId: string, kind: "briefing" | "approval" | "reply", body: string, escalationId: string | null, delivered: boolean) {
  await db.from("owner_messages").insert({ merchant_id: merchantId, kind, body, escalation_id: escalationId, delivered });
}

/**
 * Sends to the owner when a live WhatsApp channel exists; otherwise (sandbox, or
 * not connected) the message is only recorded, undelivered, so nothing real is
 * messaged and the merchant can still see exactly what would be sent.
 */
export async function sendToOwner(
  db: SupabaseClient,
  merchantId: string,
  settings: MerchantSettings,
  driver: ChannelDriver | undefined,
  kind: "briefing" | "approval" | "reply",
  body: string,
  escalationId: string | null = null
): Promise<boolean> {
  let delivered = false;
  if (driver?.live && settings.owner_phone && settings.channel_mode === "live") {
    try {
      await driver.send({ to: settings.owner_phone, body });
      delivered = true;
    } catch (err) {
      console.warn("[owner] could not message the owner:", err instanceof Error ? err.message : err);
    }
  }
  await recordOwnerMessage(db, merchantId, kind, body, escalationId, delivered);
  return delivered;
}

/**
 * For every held payout that has not been offered to the owner yet, creates a
 * code and sends the question. Payouts above the owner's ceiling are not offered.
 */
export async function offerHeldPayouts(db: SupabaseClient, merchantId: string, settings: MerchantSettings, driver: ChannelDriver | undefined): Promise<number> {
  if (!settings.owner_approvals_enabled || !settings.owner_phone) return 0;
  const { data: pending } = await db.from("escalations").select("id, trace_id").eq("merchant_id", merchantId).eq("status", "pending");
  let offered = 0;
  for (const esc of pending ?? []) {
    const { count } = await db.from("owner_approvals").select("id", { count: "exact", head: true }).eq("escalation_id", esc.id);
    if ((count ?? 0) > 0) continue; // already offered once; never nag
    const { data: trace } = await db.from("traces").select("action_type, params").eq("id", esc.trace_id).eq("merchant_id", merchantId).maybeSingle();
    if (!trace || trace.action_type !== "payout.create") continue;
    const params = trace.params as { amount?: number; payeeId?: string };
    const amount = Number(params.amount ?? 0);
    if (!(amount > 0) || amount > Number(settings.owner_approval_max_paise)) continue;
    let who = "a supplier";
    if (params.payeeId) {
      const { data: payee } = await db.from("payees").select("display_name").eq("id", params.payeeId).eq("merchant_id", merchantId).maybeSingle();
      if (payee?.display_name) who = payee.display_name;
    }
    let code = "";
    for (let tries = 0; tries < 5; tries++) {
      code = newCode();
      const { error } = await db.from("owner_approvals").insert({ merchant_id: merchantId, escalation_id: esc.id, code_hash: hashCode(merchantId, code), expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString() });
      if (!error) break;
      code = "";
    }
    if (!code) continue;
    await sendToOwner(
      db,
      merchantId,
      settings,
      driver,
      "approval",
      `Your team wants to pay ${rupees(amount)} to ${who}. Reply YES ${code} to approve or NO ${code} to refuse. This expires in 10 minutes.`,
      esc.id
    );
    offered++;
  }
  return offered;
}

/** Wrong guesses recently, so guessing a code is not a matter of trying again. */
async function recentBadAttempts(db: SupabaseClient, merchantId: string): Promise<number> {
  const since = new Date(Date.now() - ATTEMPT_WINDOW_MS).toISOString();
  const { count } = await db.from("owner_attempts").select("id", { count: "exact", head: true }).eq("merchant_id", merchantId).gte("created_at", since);
  return count ?? 0;
}

/**
 * Handles one message from the owner's number. Returns what to say back, or null
 * to say nothing. Never throws on bad input: a stranger's or a mistyped message
 * is answered, not escalated.
 */
export async function handleOwnerMessage(db: SupabaseClient, merchantId: string, settings: MerchantSettings, driver: ChannelDriver | undefined, text: string, voice = false): Promise<string | null> {
  const reply = async (body: string) => {
    await sendToOwner(db, merchantId, settings, driver, "reply", body);
    return body;
  };
  if (!settings.owner_approvals_enabled) return null;
  // A spoken "yes" is never an approval: speech is easy to mishear and to fake. It must be typed.
  if (voice) return reply("For safety, approvals must be typed, not sent as a voice note. Type YES or NO and the 6-digit code.");
  if ((await recentBadAttempts(db, merchantId)) >= MAX_BAD_ATTEMPTS) return reply("Too many wrong codes. Try again in a few minutes, or use the dashboard.");

  const parsed = parseOwnerReply(text);
  if (!parsed) return reply("I only understand YES or NO followed by the 6-digit code from the question.");

  // Claim the code first: one conditional update, so a code works once even if the same reply arrives twice.
  const { data: claimed } = await db
    .from("owner_approvals")
    .update({ used_at: new Date().toISOString() })
    .eq("merchant_id", merchantId)
    .eq("code_hash", hashCode(merchantId, parsed.code))
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .select("id, escalation_id");
  const hit = claimed?.[0];
  if (!hit) {
    await db.from("owner_attempts").insert({ merchant_id: merchantId });
    return reply("That code is not valid or has expired. Open the dashboard to answer it there.");
  }

  const approver = `owner via WhatsApp (${normalizePhone(settings.owner_phone ?? "").slice(-4)})`;
  try {
    if (parsed.verb === "yes") {
      const r = await approveEscalationCore(db, merchantId, hit.escalation_id, approver);
      return reply(r.status === "approved" ? "Approved. The payment is going out." : "That was already approved.");
    }
    await denyEscalationCore(db, merchantId, hit.escalation_id, approver);
    return reply("Refused. The payment will not be made.");
  } catch (err) {
    // The wall said no at approval time (a limit changed, the budget is used), or the payout failed to go out.
    // The code stays used; the dashboard is where to look at it.
    return reply(`I could not do that: ${err instanceof Error ? err.message : "something went wrong"} Open the dashboard to look at it.`);
  }
}

/** The morning message: what came in, what is held, what is low. Once per calendar day. */
export async function sendBriefingIfDue(db: SupabaseClient, merchantId: string, settings: MerchantSettings, driver: ChannelDriver | undefined, now = new Date()): Promise<boolean> {
  if (!settings.owner_briefing_enabled || !settings.owner_phone) return false;
  const today = now.toISOString().slice(0, 10);
  if (settings.owner_briefing_sent_on === today) return false;
  // Claim the day first so two workers cannot both send it.
  const { data: claimed } = await db
    .from("merchant_settings")
    .update({ owner_briefing_sent_on: today })
    .eq("merchant_id", merchantId)
    .or(`owner_briefing_sent_on.is.null,owner_briefing_sent_on.neq.${today}`)
    .select("merchant_id");
  if (!claimed || claimed.length === 0) return false;

  const data = await getCooData(db, merchantId);
  const since = now.getTime() - 86_400_000;
  const recent = data.sales.filter((s) => new Date(s.captured_at).getTime() >= since);
  const sold = recent.reduce((n, s) => n + Number(s.amount_paise), 0);
  const receivables = await getReceivables(db, merchantId, now);
  const owed = receivables.reduce((n, r) => n + r.owedPaise, 0);
  const overdue = receivables.reduce((n, r) => n + r.overduePaise, 0);
  const lines = [
    "Good morning. Here is your store.",
    `Sales, last 24 hours: ${recent.length} for ${rupees(sold)}.`,
    `Money available: ${rupees(data.kpis.walletPaise)}.`,
    data.kpis.openApprovals > 0 ? `Waiting for you: ${data.kpis.openApprovals}.` : "Nothing is waiting for you.",
    ...(owed > 0 ? [`Owed to you on credit: ${rupees(owed)}${overdue > 0 ? ` (${rupees(overdue)} overdue)` : ""}.`] : []),
    data.kpis.runningLow > 0 ? `Running low: ${data.kpis.runningLow} product${data.kpis.runningLow === 1 ? "" : "s"}.` : "Nothing is running low.",
  ];
  await sendToOwner(db, merchantId, settings, driver, "briefing", lines.join("\n"));
  return true;
}
