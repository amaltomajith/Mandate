import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Bank-statement reconciliation.
 *
 * Mandate cannot see the merchant's bank, so "I paid" on a manual payout is their
 * word. This closes that gap from the other side: the merchant uploads the
 * statement their bank gave them, and each line is tied, where it can be proved,
 * to a payout they confirmed or a customer payment they recorded.
 *
 * Matching is conservative on purpose. A payout is verified when the statement
 * shows the same amount AND either its reference or a unique equal amount close
 * in date. Two payouts of the same amount with no reference are reported as
 * ambiguous, never guessed. Nothing here moves money or confirms a payout: a
 * queued payout the bank already shows paid is only pointed out to the merchant.
 */

export const MAX_STATEMENT_LINES = 5000;
const DAY = 86_400_000;

export interface StatementRow {
  postedOn: string;
  description: string;
  debitPaise: number;
  creditPaise: number;
  ref: string | null;
}

export interface ParsedStatement {
  rows: StatementRow[];
  problems: string[];
}

/** A small CSV reader: quoted fields, doubled quotes, commas and newlines inside quotes. */
function records(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      out.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    out.push(row);
  }
  return out;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function validDay(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

function parseDate(raw: string): string | null {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return validDay(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
  if (m) return validDay(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
  m = /^(\d{1,2})[ -]([A-Za-z]{3})[a-z]*[ -,]*(\d{2}|\d{4})$/.exec(s);
  if (m) {
    const mi = MONTHS.indexOf(m[2].toLowerCase());
    return mi < 0 ? null : validDay(m[3].length === 2 ? 2000 + +m[3] : +m[3], mi + 1, +m[1]);
  }
  return null;
}

/** Paise from "1,20,000.00" or "₹ 3960.5". Empty is 0, anything else is null. */
function parsePaise(raw: string): number | null {
  const s = raw.replace(/[₹\s,]|rs\.?|inr/gi, "");
  if (s === "") return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

/** A statement narration is untrusted text that may end up in a spreadsheet. */
const plain = (s: string) => s.replace(/^[=+@\-\s]+/, "").replace(/\s+/g, " ").trim().slice(0, 300);

export function parseStatement(csv: string): ParsedStatement {
  const all = records(csv);
  const problems: string[] = [];
  const idx = all.findIndex((r) => {
    const l = r.map((c) => c.trim().toLowerCase());
    return l.some((c) => /date/.test(c)) && l.some((c) => /debit|withdraw|credit|deposit/.test(c));
  });
  if (idx < 0) return { rows: [], problems: ["This does not look like a bank statement: no header row with a date and debit or credit columns was found."] };

  const head = all[idx].map((c) => c.trim().toLowerCase());
  const col = (re: RegExp, not?: RegExp) => head.findIndex((c) => re.test(c) && !(not && not.test(c)));
  const cDate = col(/date/, /value/) >= 0 ? col(/date/, /value/) : col(/date/);
  const cDesc = col(/narration|description|particulars|remarks|details/);
  const cRef = col(/ref|chq|cheque|utr/);
  const cDebit = col(/debit|withdraw/);
  const cCredit = col(/credit|deposit/);

  const rows: StatementRow[] = [];
  for (let i = idx + 1; i < all.length; i++) {
    const r = all[i];
    if (r.every((c) => c.trim() === "")) continue;
    const line = i + 1;
    const postedOn = parseDate(r[cDate] ?? "");
    const debit = cDebit >= 0 ? parsePaise(r[cDebit] ?? "") : 0;
    const credit = cCredit >= 0 ? parsePaise(r[cCredit] ?? "") : 0;
    if (!postedOn) {
      problems.push(`Line ${line}: no readable date, skipped.`);
      continue;
    }
    if (debit === null || credit === null) {
      problems.push(`Line ${line}: an amount could not be read, skipped.`);
      continue;
    }
    if (debit === 0 && credit === 0) continue;
    rows.push({ postedOn, description: cDesc >= 0 ? plain(r[cDesc] ?? "") : "", debitPaise: debit, creditPaise: credit, ref: cRef >= 0 && (r[cRef] ?? "").trim() ? (r[cRef] ?? "").trim().slice(0, 64) : null });
  }
  return { rows, problems };
}

export interface PayoutCandidate {
  id: string;
  amountPaise: number;
  paidRef: string | null;
  paidAt: Date | null;
  createdAt: Date;
  status: "processed" | "queued";
}
export interface CreditCandidate {
  id: string;
  amountPaise: number;
  customerName: string;
  createdAt: Date;
}
export type Strength = "reference" | "amount";
export interface MatchedRow extends StatementRow {
  matchedKind: "payout" | "credit_payment" | null;
  matchedId: string | null;
  strength: Strength | null;
}
export interface MatchResult {
  rows: MatchedRow[];
  /** Indexes of rows that fit more than one payout equally well. */
  ambiguous: number[];
  queuedButPaid: string[];
  claimedNotSeen: string[];
  unmatchedDebits: number;
  unmatchedCredits: number;
}

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
const at = (day: string) => new Date(`${day}T00:00:00Z`).getTime();

export function matchStatement(input: StatementRow[], payouts: PayoutCandidate[], credits: CreditCandidate[]): MatchResult {
  const rows: MatchedRow[] = input.map((r) => ({ ...r, matchedKind: null, matchedId: null, strength: null }));
  const used = new Set<string>();
  const ambiguous: number[] = [];
  const when = (p: PayoutCandidate) => (p.paidAt ?? p.createdAt).getTime();

  // 1. A reference that appears in the line, with the same amount.
  rows.forEach((r) => {
    if (r.debitPaise <= 0) return;
    const hay = norm(`${r.ref ?? ""} ${r.description}`);
    const hit = payouts.find((p) => p.status === "processed" && !used.has(p.id) && p.amountPaise === r.debitPaise && !!p.paidRef && norm(p.paidRef).length >= 4 && hay.includes(norm(p.paidRef)));
    if (hit) {
      used.add(hit.id);
      Object.assign(r, { matchedKind: "payout", matchedId: hit.id, strength: "reference" });
    }
  });

  // 2. The same amount, close in date, and only one payout it could be.
  rows.forEach((r, i) => {
    if (r.debitPaise <= 0 || r.matchedId) return;
    const t = at(r.postedOn);
    const cands = payouts.filter((p) => p.status === "processed" && !used.has(p.id) && p.amountPaise === r.debitPaise && t >= when(p) - DAY && t <= when(p) + 7 * DAY);
    if (cands.length === 1) {
      used.add(cands[0].id);
      Object.assign(r, { matchedKind: "payout", matchedId: cands[0].id, strength: "amount" });
    } else if (cands.length > 1) ambiguous.push(i);
  });

  // 3. A payout the merchant has not confirmed that the bank already shows paid.
  const queuedButPaid: string[] = [];
  const queuedRows = new Set<number>();
  rows.forEach((r, i) => {
    if (r.debitPaise <= 0 || r.matchedId) return;
    const t = at(r.postedOn);
    const cands = payouts.filter((p) => p.status === "queued" && !used.has(p.id) && p.amountPaise === r.debitPaise && t >= p.createdAt.getTime() - DAY && t <= p.createdAt.getTime() + 14 * DAY);
    if (cands.length === 1) {
      used.add(cands[0].id);
      queuedButPaid.push(cands[0].id);
      queuedRows.add(i);
    }
  });

  // Customer payments in: the customer's name in the line is a reference; failing
  // that, a unique equal amount close in date.
  const usedCredit = new Set<string>();
  const take = (r: MatchedRow, c: CreditCandidate, strength: Strength) => {
    usedCredit.add(c.id);
    Object.assign(r, { matchedKind: "credit_payment", matchedId: c.id, strength });
  };
  rows.forEach((r) => {
    if (r.creditPaise <= 0) return;
    const hay = norm(`${r.description} ${r.ref ?? ""}`);
    const c = credits.find((x) => !usedCredit.has(x.id) && x.amountPaise === r.creditPaise && norm(x.customerName).length >= 3 && hay.includes(norm(x.customerName)));
    if (c) take(r, c, "reference");
  });
  rows.forEach((r) => {
    if (r.creditPaise <= 0 || r.matchedId) return;
    const t = at(r.postedOn);
    const cands = credits.filter((x) => !usedCredit.has(x.id) && x.amountPaise === r.creditPaise && t >= x.createdAt.getTime() - DAY && t <= x.createdAt.getTime() + 7 * DAY);
    if (cands.length === 1) take(r, cands[0], "amount");
  });

  // A payout confirmed paid is flagged only if the statement covers its date:
  // a payout outside the period the bank sent cannot be judged either way.
  const days = rows.map((r) => at(r.postedOn));
  const lo = days.length ? Math.min(...days) - DAY : 0;
  const hi = days.length ? Math.max(...days) + DAY : -1;
  const claimedNotSeen = payouts.filter((p) => p.status === "processed" && !used.has(p.id) && when(p) >= lo && when(p) <= hi).map((p) => p.id);

  return {
    rows,
    ambiguous,
    queuedButPaid,
    claimedNotSeen,
    unmatchedDebits: rows.filter((r, i) => r.debitPaise > 0 && !r.matchedId && !queuedRows.has(i)).length,
    unmatchedCredits: rows.filter((r) => r.creditPaise > 0 && !r.matchedId).length,
  };
}

export interface ReconcileSummary {
  added: number;
  duplicates: number;
  verified: number;
  matchedCredits: number;
  queuedButPaid: string[];
  claimedNotSeen: string[];
  ambiguous: number;
  unmatchedDebits: number;
  unmatchedCredits: number;
  problems: string[];
}

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/** Stores a statement (each line once) and ties its new lines to payouts and customer payments. */
export async function reconcileStatement(db: SupabaseClient, merchantId: string, csv: string, by: string): Promise<ReconcileSummary> {
  void by;
  const parsed = parseStatement(csv);
  if (parsed.rows.length === 0) throw new Error(parsed.problems[0] ?? "No lines were found in this statement.");
  if (parsed.rows.length > MAX_STATEMENT_LINES) throw new Error(`That statement has too many lines. The limit is ${MAX_STATEMENT_LINES.toLocaleString("en-IN")} at a time.`);

  const seen = new Map<string, number>();
  const keyed = parsed.rows.map((r) => {
    const base = [r.postedOn, r.debitPaise, r.creditPaise, norm(r.description), r.ref ?? ""].join("|");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { ...r, key: createHash("sha1").update(`${base}|${n}`).digest("hex") };
  });

  const inserted: { id: string; row_key: string }[] = [];
  for (let i = 0; i < keyed.length; i += 500) {
    const { data, error } = await db
      .from("bank_statement_rows")
      .upsert(
        keyed.slice(i, i + 500).map((r) => ({ merchant_id: merchantId, row_key: r.key, posted_on: r.postedOn, description: r.description, debit_paise: r.debitPaise, credit_paise: r.creditPaise, ref: r.ref })),
        { onConflict: "merchant_id,row_key", ignoreDuplicates: true }
      )
      .select("id, row_key");
    if (error) throw new Error(error.message);
    inserted.push(...((data ?? []) as { id: string; row_key: string }[]));
  }
  const summary: ReconcileSummary = { added: inserted.length, duplicates: keyed.length - inserted.length, verified: 0, matchedCredits: 0, queuedButPaid: [], claimedNotSeen: [], ambiguous: 0, unmatchedDebits: 0, unmatchedCredits: 0, problems: parsed.problems };
  if (inserted.length === 0) return summary;

  const idOf = new Map(inserted.map((x) => [x.row_key, x.id]));
  const fresh = keyed.filter((r) => idOf.has(r.key));

  const since = new Date(Date.now() - 120 * DAY).toISOString();
  const [{ data: pays, error: pe }, { data: credits, error: ce }, { data: matchedAlready }] = await Promise.all([
    db.from("payouts").select("id, amount_paise, paid_ref, paid_at, created_at, status").eq("merchant_id", merchantId).eq("manual", true).in("status", ["processed", "queued"]).is("bank_verified_at", null).gte("created_at", since),
    db.from("credit_entries").select("id, amount_paise, created_at, customers(name)").eq("merchant_id", merchantId).eq("kind", "payment").gte("created_at", since),
    db.from("bank_statement_rows").select("matched_id").eq("merchant_id", merchantId).eq("matched_kind", "credit_payment"),
  ]);
  if (pe) throw new Error(pe.message);
  if (ce) throw new Error(ce.message);
  const taken = new Set((matchedAlready ?? []).map((x: { matched_id: string }) => x.matched_id));

  const payoutCands: PayoutCandidate[] = (pays ?? []).map((p) => ({ id: p.id, amountPaise: Number(p.amount_paise), paidRef: p.paid_ref, paidAt: p.paid_at ? new Date(p.paid_at) : null, createdAt: new Date(p.created_at), status: p.status as "processed" | "queued" }));
  const creditCands: CreditCandidate[] = (credits ?? [])
    .filter((c) => !taken.has(c.id))
    .map((c) => ({ id: c.id, amountPaise: Number(c.amount_paise), createdAt: new Date(c.created_at), customerName: String((c.customers as unknown as { name?: string } | null)?.name ?? "") }));

  const m = matchStatement(fresh, payoutCands, creditCands);
  summary.ambiguous = m.ambiguous.length;
  summary.queuedButPaid = m.queuedButPaid;
  summary.claimedNotSeen = m.claimedNotSeen;
  summary.unmatchedDebits = m.unmatchedDebits;
  summary.unmatchedCredits = m.unmatchedCredits;

  for (let i = 0; i < fresh.length; i++) {
    const r = m.rows[i];
    if (!r.matchedId) continue;
    const rowId = idOf.get(fresh[i].key)!;
    await db.from("bank_statement_rows").update({ matched_kind: r.matchedKind, matched_id: r.matchedId, match_strength: r.strength }).eq("id", rowId);
    if (r.matchedKind === "payout") {
      const { data } = await db.from("payouts").update({ bank_verified_at: new Date().toISOString(), bank_row_id: rowId }).eq("id", r.matchedId).eq("merchant_id", merchantId).is("bank_verified_at", null).select("id");
      if ((data ?? []).length) summary.verified++;
    } else summary.matchedCredits++;
  }

  // Tell the merchant about what the bank did not show, once per payout.
  const flagged = payoutCands.filter((p) => m.claimedNotSeen.includes(p.id));
  for (const p of flagged) {
    const tag = `(payment ${p.id.slice(0, 8)})`;
    const { data: had } = await db.from("alerts").select("id").eq("merchant_id", merchantId).like("message", `%${tag}%`).limit(1);
    if ((had ?? []).length) continue;
    await db.from("alerts").insert({ merchant_id: merchantId, trace_id: null, severity: "notable", message: `You confirmed paying ${rupees(p.amountPaise)}, but it is not on the bank statement you uploaded. Check that it went through ${tag}.` });
  }
  return summary;
}
