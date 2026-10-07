import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ActionContext } from "@/lib/policy/types";
import type { ActionInput } from "@/lib/mcp/schemas";

/**
 * The facts a policy decision rests on, read from the database.
 *
 * An agent proposes an action; it does not get to describe the world it is
 * acting in. Who the payee is, whether they are approved, what a product costs:
 * all of it is looked up here from the merchant's own records, keyed by what the
 * agent named. An agent that lies about a cost, a payee's status or a margin has
 * nothing to lie in, because those fields are not part of what it sends.
 *
 * Failures to find something are returned as absence, never as a default. The
 * engine then reads absence the safe way round: a payout to a payee that could
 * not be found is refused, and a sale whose cost could not be found waits for a
 * human.
 */

export type ResolvedFacts = Pick<ActionContext, "payee" | "economics">;

export async function resolveActionFacts(merchantId: string, input: ActionInput): Promise<ResolvedFacts> {
  const db = createAdminClient();

  if (input.actionType === "payout.create") {
    const { data: payee, error } = await db
      .from("payees")
      .select("id, status, vendor_id")
      .eq("id", input.params.payeeId)
      .eq("merchant_id", merchantId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!payee) return {};
    const { data: vendor, error: vendorError } = await db
      .from("vendors")
      .select("status")
      .eq("id", payee.vendor_id)
      .eq("merchant_id", merchantId)
      .maybeSingle();
    if (vendorError) throw new Error(vendorError.message);
    return {
      payee: { id: payee.id, status: payee.status, vendorStatus: vendor?.status ?? "blocked" },
    };
  }

  if (input.actionType === "price.change") {
    const { data: product, error } = await db
      .from("products")
      .select("cost_price_paise")
      .eq("merchant_id", merchantId)
      .eq("sku", input.params.sku)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!product) return {};
    return { economics: { revenuePaise: input.amount, costPaise: product.cost_price_paise } };
  }

  if (input.actionType === "order.create" || input.actionType === "payment_link.create") {
    const items = input.params.lineItems;
    if (!items || items.length === 0) return {};
    const skus = [...new Set(items.map((i) => i.sku))];
    const { data: products, error } = await db
      .from("products")
      .select("sku, cost_price_paise")
      .eq("merchant_id", merchantId)
      .in("sku", skus);
    if (error) throw new Error(error.message);
    const bySku = new Map((products ?? []).map((p) => [p.sku, p.cost_price_paise]));
    // Any line whose product is unknown, or whose cost is unrecorded, makes the
    // whole sale's cost unknown. One uncostable line cannot be averaged away.
    let cost = 0;
    for (const item of items) {
      const unit = bySku.get(item.sku);
      if (unit === undefined || unit === null) return { economics: { revenuePaise: input.amount, costPaise: null } };
      cost += unit * item.qty;
    }
    return { economics: { revenuePaise: input.amount, costPaise: cost } };
  }

  return {};
}

/**
 * Checks that are about the world rather than a policy, run before any rule.
 * Each returns the reason the action cannot proceed, or null.
 *
 *  - A refund must be of a payment this business actually received. Otherwise a
 *    deployment where tenants share one Razorpay account could refund another
 *    tenant's customer, and an agent could be pointed at any payment id.
 *  - A payout must be against a purchase order that exists, belongs to the payee's
 *    supplier, is still open, and has at least this much advance left unpaid.
 *    Without it, an agent could pay an approved payee any amount under the caps,
 *    again and again, against one order or none. Paying an order down to zero also
 *    makes a second payment against it impossible, which is what stops a retried
 *    or duplicated request from paying twice.
 */
const OPEN_PO = ["draft", "quoting", "awaiting_approval", "approved"];

export async function hardChecks(merchantId: string, input: ActionInput): Promise<string | null> {
  const db = createAdminClient();

  if (input.actionType === "refund.create") {
    const { data, error } = await db
      .from("sales")
      .select("id")
      .eq("merchant_id", merchantId)
      .or(`razorpay_payment_id.eq.${input.params.paymentId},razorpay_payment_id.like.${input.params.paymentId}#%`)
      .limit(1);
    if (error) throw new Error(error.message);
    if ((data ?? []).length === 0) return "That payment is not one of this business's recorded sales, so it cannot be refunded here.";
    return null;
  }

  if (input.actionType === "payout.create") {
    const { data: payee, error } = await db.from("payees").select("vendor_id").eq("id", input.params.payeeId).eq("merchant_id", merchantId).maybeSingle();
    if (error) throw new Error(error.message);
    // An unknown payee is the payee rule's to refuse, with its own explanation.
    if (!payee) return null;

    const { data: po, error: poError } = await db
      .from("purchase_orders")
      .select("id, vendor_id, status, advance_paise")
      .eq("id", input.params.poId)
      .eq("merchant_id", merchantId)
      .maybeSingle();
    if (poError) throw new Error(poError.message);
    if (!po) return "This payout names a purchase order that does not exist.";
    if (po.vendor_id !== payee.vendor_id) return "This payout's purchase order is for a different supplier than the payee.";
    if (!OPEN_PO.includes(po.status)) return `This purchase order is ${po.status.replace("_", " ")}, so it cannot take another payout.`;

    const { data: paid, error: paidError } = await db
      .from("payouts")
      .select("amount_paise")
      .eq("merchant_id", merchantId)
      .eq("po_id", po.id)
      .in("status", ["queued", "processing", "processed"]);
    if (paidError) throw new Error(paidError.message);
    const remaining = Number(po.advance_paise) - (paid ?? []).reduce((n, p) => n + Number(p.amount_paise), 0);
    if (input.amount > remaining) {
      return `This payout is ₹${(input.amount / 100).toLocaleString("en-IN")} but the order has only ₹${(Math.max(remaining, 0) / 100).toLocaleString("en-IN")} of advance left to pay.`;
    }
  }
  return null;
}
