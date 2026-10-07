import type { Agent, PolicyRule, Trace } from "@/types/db";
import type { StockStatus } from "@/lib/inventory";

export type Vec3 = [number, number, number];

/** The slice of each entity the scene needs. The page passes plain data so the
 *  scene never depends on how the dashboard happens to store things. */
export interface MapProduct {
  id: string;
  sku: string;
  name: string;
  status: StockStatus;
  stockQty: number;
  /** Stock at cost; drives the node's height. 0 when cost is unknown. */
  stockValuePaise: number;
  pricePaise: number;
  compareAtPaise: number | null;
  runwayDays: number | null;
  needsRestock: boolean;
  units30d: number;
}
export interface MapVendor {
  id: string;
  name: string;
  status: "approved" | "candidate" | "blocked";
  simulated: boolean;
}
export interface MapPayee {
  id: string;
  vendorId: string;
  status: "pending" | "active" | "revoked";
  label: string;
}
export interface MapPo {
  id: string;
  vendorId: string;
  status: "draft" | "quoting" | "awaiting_approval" | "approved" | "paid" | "received" | "cancelled";
  totalPaise: number;
}

export interface MapInput {
  agents: Agent[];
  rules: PolicyRule[];
  traces: Trace[];
  products: MapProduct[];
  vendors: MapVendor[];
  payees: MapPayee[];
  purchaseOrders: MapPo[];
  walletPaise: number;
}

export interface Placed<T> {
  item: T;
  position: Vec3;
}

export interface GraphLayout {
  agents: Placed<Agent>[];
  rules: Placed<PolicyRule>[];
  products: Placed<MapProduct>[];
  vendors: Placed<MapVendor>[];
  payees: Placed<MapPayee>[];
  purchaseOrders: Placed<MapPo>[];
  traces: Placed<Trace>[];
  wallet: Vec3;
  agentPositionById: Record<string, Vec3>;
  rulePositionById: Record<string, Vec3>;
  productPositionBySku: Record<string, Vec3>;
  vendorPositionById: Record<string, Vec3>;
  payeePositionById: Record<string, Vec3>;
}

/** The Payment Wall's footprint. Agents live inside it, the store outside it. */
export const WALL_RADIUS = 3.4;
export const WALL_HEIGHT = 3.4;
const OUTER_RADIUS = 6.6;
const AGENT_RADIUS = 1.35;

/** A small stable hash in 0..1, so jitter never changes between renders. */
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 0xffffffff;
}

const polar = (angle: number, radius: number, y: number): Vec3 => [Math.cos(angle) * radius, y, Math.sin(angle) * radius];

/**
 * Deterministic, data-driven layout. No physics, no randomness: the same data
 * always lands in the same place, so a node never wanders and a returning
 * viewer can find things by position.
 *
 *   top tier       guardrail rules, a ring above everything
 *   centre         the Payment Wall, with the agents inside it
 *   left arc       inventory, outside the wall
 *   right arc      suppliers (with their payees as satellites), outside the wall
 *   below          the wallet, with purchase orders hanging between it and suppliers
 *
 * Anything an agent does has to cross the wall to reach the store, so a line
 * from an agent to a product or a supplier always passes through it.
 */
