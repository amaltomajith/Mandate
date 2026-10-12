import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Khata: selling to regular customers on credit.
 *
 * The rules that matter are enforced in the database (migration 0033), under row
 * locks, so no caller can get around them: a per-customer limit, a cap on what is
 * owed across all customers, stock on the shelf, and exactly-once on a retry (a
 * `ref`). Credit is only ever extended by the merchant. An agent can read this and
 * remind; it cannot lend.
 *
 * A credit sale is not money. It does not credit the wallet and does not count as
 * revenue for the payout budget; both happen when the customer pays.
 */

export type CreditRefusal = "unknown_customer" | "empty" | "no_credit" | "over_limit" | "over_exposure" | "out_of_stock" | "more_than_owed";

export type CreditResult = { ok: true; entryId: string; owedPaise: number; duplicate: boolean } | { ok: false; reason: CreditRefusal; message: string };

const MESSAGES: Record<CreditRefusal, string> = {
  unknown_customer: "That customer was not found.",
  empty: "There is nothing to record.",
  no_credit: "This customer has no credit limit. Set one first.",
  over_limit: "That would take them over their credit limit.",
  over_exposure: "That would take the total owed to you over your overall credit cap.",
  out_of_stock: "There is not enough stock for that.",
  more_than_owed: "That is more than they owe.",
};

type Raw = { ok: boolean; reason?: CreditRefusal; entry_id?: string; owed_paise?: number; duplicate?: boolean };

function result(raw: Raw): CreditResult {
  if (raw.ok && raw.entry_id) return { ok: true, entryId: raw.entry_id, owedPaise: Number(raw.owed_paise ?? 0), duplicate: !!raw.duplicate };
  const reason = raw.reason ?? "empty";
  return { ok: false, reason, message: MESSAGES[reason] ?? "Not allowed." };
}

async function rpc(db: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<CreditResult> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new Error(error.message);
  return result(data as Raw);
}

export interface CreditLine {
  sku: string;
  qty: number;
}

/** Sells on credit. Prices come from the catalogue, never from the caller. */
export async function sellOnCredit(db: SupabaseClient, merchantId: string, customerId: string, lines: CreditLine[], by: string, ref?: string): Promise<CreditResult> {
  if (lines.length === 0 || lines.some((l) => !(l.qty > 0))) return result({ ok: false, reason: "empty" });
  const merged = new Map<string, number>();
  for (const l of lines) merged.set(l.sku, (merged.get(l.sku) ?? 0) + l.qty);
  const { data: products, error } = await db.from("products").select("id, sku, name, price_paise, active").eq("merchant_id", merchantId).in("sku", [...merged.keys()]);
  if (error) throw new Error(error.message);
  const bySku = new Map((products ?? []).map((p) => [p.sku as string, p]));
  const rows = [];
  for (const [sku, qty] of merged) {
    const p = bySku.get(sku);
    if (!p || p.active === false) throw new Error(`There is no active product "${sku}".`);
    rows.push({ product_id: p.id, qty, amount_paise: Number(p.price_paise) * qty });
  }
  const note = `On credit: ${[...merged].map(([sku, q]) => `${q} x ${sku}`).join(", ")}`;
  return rpc(db, "extend_credit", { p_merchant: merchantId, p_customer: customerId, p_rows: rows, p_note: note, p_ref: ref ?? null, p_by: by });
}

/** The customer pays some or all of what they owe. The wallet is credited. */
export async function receivePayment(db: SupabaseClient, merchantId: string, customerId: string, amountPaise: number, by: string, opts: { ref?: string; note?: string } = {}): Promise<CreditResult> {
  const { data: c } = await db.from("customers").select("email").eq("id", customerId).eq("merchant_id", merchantId).maybeSingle();
  const simulated = (c?.email ?? "").endsWith(".sandbox.test");
  return rpc(db, "record_credit_payment", { p_merchant: merchantId, p_customer: customerId, p_amount: Math.round(amountPaise), p_note: opts.note ?? "Credit payment received", p_ref: opts.ref ?? null, p_by: by, p_simulated: simulated });
}

export function writeOff(db: SupabaseClient, merchantId: string, customerId: string, amountPaise: number, by: string, opts: { ref?: string; note?: string } = {}): Promise<CreditResult> {
  return rpc(db, "write_off_credit", { p_merchant: merchantId, p_customer: customerId, p_amount: Math.round(amountPaise), p_note: opts.note ?? "Written off", p_ref: opts.ref ?? null, p_by: by });
}

export interface Receivable {
  customerId: string;
  name: string;
  limitPaise: number;
  termsDays: number;
  owedPaise: number;
  /** The part of what is owed that is past its due date. */
  overduePaise: number;
  /** When the oldest unpaid sale fell due, or null if nothing is owed. */
  oldestDueAt: string | null;
  lastPaymentAt: string | null;
}

/**
 * Who owes what. Payments settle the oldest sales first, so "overdue" is the
 * amount owed beyond what the sales that are not yet due add up to.
 */
export async function getReceivables(db: SupabaseClient, merchantId: string, now = new Date()): Promise<Receivable[]> {
  const [customers, entries] = await Promise.all([
    db.from("customers").select("id, name, credit_limit_paise, credit_terms_days").eq("merchant_id", merchantId).order("name"),
    db.from("credit_entries").select("customer_id, kind, amount_paise, due_at, created_at").eq("merchant_id", merchantId).order("created_at"),
  ]);
  if (customers.error) throw new Error(customers.error.message);
  if (entries.error) throw new Error(entries.error.message);
  const by = new Map<string, NonNullable<typeof entries.data>>();
  for (const e of entries.data ?? []) (by.get(e.customer_id) ?? by.set(e.customer_id, []).get(e.customer_id)!).push(e);

  const out: Receivable[] = [];
  for (const c of customers.data ?? []) {
    const list = by.get(c.id) ?? [];
    const limit = Number(c.credit_limit_paise);
    if (list.length === 0 && limit === 0) continue;
    const sales = list.filter((e) => e.kind === "sale");
    const settled = list.filter((e) => e.kind !== "sale").reduce((n, e) => n + Number(e.amount_paise), 0);
    // Oldest sales are paid first.
    let credit = settled;
    let owed = 0;
    let overdue = 0;
    let oldestDue: string | null = null;
    for (const s of sales) {
      const amt = Number(s.amount_paise);
      const used = Math.min(credit, amt);
      credit -= used;
      const left = amt - used;
      if (left > 0) {
        owed += left;
        if (!oldestDue) oldestDue = s.due_at;
        if (s.due_at && new Date(s.due_at).getTime() < now.getTime()) overdue += left;
      }
    }
    const payments = list.filter((e) => e.kind === "payment");
    out.push({
      customerId: c.id,
      name: c.name,
      limitPaise: limit,
      termsDays: c.credit_terms_days,
      owedPaise: owed,
      overduePaise: overdue,
      oldestDueAt: oldestDue,
      lastPaymentAt: payments.length ? payments[payments.length - 1].created_at : null,
    });
  }
  return out;
}
