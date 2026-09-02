import type { Customer, Escalation, Product, Trace } from "@/types/db";

/**
 * Buying history, read back out of the audit trail.
 *
 * This is a different question from the one the Transactions tab answers.
 * That tab is the full log: every action the control plane saw, including
 * simulate-mode previews that never moved money and forged requests that died
 * at the signature check. Useful when something needs investigating, and the
 * wrong thing to hand a merchant who wants to know how their shop is doing.
 *
 * This reads the same rows as commerce: what was bought, for whom, what it
 * cost, and whether a human had to get involved. Only `enforce`-mode order
 * traces qualify — a preview is not a purchase, and a rejected signature is
 * not a customer.
 *
 * Every number below is a count or a sum over rows that already exist. There
 * is no projection here and no modelled counterfactual: if the trail cannot
 * say something, this reports that it cannot.
 */

/** What became of an order. `bought` and `approved` both mean money moved;
 *  they are kept apart because the difference — whether the merchant had to
 *  stop and answer — is the thing a merchant is actually trying to reduce. */
export type OrderOutcome = "bought" | "approved" | "awaiting" | "declined" | "refused";

export interface Order {
  traceId: string;
  at: string;
  /** null when the order was not for a catalog product — a banned-category
   *  probe, or an order placed before SKUs were recorded on the trace. Left
   *  null rather than guessed; see productOf. */
  product: string | null;
  category: string;
  amountPaise: number;
  currency: string;
  /** Present only on orders placed after customerId began being persisted on
   *  the trace. Segmentation needs the id, not the name -- a name is not an
   *  identity. */
  customerId: string | null;
  customerName: string | null;
  outcome: OrderOutcome;
  reasoning: string | null;
  /** Bought because the agent proposed it off the back of another purchase. */
  isUpsell: boolean;
}

export interface BestSeller {
  product: string;
  orders: number;
  revenuePaise: number;
}

export interface BuyingSummary {
  /** Orders where money actually moved: cleared outright plus approved. */
  ordersPlaced: number;
  revenuePaise: number;
  /** Revenue over orders placed. 0 when nothing has sold. */
  averageOrderPaise: number;
  /** Share of placed orders the agent completed without asking, 0–1. The
   *  number a merchant wants near 1: it is how much of their shop runs
   *  without them. */
  unaidedShare: number;
  /**
   * The same share weighted by money rather than by order count, and it is
   * usually the more honest of the two.
   *
   * They diverge whenever the step-up threshold sits low against the cap: most
   * orders are small and clear, most VALUE is in the few large ones that do
   * not. Reporting only the count answers "how often do I get involved" while
   * looking like an answer to "how much of my money runs without me". This is
   * exactly the trade the threshold tuner exists to make visible, so stating
   * the gap is stronger than leaving it to be found.
   */
  unaidedValueShare: number;
  /** Orders still sitting in the escalation queue — money neither earned nor
   *  lost, and the one figure here the merchant can move today. */
  awaitingCount: number;
  awaitingPaise: number;
  upsellOrders: number;
  upsellRevenuePaise: number;
  /** Upsold orders over orders that could have carried an upsell (every
   *  placed order that wasn't itself an upsell), 0–1. */
  attachRate: number;
  bestSellers: BestSeller[];
}

interface TraceParams {
  amount?: number;
  currency?: string;
  category?: string;
  customerId?: string | null;
  notes?: { sku?: string; item?: string; source?: string } | null;
}

function paramsOf(trace: Trace): TraceParams {
  return (trace.params ?? {}) as TraceParams;
}

/**
 * The product an order was for.
 *
 * Preferred source is the SKU recorded on the trace when the order was placed.
 * Orders written before that was recorded have only an amount and a category,
 * so those fall back to a catalog lookup — and only when exactly one product
 * matches both. Two products at the same price in the same category make the
 * answer ambiguous, and an ambiguous answer here would print a confident
 * product name onto an order that may not have been for it.
 */