export function computeLayout(input: MapInput): GraphLayout {
  // Agents: the Selling agent faces inventory (left), the Buying agent faces
  // suppliers (right), and any outside agent takes the remaining sides.
  const agentAngle = (a: Agent, i: number) =>
    a.kind === "selling" ? Math.PI : a.kind === "buying" ? 0 : (Math.PI / 2) * (i % 2 === 0 ? 1 : 3);
  const stableAgents = [...input.agents].sort((a, b) => a.id.localeCompare(b.id));
  const agents: Placed<Agent>[] = stableAgents.map((agent, i) => ({ item: agent, position: polar(agentAngle(agent, i), AGENT_RADIUS, 0) }));
  const agentPositionById = Object.fromEntries(agents.map((p) => [p.item.id, p.position]));

  // Rules: a ring on the top tier, as before.
  const activeRules = input.rules.filter((r) => r.status === "active");
  const rules: Placed<PolicyRule>[] = activeRules.map((rule, i) => ({
    item: rule,
    position: polar((i / Math.max(activeRules.length, 1)) * Math.PI * 2, 5.2, 4.3),
  }));
  const rulePositionById = Object.fromEntries(rules.map((p) => [p.item.id, p.position]));

  // Inventory: the left arc, ordered by SKU so positions are stable.
  const sortedProducts = [...input.products].sort((a, b) => a.sku.localeCompare(b.sku));
  const span = Math.min(1.3, 0.28 + sortedProducts.length * 0.16) * Math.PI;
  const products: Placed<MapProduct>[] = sortedProducts.map((p, i) => {
    const t = sortedProducts.length === 1 ? 0.5 : i / (sortedProducts.length - 1);
    const angle = Math.PI - span / 2 + t * span;
    return { item: p, position: polar(angle, OUTER_RADIUS, (hash01(p.sku) - 0.5) * 1.6) };
  });
  const productPositionBySku = Object.fromEntries(products.map((p) => [p.item.sku, p.position]));

  // Suppliers: the right arc.
  const sortedVendors = [...input.vendors].sort((a, b) => a.id.localeCompare(b.id));
  const vSpan = Math.min(1.1, 0.3 + sortedVendors.length * 0.2) * Math.PI;
  const vendors: Placed<MapVendor>[] = sortedVendors.map((v, i) => {
    const t = sortedVendors.length === 1 ? 0.5 : i / (sortedVendors.length - 1);
    const angle = -vSpan / 2 + t * vSpan;
    return { item: v, position: polar(angle, OUTER_RADIUS, (hash01(v.id) - 0.5) * 1.2) };
  });
  const vendorPositionById = Object.fromEntries(vendors.map((p) => [p.item.id, p.position]));

  // Payees orbit their supplier.
  const byVendor = new Map<string, MapPayee[]>();
  for (const p of input.payees) byVendor.set(p.vendorId, [...(byVendor.get(p.vendorId) ?? []), p]);
  const payees: Placed<MapPayee>[] = [];
  for (const [vendorId, list] of byVendor) {
    const base = vendorPositionById[vendorId];
    if (!base) continue;
    list.forEach((p, i) => {
      const a = (i / Math.max(list.length, 1)) * Math.PI * 2 + 0.6;
      payees.push({ item: p, position: [base[0] + Math.cos(a) * 0.95, base[1] + 0.35, base[2] + Math.sin(a) * 0.95] });
    });
  }
  const payeePositionById = Object.fromEntries(payees.map((p) => [p.item.id, p.position]));

  // The wallet sits under the wall; orders hang between it and their supplier.
  const wallet: Vec3 = [0, -3.9, 0];
  const livePos = input.purchaseOrders.filter((p) => p.status !== "cancelled").slice(0, 12);
  const purchaseOrders: Placed<MapPo>[] = livePos.flatMap((po, i) => {
    const v = vendorPositionById[po.vendorId];
    if (!v) return [];
    const f = 0.5 + ((i % 3) - 1) * 0.1;
    return [{ item: po, position: [wallet[0] + (v[0] - wallet[0]) * f, wallet[1] + (v[1] - wallet[1]) * f - 0.5 - (i % 2) * 0.3, wallet[2] + (v[2] - wallet[2]) * f] as Vec3 }];
  });

  // Traces spiral below the agent that made them, inside the wall.
  const byAgent = new Map<string, Trace[]>();
  for (const trace of input.traces) {
    const key = trace.agent_id ?? "__none__";
    byAgent.set(key, [...(byAgent.get(key) ?? []), trace]);
  }
  const traces: Placed<Trace>[] = [];
  for (const [agentId, list] of byAgent) {
    const base = agentPositionById[agentId] ?? ([0, 0.6, 0] as Vec3);
    [...list]
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .forEach((trace, i) => {
        const angle = i * 0.85;
        const radius = 0.5 + (i % 12) * 0.07;
        traces.push({
          item: trace,
          position: [base[0] + Math.cos(angle) * radius, base[1] - 0.9 - (i % 6) * 0.17, base[2] + Math.sin(angle) * radius],
        });
      });
  }

  return { agents, rules, products, vendors, payees, purchaseOrders, traces, wallet, agentPositionById, rulePositionById, productPositionBySku, vendorPositionById, payeePositionById };
}

/** Where on the wall the line from `from` to `to` crosses it, or null if it does not. */
export function wallCrossing(from: Vec3, to: Vec3): { angle: number; y: number } | null {
  const dx = to[0] - from[0];
  const dz = to[2] - from[2];
  const a = dx * dx + dz * dz;
  if (a === 0) return null;
  const b = 2 * (from[0] * dx + from[2] * dz);
  const c = from[0] * from[0] + from[2] * from[2] - WALL_RADIUS * WALL_RADIUS;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const t = (-b + Math.sqrt(disc)) / (2 * a); // the exit point, from inside to out
  if (t < 0 || t > 1) return null;
  const x = from[0] + dx * t;
  const z = from[2] + dz * t;
  const y = from[1] + (to[1] - from[1]) * t;
  return { angle: Math.atan2(z, x), y: Math.max(-WALL_HEIGHT / 2, Math.min(WALL_HEIGHT / 2, y)) };
}

/** Which scene node an action is about, so its line can run to the right place. */
export function actionTarget(trace: Trace, layout: GraphLayout): Vec3 | null {
  const p = trace.params as { payeeId?: string; sku?: string; lineItems?: { sku: string }[] } | null;
  if (!p) return null;
  if (trace.action_type === "payout.create" && p.payeeId) return layout.payeePositionById[p.payeeId] ?? null;
  const sku = p.sku ?? p.lineItems?.[0]?.sku;
  return sku ? (layout.productPositionBySku[sku] ?? null) : null;
}
