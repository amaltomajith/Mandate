import type { Customer, Escalation, Product, Trace } from "@/types/db";
import { deriveOrders } from "@/lib/orders";
import { z } from "zod";

/**
 * Who a campaign is for, computed rather than guessed.
 *
 * The split here mirrors `draft_policy`: a model turns the merchant's sentence
 * into a structured definition, and then something deterministic executes it.
 * "Customers who bought a laptop stand over a month ago and never bought a hub"
 * is a query, not a judgment — running it through a model would make the
 * answer non-reproducible for no gain, and a campaign that targets a slightly
 * different set every time you look at it is not one anybody can approve.
 *
 * So the model's only job is producing the definition below. Everything after
 * that is arithmetic over orders that actually happened.
 */

export const SegmentDefinition = z.object({
  /** Has bought this SKU at least once. */
  boughtSku: z.string().nullable().default(null),
  /** Has never bought this SKU. The complement that makes a cross-sell
   *  campaign meaningful — offering someone what they already own is the
   *  fastest way to be ignored. */
  notBoughtSku: z.string().nullable().default(null),
  /** No completed order in this many days. */
  inactiveForDays: z.number().int().positive().nullable().default(null),
  /** Lifetime completed spend at or above this. */
  minSpendPaise: z.number().int().nonnegative().nullable().default(null),
});
export type SegmentDefinition = z.infer<typeof SegmentDefinition>;

export interface SegmentMember {
  customerId: string;
  name: string;
  ordersPlaced: number;
  lifetimeSpendPaise: number;
  lastOrderAt: string | null;
  daysSinceLastOrder: number | null;
}

export interface SegmentResult {
  members: SegmentMember[];
  /** Customers the definition could have matched but for which the trail
   *  carries no identity. customerId only began being written onto traces
   *  recently, so orders older than that belong to nobody as far as this can
   *  tell. Reported rather than silently excluded: a segment of 3 drawn from a
   *  history where 200 orders are unattributable is a different fact from a
   *  segment of 3 drawn from a complete one. */
  unattributableOrders: number;
  /** Every customer considered, before the definition narrowed it. */
  consideredCustomers: number;
}

interface CustomerHistory {
  customerId: string;
  name: string;
  ordersPlaced: number;
  lifetimeSpendPaise: number;
  lastOrderAt: string | null;
  skus: Set<string>;
}

export function buildSegment(
  definition: SegmentDefinition,
  traces: Trace[],
  escalations: Escalation[],
  products: Product[],
  customers: Customer[],
  now: Date = new Date()
): SegmentResult {
  const orders = deriveOrders(traces, escalations, products, customers);
  const nameToSku = new Map(products.map((p) => [p.name, p.sku]));

  const history = new Map<string, CustomerHistory>();
  let unattributableOrders = 0;

  for (const order of orders) {
    // Only completed orders count toward a customer's history. An order that
    // was refused says something about the policy, not about the customer's
    // appetite, and treating a blocked crypto probe as evidence of a spending
    // relationship would be nonsense.
    if (order.outcome !== "bought" && order.outcome !== "approved") continue;

    if (!order.customerId) {
      unattributableOrders++;
      continue;
    }

    const entry = history.get(order.customerId) ?? {
      customerId: order.customerId,
      name: order.customerName ?? "Unknown",
      ordersPlaced: 0,
      lifetimeSpendPaise: 0,
      lastOrderAt: null,
      skus: new Set<string>(),
    };
    entry.ordersPlaced++;
    entry.lifetimeSpendPaise += order.amountPaise;
    if (!entry.lastOrderAt || order.at > entry.lastOrderAt) entry.lastOrderAt = order.at;
    // deriveOrders resolves a product name; map it back to a SKU so the
    // definition can be written in SKUs, which are stable, rather than in
    // display names, which are not.
    const sku = order.product ? nameToSku.get(order.product) : undefined;
    if (sku) entry.skus.add(sku);
    history.set(order.customerId, entry);
  }

  const members: SegmentMember[] = [];
  for (const h of history.values()) {
    if (definition.boughtSku && !h.skus.has(definition.boughtSku)) continue;
    if (definition.notBoughtSku && h.skus.has(definition.notBoughtSku)) continue;
    if (definition.minSpendPaise !== null && h.lifetimeSpendPaise < definition.minSpendPaise) continue;

    const daysSince = h.lastOrderAt
      ? Math.floor((now.getTime() - new Date(h.lastOrderAt).getTime()) / 86_400_000)
      : null;
    if (definition.inactiveForDays !== null) {
      if (daysSince === null || daysSince < definition.inactiveForDays) continue;
    }

    members.push({
      customerId: h.customerId,
      name: h.name,
      ordersPlaced: h.ordersPlaced,
      lifetimeSpendPaise: h.lifetimeSpendPaise,
      lastOrderAt: h.lastOrderAt,
      daysSinceLastOrder: daysSince,
    });
  }

  // Highest lifetime spend first. Campaign budgets run out, and when they do
  // the money should have gone to the customers most likely to spend again.
  members.sort((a, b) => b.lifetimeSpendPaise - a.lifetimeSpendPaise);

  return { members, unattributableOrders, consideredCustomers: history.size };
}

/** Plain-language description of a definition, for showing a merchant what
 *  they are about to approve. Built from the definition rather than from the
 *  model's own summary of it, so it cannot describe something other than what
 *  will actually run. */
export function describeSegment(d: SegmentDefinition, products: Product[]): string {
  const name = (sku: string) => products.find((p) => p.sku === sku)?.name ?? sku;
  const parts: string[] = [];
  if (d.boughtSku) parts.push(`bought ${name(d.boughtSku)}`);
  if (d.notBoughtSku) parts.push(`never bought ${name(d.notBoughtSku)}`);
  if (d.inactiveForDays !== null) parts.push(`no order in ${d.inactiveForDays} days`);
  if (d.minSpendPaise !== null) parts.push(`spent at least ₹${(d.minSpendPaise / 100).toLocaleString("en-IN")}`);
  return parts.length > 0 ? `Customers who ${parts.join(", ")}` : "Every customer with a completed order";
}
