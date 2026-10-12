import type { SupabaseClient } from "@supabase/supabase-js";
import { toCsv } from "./csv";

/**
 * GST-ready registers: a sales register and a purchase register an accountant can
 * work from. They are a convenience, not a filed return, and they never guess: a
 * product with no GST rate is listed and flagged with no tax figure, rather than
 * being given one.
 *
 * Basis, stated in the file itself so it cannot be misread:
 *   - Selling prices are treated as GST-INCLUSIVE (the retail norm), so the tax is
 *     carved out of the price.
 *   - Supplier prices are treated as EXCLUDING GST (the wholesale norm), so the tax
 *     is added on top.
 *   - The CGST/SGST split assumes a sale within the same state. For a customer in
 *     another state the same tax is IGST.
 * Credit sales are included on the day of sale (that is when the supply is made);
 * the cash that later settles them is not counted again, and sample data never is.
 */

const DAY = 86_400_000;

export const validRateBps = (n: number) => Number.isInteger(n) && n >= 0 && n <= 4000;
export const validHsn = (s: string) => /^(\d{4}|\d{6}|\d{8})$/.test(s);
/** The 15-character shape of a GSTIN. It does not prove the number is registered. */
export const validGstin = (s: string) => /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(s);

/** A price that already includes GST, split into value and tax (paise, rounded once). */
export function splitInclusive(totalPaise: number, rateBps: number) {
  const tax = Math.round((totalPaise * rateBps) / (10000 + rateBps));
  return { taxable: totalPaise - tax, tax };
}

/** A price that excludes GST: the tax is added on top. */
export function splitExclusive(valuePaise: number, rateBps: number) {
  return { taxable: valuePaise, tax: Math.round((valuePaise * rateBps) / 10000) };
}

const money = (p: number) => `${p < 0 ? "-" : ""}${Math.trunc(Math.abs(p) / 100)}.${String(Math.abs(p) % 100).padStart(2, "0")}`;
const ist = (ms: number) => new Date(ms + 5.5 * 3600_000).toISOString().slice(0, 10);
const percent = (bps: number) => String(bps / 100);

function parseDay(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const t = m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
  if (!m || Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s) throw new Error(`"${s}" is not a valid date. Use YYYY-MM-DD.`);
  return t;
}

export interface GstExport {
  head: string[];
  rows: string[][];
  csv: string;
  summary: { rows: number; totalPaise: number; taxPaise: number; missingRate: number; missingHsn: number };
}

const SALES_HEAD = ["date", "invoice_ref", "product", "sku", "hsn", "qty", "gst_rate_percent", "taxable_value", "tax", "cgst_if_same_state", "sgst_if_same_state", "total", "payment", "needs_attention"];
const PURCHASE_HEAD = ["date", "supplier", "supplier_gstin", "product", "hsn", "qty", "unit_price", "taxable_value", "gst_rate_percent", "tax", "total", "receipt_id", "needs_attention"];
const MAX_ROWS = 10_000;

