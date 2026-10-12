import type { SupabaseClient } from "@supabase/supabase-js";
import { festivalBufferDays } from "@/lib/festivals";

/**
 * Inventory economics: how fast things sell, how long stock lasts, what is
 * stuck, and what to reorder.
 *
 * Everything here is deterministic arithmetic over the merchant's own records.
 * The agents do not estimate demand or guess a reorder quantity; they are handed
 * these numbers, so a language model's confidence never decides how much money
 * is spent or how much stock is bought.
 */

/** Days of cover held back beyond a supplier's lead time before it counts as low. */
export const SAFETY_DAYS = 7;
/** How many days of demand a restock order should cover once it lands. */
export const RESTOCK_COVER_DAYS = 30;
/** More cover than this, or no sale in {@link DEAD_AFTER_DAYS}, is dead stock. */
export const OVERSTOCK_COVER_DAYS = 120;
export const DEAD_AFTER_DAYS = 45;

export type StockStatus = "stockout" | "low" | "healthy" | "overstock" | "dead";

export interface ProductInsight {
  productId: string;
  sku: string;
  name: string;
  category: string;
  active: boolean;
  pricePaise: number;
  /** The price before a clearance discount, if one is running. */
  compareAtPaise: number | null;
  costPaise: number | null;
  /** For GST exports; null until the merchant sets them. */
  hsnCode?: string | null;
  gstRateBps?: number | null;
  stockQty: number;
  reorderPoint: number;
  leadTimeDays: number;
  units14d: number;
  units30d: number;
  velocityPerDay: number;
  /** Days until stock runs out at the current pace; null when nothing is selling. */
  runwayDays: number | null;
  daysSinceLastSale: number | null;
  status: StockStatus;
  /** Cash sitting on the shelf, at cost. */
  cashTiedPaise: number | null;
  marginBps: number | null;
  /** The lowest price that still clears the margin floor. Null when cost is unknown. */
  floorPricePaise: number | null;
  /** Units already ordered and paid for but not yet received. */
  inboundQty: number;
  needsRestock: boolean;
  /** How many units to order now; 0 when no restock is needed. */
  reorderQty: number;
}

/** The lowest price that keeps `minMarginBps` of margin over `costPaise`. */
export function floorPrice(costPaise: number, minMarginBps: number): number {
  return Math.ceil(costPaise / (1 - minMarginBps / 10000));
}

export async function getInventoryInsights(
  db: SupabaseClient,
  merchantId: string,
  minMarginBps: number,
  /** Lengthen supplier lead times around festivals: the merchant's switch. */
  opts: { festivalBuffer?: boolean; now?: Date } = {}
): Promise<ProductInsight[]> {
  const [products, stats, inbound] = await Promise.all([
    db.from("products").select("*").eq("merchant_id", merchantId).order("name"),
    db.from("product_stats").select("*").eq("merchant_id", merchantId),
    getInboundByProduct(db, merchantId),
  ]);
  if (products.error) throw new Error(products.error.message);
  if (stats.error) throw new Error(stats.error.message);

  const statsById = new Map((stats.data ?? []).map((s) => [s.product_id as string, s]));
  const now = Date.now();
  const buffer = opts.festivalBuffer ? festivalBufferDays(opts.now ?? new Date()).days : 0;

  return (products.data ?? []).map((p) => {
    const s = statsById.get(p.id);
    const units14d = Number(s?.units_14d ?? 0);
    const units30d = Number(s?.units_30d ?? 0);
    // Recent weeks count more, but a single busy fortnight should not read as a
    // permanent pace; blend the two windows.
    const velocityPerDay = 0.6 * (units14d / 14) + 0.4 * (units30d / 30);
    const runwayDays = velocityPerDay > 0 ? p.stock_qty / velocityPerDay : null;
    const lastSale = s?.last_sale_at ? new Date(s.last_sale_at).getTime() : null;
    const daysSinceLastSale = lastSale === null ? null : Math.floor((now - lastSale) / 86_400_000);
    const inboundQty = inbound.get(p.id) ?? 0;
    const cost = p.cost_price_paise as number | null;

    let status: StockStatus;
    const cover = runwayDays ?? Infinity;
    if (p.stock_qty === 0) status = "stockout";
    else if (units30d === 0 && (daysSinceLastSale === null || daysSinceLastSale >= DEAD_AFTER_DAYS)) status = "dead";
    else if (cover > OVERSTOCK_COVER_DAYS) status = velocityPerDay === 0 ? "dead" : "overstock";
    else if (velocityPerDay > 0 && cover < p.lead_time_days + buffer + SAFETY_DAYS) status = "low";
    else status = "healthy";

    const covered = velocityPerDay > 0 ? (p.stock_qty + inboundQty) / velocityPerDay : Infinity;
    const needsRestock =
      p.active &&
      velocityPerDay > 0 &&
      (covered < p.lead_time_days + buffer + SAFETY_DAYS || p.stock_qty + inboundQty <= p.reorder_point);
    const reorderQty = needsRestock
      ? Math.max(1, Math.ceil(velocityPerDay * (p.lead_time_days + buffer + RESTOCK_COVER_DAYS)) - p.stock_qty - inboundQty)
      : 0;

    return {
      productId: p.id,
      sku: p.sku,
      name: p.name,
      category: p.category,
      active: p.active,
      pricePaise: p.price_paise,
      compareAtPaise: p.compare_at_price_paise ?? null,
      costPaise: cost,
      hsnCode: (p.hsn_code as string | null) ?? null,
      gstRateBps: (p.gst_rate_bps as number | null) ?? null,
      stockQty: p.stock_qty,
      reorderPoint: p.reorder_point,
      leadTimeDays: p.lead_time_days,
      units14d,
      units30d,
      velocityPerDay,
      runwayDays,
      daysSinceLastSale,
      status,
      cashTiedPaise: cost === null ? null : cost * p.stock_qty,
      marginBps: cost === null ? null : Math.round(((p.price_paise - cost) / p.price_paise) * 10000),
      floorPricePaise: cost === null ? null : floorPrice(cost, minMarginBps),
      inboundQty,
      needsRestock,
      reorderQty,
    };
  });
}

/** Units on order (approved or paid, not yet received), by product. */
async function getInboundByProduct(db: SupabaseClient, merchantId: string): Promise<Map<string, number>> {
  const { data: pos, error } = await db
    .from("purchase_orders")
    .select("id")
    .eq("merchant_id", merchantId)
    .in("status", ["approved", "paid"]);
  if (error) throw new Error(error.message);
  const ids = (pos ?? []).map((p) => p.id);
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  const { data: lines, error: lineError } = await db
    .from("po_lines")
    .select("product_id, qty")
    .eq("merchant_id", merchantId)
    .in("po_id", ids);
  if (lineError) throw new Error(lineError.message);
  for (const l of lines ?? []) out.set(l.product_id, (out.get(l.product_id) ?? 0) + l.qty);
  return out;
}

/** Cash tied up in dead and overstocked inventory, at cost. */
export function deadStockValue(insights: ProductInsight[]): number {
  return insights
    .filter((i) => i.status === "dead" || i.status === "overstock")
    .reduce((n, i) => n + (i.cashTiedPaise ?? 0), 0);
}