function productOf(trace: Trace, bySku: Map<string, Product>, byPriceCategory: Map<string, Product | null>): string | null {
  const params = paramsOf(trace);
  const sku = params.notes?.sku;
  if (sku) return bySku.get(sku)?.name ?? params.notes?.item ?? null;
  if (params.notes?.item) return params.notes.item;

  const amount = params.amount;
  const category = params.category;
  if (typeof amount !== "number" || !category) return null;
  return byPriceCategory.get(`${amount}:${category}`)?.name ?? null;
}

export function deriveOrders(
  traces: Trace[],
  escalations: Escalation[],
  products: Product[],
  customers: Customer[]
): Order[] {
  const escalationStatus = new Map(escalations.map((e) => [e.trace_id, e.status]));
  const customerName = new Map(customers.map((c) => [c.id, c.name]));
  const bySku = new Map(products.map((p) => [p.sku, p]));

  // Ambiguous price+category pairs map to null rather than to one of the
  // colliding products, so the fallback declines to answer instead of
  // guessing wrong half the time.
  const byPriceCategory = new Map<string, Product | null>();
  for (const p of products) {
    const key = `${p.price_paise}:${p.category}`;
    byPriceCategory.set(key, byPriceCategory.has(key) ? null : p);
  }

  const orders: Order[] = [];

  for (const trace of traces) {
    if (trace.mode !== "enforce") continue;
    if (trace.action_type !== "order.create") continue;
    if (trace.decision === "protocol_reject") continue;

    const params = paramsOf(trace);
    let outcome: OrderOutcome;
    if (trace.decision === "allow") {
      outcome = "bought";
    } else if (trace.decision === "block") {
      outcome = "refused";
    } else {
      const status = escalationStatus.get(trace.id);
      outcome = status === "approved" ? "approved" : status === "denied" ? "declined" : "awaiting";
    }

    orders.push({
      traceId: trace.id,
      at: trace.created_at,
      product: productOf(trace, bySku, byPriceCategory),
      category: params.category ?? "—",
      amountPaise: typeof params.amount === "number" ? params.amount : 0,
      currency: params.currency ?? "INR",
      customerId: params.customerId ?? null,
      customerName: params.customerId ? customerName.get(params.customerId) ?? null : null,
      outcome,
      reasoning: trace.reasoning,
      isUpsell: trace.parent_trace_id !== null,
    });
  }

  return orders;
}

export function summarizeOrders(orders: Order[]): BuyingSummary {
  const placed = orders.filter((o) => o.outcome === "bought" || o.outcome === "approved");
  const revenuePaise = placed.reduce((sum, o) => sum + o.amountPaise, 0);
  const unaidedOrders = placed.filter((o) => o.outcome === "bought");
  const unaided = unaidedOrders.length;
  const unaidedValuePaise = unaidedOrders.reduce((sum, o) => sum + o.amountPaise, 0);
  const awaiting = orders.filter((o) => o.outcome === "awaiting");

  const upsells = placed.filter((o) => o.isUpsell);
  const upsellable = placed.length - upsells.length;

  const revenueByProduct = new Map<string, BestSeller>();
  for (const order of placed) {
    if (!order.product) continue;
    const entry = revenueByProduct.get(order.product) ?? { product: order.product, orders: 0, revenuePaise: 0 };
    entry.orders += 1;
    entry.revenuePaise += order.amountPaise;
    revenueByProduct.set(order.product, entry);
  }

  return {
    ordersPlaced: placed.length,
    revenuePaise,
    averageOrderPaise: placed.length > 0 ? Math.round(revenuePaise / placed.length) : 0,
    unaidedShare: placed.length > 0 ? unaided / placed.length : 0,
    unaidedValueShare: revenuePaise > 0 ? unaidedValuePaise / revenuePaise : 0,
    awaitingCount: awaiting.length,
    awaitingPaise: awaiting.reduce((sum, o) => sum + o.amountPaise, 0),
    upsellOrders: upsells.length,
    upsellRevenuePaise: upsells.reduce((sum, o) => sum + o.amountPaise, 0),
    // Denominator is orders that *could* have carried an upsell. Dividing by
    // every placed order instead would count the upsells themselves as
    // opportunities and quietly depress the rate.
    attachRate: upsellable > 0 ? upsells.length / upsellable : 0,
    bestSellers: [...revenueByProduct.values()].sort((a, b) => b.revenuePaise - a.revenuePaise),
  };
}
