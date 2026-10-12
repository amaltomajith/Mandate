import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * No-lie negotiation.
 *
 * Negotiation tempts a bot to bluff: "another supplier already offered me
 * Rs 1,500". Every claim like that is checked here, against the merchant's own
 * records, before a message to a supplier can leave. The check is code, like the
 * Payment Wall: it does not depend on the model choosing to be honest, and it
 * applies to anything that sends to a supplier, whoever wrote the words.
 *
 * What counts as a claim:
 *  - that a better, lower or competing offer exists;
 *  - any rupee amount or percentage stated alongside such a claim;
 *  - naming another supplier (their identity is never shared);
 *  - pressure that cannot be backed up (an order already placed elsewhere,
 *    "today only", "last chance").
 *
 * What it does not do: stop a merchant's own offer ("we can pay Rs 1,800"). That
 * is a proposal, not a statement of fact, and committing money still goes through
 * the Payment Wall.
 */

export interface ClaimTruth {
  /** This supplier's own current, usable quote for the product, in paise. */
  ownQuotePaise: number | null;
  /** The lowest current, usable quote from ANY OTHER supplier for the same product. */
  competitorLowestPaise: number | null;
  /** Names of the merchant's other suppliers, which must not be revealed. */
  otherVendorNames: string[];
  /** The supplier being written to; its own name may of course appear. */
  ownName?: string;
  /** Other amounts the message may legitimately state (a past price, a total). */
  knownAmountsPaise?: number[];
}

export type ClaimVerdict = { ok: true } | { ok: false; problems: string[] };

const COMPETITOR_CLAIM =
  /\b(another|other|a different|competing|competitor|rival)\s+(supplier|vendor|quote|offer|bid)s?\b|\b(someone else|elsewhere)\b[^.!?\n]{0,40}\b(quote|quoted|offer|offered|price|priced|cheaper|lower|better)\b|\b(cheaper|lower|better)\s+(price|offer|quote|rate)s?\b|\b(received|got|have|found)\s+(a|an)\s+(lower|cheaper|better)\b/i;

const PRESSURE =
  /\b(already\s+(ordered|paid|bought|placed)|ready to ship today|today only|last chance|offer\s+(expires|ends)|expires\s+(today|tonight|tomorrow))\b/i;

/** Every rupee amount in the text, in paise. Handles "₹2,600", "Rs 2600" and "Rs. 2,600.50". */
export function amountsPaise(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(?:₹|\brs\.?|\binr)\s*([\d,]+(?:\.\d{1,2})?)/gi)) {
    const v = parseFloat(m[1].replace(/,/g, ""));
    if (Number.isFinite(v)) out.push(Math.round(v * 100));
  }
  return out;
}

export function checkClaims(text: string, truth: ClaimTruth): ClaimVerdict {
  const problems: string[] = [];
  const claimsCompetition = COMPETITOR_CLAIM.test(text);

  if (claimsCompetition) {
    const comp = truth.competitorLowestPaise;
    if (comp === null) {
      problems.push("It says another offer exists, but there is no other supplier's quote on record for this product.");
    } else if (truth.ownQuotePaise !== null && comp >= truth.ownQuotePaise) {
      problems.push("It says another offer is better, but no other quote on record is lower than this supplier's own.");
    }
    const allowed = new Set<number>([...(truth.ownQuotePaise !== null ? [truth.ownQuotePaise] : []), ...(comp !== null ? [comp] : []), ...(truth.knownAmountsPaise ?? [])]);
    for (const a of amountsPaise(text)) {
      if (!allowed.has(a)) problems.push(`It states Rs ${(a / 100).toLocaleString("en-IN")}, which is not a price on record.`);
    }
    if (comp !== null && truth.ownQuotePaise !== null && comp < truth.ownQuotePaise) {
      const realGap = ((truth.ownQuotePaise - comp) / truth.ownQuotePaise) * 100;
      for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*%/g)) {
        if (Math.abs(parseFloat(m[1]) - realGap) > 1.5) problems.push(`It says ${m[1]}% but the real difference is ${realGap.toFixed(1)}%.`);
      }
    }
  }

  // The supplier's own name is fine, even if another supplier's name contains it.
  const lower = (truth.ownName ? text.split(truth.ownName).join(" ") : text).toLowerCase();
  for (const name of truth.otherVendorNames) {
    if (name.trim().length >= 3 && lower.includes(name.trim().toLowerCase())) problems.push("It names another supplier. Who else has quoted is never shared.");
  }
  if (PRESSURE.test(text)) problems.push("It uses pressure that cannot be backed up from the records (an order elsewhere, a deadline, 'last chance').");

  return problems.length === 0 ? { ok: true } : { ok: false, problems: [...new Set(problems)] };
}

/** What the records say, for one supplier and one product (by sku). */
export async function loadClaimTruth(db: SupabaseClient, merchantId: string, vendorId: string, sku?: string): Promise<ClaimTruth> {
  const { data: vendors } = await db.from("vendors").select("id, name").eq("merchant_id", merchantId);
  const otherVendorNames = (vendors ?? []).filter((v) => v.id !== vendorId).map((v) => v.name as string);
  const ownName = (vendors ?? []).find((v) => v.id === vendorId)?.name as string | undefined;
  let ownQuotePaise: number | null = null;
  let competitorLowestPaise: number | null = null;
  let knownAmountsPaise: number[] = [];
  if (sku) {
    const { data: product } = await db.from("products").select("id").eq("merchant_id", merchantId).eq("sku", sku).maybeSingle();
    if (product) {
      const { data: quotes } = await db
        .from("quotes")
        .select("vendor_id, unit_price_paise, via_voice, voice_confirmed_at")
        .eq("merchant_id", merchantId)
        .eq("product_id", product.id)
        .eq("status", "open")
        .gte("valid_until", new Date().toISOString());
      const usable = (quotes ?? []).filter((q) => !q.via_voice || q.voice_confirmed_at);
      const own = usable.filter((q) => q.vendor_id === vendorId).map((q) => Number(q.unit_price_paise));
      const others = usable.filter((q) => q.vendor_id !== vendorId).map((q) => Number(q.unit_price_paise));
      // What this supplier was last accepted at is on record, so it may be mentioned.
      const { data: past } = await db.from("quotes").select("unit_price_paise").eq("merchant_id", merchantId).eq("product_id", product.id).eq("vendor_id", vendorId).eq("status", "accepted");
      knownAmountsPaise = (past ?? []).map((q) => Number(q.unit_price_paise));
      ownQuotePaise = own.length ? Math.min(...own) : null;
      competitorLowestPaise = others.length ? Math.min(...others) : null;
    }
  }
  return { ownQuotePaise, competitorLowestPaise, otherVendorNames, ownName, knownAmountsPaise };
}

/** The gate every message to a supplier passes through. */
export async function checkOutgoingClaims(db: SupabaseClient, merchantId: string, vendorId: string, sku: string | undefined, body: string): Promise<ClaimVerdict & { truth: ClaimTruth }> {
  const truth = await loadClaimTruth(db, merchantId, vendorId, sku);
  return { ...checkClaims(body, truth), truth };
}