export async function buildGstExport(db: SupabaseClient, merchantId: string, kind: "sales" | "purchases", from: string, to: string): Promise<GstExport> {
  const start = parseDay(from);
  const end = parseDay(to);
  if (end < start) throw new Error("The end date is before the start date.");
  if ((end - start) / DAY > 365) throw new Error("Choose a period of a year or less at a time.");
  const lo = new Date(start - 5.5 * 3600_000).toISOString();
  const hi = new Date(end + DAY - 5.5 * 3600_000).toISOString();

  const { data: products, error: pe } = await db.from("products").select("id, sku, name, hsn_code, gst_rate_bps").eq("merchant_id", merchantId);
  if (pe) throw new Error(pe.message);
  const prod = new Map((products ?? []).map((p) => [p.id as string, p]));
  const summary = { rows: 0, totalPaise: 0, taxPaise: 0, missingRate: 0, missingHsn: 0 };
  const rows: string[][] = [];

  if (kind === "sales") {
    const { data, error } = await db.from("sales").select("id, product_id, qty, amount_paise, razorpay_payment_id, captured_at").eq("merchant_id", merchantId).gte("captured_at", lo).lt("captured_at", hi).order("captured_at").limit(MAX_ROWS + 1);
    if (error) throw new Error(error.message);
    if ((data ?? []).length > MAX_ROWS) throw new Error("That period has too many sales for one file. Choose a shorter period.");
    for (const s of data ?? []) {
      const ref: string = s.razorpay_payment_id ?? s.id;
      // Sample data is not real; the cash that settles a credit sale is not a second sale.
      if (/^(sample_|khatapay_)/.test(ref)) continue;
      const p = s.product_id ? prod.get(s.product_id) : undefined;
      const rate = p?.gst_rate_bps as number | null | undefined;
      const total = Number(s.amount_paise);
      const flags: string[] = [];
      if (!p) flags.push("product no longer exists");
      if (rate === null || rate === undefined) {
        flags.push("no GST rate set");
        summary.missingRate++;
      }
      if (!p?.hsn_code) {
        flags.push("no HSN code");
        summary.missingHsn++;
      }
      const split = rate === null || rate === undefined ? null : splitInclusive(total, rate);
      const half = split ? Math.floor(split.tax / 2) : 0;
      rows.push([
        ist(new Date(s.captured_at).getTime()),
        ref,
        p?.name ?? "Unknown product",
        p?.sku ?? "",
        p?.hsn_code ?? "",
        String(s.qty),
        rate === null || rate === undefined ? "" : percent(rate),
        split ? money(split.taxable) : "",
        split ? money(split.tax) : "",
        split ? money(half) : "",
        split ? money(split.tax - half) : "",
        money(total),
        ref.startsWith("credit_") ? "credit" : "paid",
        flags.join("; "),
      ]);
      summary.totalPaise += total;
      summary.taxPaise += split?.tax ?? 0;
    }
  } else {
    const { data, error } = await db.from("po_receipts").select("id, vendor_id, lines, received_at, vendors(name, gstin)").eq("merchant_id", merchantId).gte("received_at", lo).lt("received_at", hi).order("received_at").limit(MAX_ROWS + 1);
    if (error) throw new Error(error.message);
    if ((data ?? []).length > MAX_ROWS) throw new Error("That period has too many receipts for one file. Choose a shorter period.");
    for (const r of data ?? []) {
      const vendor = r.vendors as unknown as { name?: string; gstin?: string | null } | null;
      for (const l of (r.lines ?? []) as { product_id: string; received_qty: number; invoice_price_paise: number }[]) {
        if (!(l.received_qty > 0)) continue;
        const p = prod.get(l.product_id);
        const rate = p?.gst_rate_bps as number | null | undefined;
        const value = l.received_qty * l.invoice_price_paise;
        const flags: string[] = [];
        if (rate === null || rate === undefined) {
          flags.push("no GST rate set");
          summary.missingRate++;
        }
        if (!p?.hsn_code) {
          flags.push("no HSN code");
          summary.missingHsn++;
        }
        if (!vendor?.gstin) flags.push("supplier GSTIN missing");
        const split = rate === null || rate === undefined ? null : splitExclusive(value, rate);
        rows.push([
          ist(new Date(r.received_at).getTime()),
          vendor?.name ?? "Unknown supplier",
          vendor?.gstin ?? "",
          p?.name ?? "Unknown product",
          p?.hsn_code ?? "",
          String(l.received_qty),
          money(l.invoice_price_paise),
          money(value),
          rate === null || rate === undefined ? "" : percent(rate),
          split ? money(split.tax) : "",
          split ? money(value + split.tax) : money(value),
          r.id,
          flags.join("; "),
        ]);
        summary.totalPaise += split ? value + split.tax : value;
        summary.taxPaise += split?.tax ?? 0;
      }
    }
  }
  summary.rows = rows.length;
  const head = kind === "sales" ? SALES_HEAD : PURCHASE_HEAD;
  return { head, rows, csv: toCsv(head, rows), summary };
}
