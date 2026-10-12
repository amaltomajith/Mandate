import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getSettings } from "@/lib/settings";
import { getInventoryInsights, deadStockValue, type ProductInsight } from "@/lib/inventory";
import { walletBalancePaise } from "@/lib/ledger";
import { fail, ok, rupees, type McpContext } from "./shared";

/**
 * The store, as an MCP server: what is on the shelf, what is selling, what is
 * stuck, and what the merchant can afford.
 *
 * Read-only apart from nothing: this server cannot change a price or move money.
 * Those go through the Payment Wall. Cost prices are deliberately not returned:
 * an agent that never sees a cost cannot repeat it to a buyer or a supplier.
 * Where an agent needs to negotiate, `evaluate_offer` answers with a decision and
 * a counter-price instead of revealing the floor behind it.
 */

/** Steps a clearance walks down, as a share of the original price. */
const DISCOUNT_STEPS = [0.1, 0.2, 0.3, 0.4];

function publicView(i: ProductInsight) {
  return {
    sku: i.sku,
    name: i.name,
    category: i.category,
    price: rupees(i.pricePaise),
    price_paise: i.pricePaise,
    original_price_paise: i.compareAtPaise,
    stock: i.stockQty,
    inbound: i.inboundQty,
    sold_last_30_days: i.units30d,
    per_day: Number(i.velocityPerDay.toFixed(2)),
    runway_days: i.runwayDays === null ? null : Math.round(i.runwayDays),
    lead_time_days: i.leadTimeDays,
    status: i.status,
    needs_restock: i.needsRestock,
    reorder_qty: i.reorderQty,
    cash_tied_up: i.cashTiedPaise === null ? null : rupees(i.cashTiedPaise),
  };
}

/** The next price down the clearance ladder, never below the margin floor. */
export function nextClearancePrice(i: ProductInsight): { pricePaise: number | null; discountPct: number | null; atFloor: boolean } {
  if (i.floorPricePaise === null) return { pricePaise: null, discountPct: null, atFloor: false };
  const original = i.compareAtPaise ?? i.pricePaise;
  for (const step of DISCOUNT_STEPS) {
    // Whole rupees, rounded UP so a rounding step can never dip under the floor.
    const target = Math.ceil((original * (1 - step)) / 100) * 100;
    if (target >= i.pricePaise) continue; // already at or below this rung
    if (target < i.floorPricePaise) {
      const atFloorPrice = Math.ceil(i.floorPricePaise / 100) * 100;
      return atFloorPrice < i.pricePaise
        ? { pricePaise: atFloorPrice, discountPct: Math.round((1 - atFloorPrice / original) * 100), atFloor: true }
        : { pricePaise: null, discountPct: null, atFloor: true };
    }
    return { pricePaise: target, discountPct: Math.round(step * 100), atFloor: false };
  }
  return { pricePaise: null, discountPct: null, atFloor: false };
}

export function createStoreServer(ctx: McpContext): McpServer {
  const server = new McpServer({ name: "store", version: "0.3.0" });
  const insights = async () => {
    const settings = await getSettings(ctx.db, ctx.merchantId);
    return { settings, items: await getInventoryInsights(ctx.db, ctx.merchantId, settings.min_margin_bps) };
  };

  server.registerTool(
    "get_inventory",
    {
      title: "Inventory",
      description:
        "Every active product with stock, sales pace, days of stock left, and whether it needs restocking. Use this first to see the state of the store.",
      inputSchema: z.object({}),
    },
    async () => {
      const { items } = await insights();
      return ok(items.filter((i) => i.active).map(publicView));
    }
  );

  server.registerTool(
    "list_dead_stock",
    {
      title: "Dead and overstocked products",
      description:
        "Products that are not selling or have far more stock than they will ever sell, with the cash tied up in them and the next safe clearance price (a price that still clears the merchant's margin floor).",
      inputSchema: z.object({}),
    },
    async () => {
      const { items } = await insights();
      const stuck = items.filter((i) => i.active && (i.status === "dead" || i.status === "overstock") && i.stockQty > 0);
      return ok({
        cash_tied_up_in_dead_stock: rupees(deadStockValue(items)),
        products: stuck
          .sort((a, b) => (b.cashTiedPaise ?? 0) - (a.cashTiedPaise ?? 0))
          .map((i) => {
            const next = nextClearancePrice(i);
            return {
              ...publicView(i),
              next_clearance_price_paise: next.pricePaise,
              next_discount_percent: next.discountPct,
              at_margin_floor: next.atFloor,
              cost_known: i.costPaise !== null,
            };
          }),
      });
    }
  );

  server.registerTool(
    "get_cash_position",
    {
      title: "Cash position",
      description: "The wallet balance, what was paid to suppliers and earned this week, and how much more may be spent on restocking under the merchant's budget.",
      inputSchema: z.object({}),
    },
    async () => {
      const settings = await getSettings(ctx.db, ctx.merchantId);
      const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const [paid, sold, balance] = await Promise.all([
        ctx.db.from("payouts").select("amount_paise").eq("merchant_id", ctx.merchantId).in("status", ["queued", "processing", "processed"]).gte("created_at", since),
        ctx.db.from("sales").select("amount_paise").eq("merchant_id", ctx.merchantId).gte("captured_at", since).or("razorpay_payment_id.is.null,razorpay_payment_id.not.like.sample_%").or("razorpay_payment_id.is.null,razorpay_payment_id.not.like.credit_%"),
        walletBalancePaise(ctx.merchantId),
      ]);
      const spent = (paid.data ?? []).reduce((n, r) => n + Number(r.amount_paise), 0);
      const earned = (sold.data ?? []).reduce((n, r) => n + Number(r.amount_paise), 0);
      const allowance = Math.min(
        Number(settings.weekly_payout_budget_paise),
        Number(settings.starting_float_paise) + Math.floor((earned * settings.payout_budget_pct) / 100)
      );
      return ok({
        wallet_balance: rupees(balance),
        earned_this_week: rupees(earned),
        paid_to_suppliers_this_week: rupees(spent),
        restock_budget_remaining_paise: Math.max(0, allowance - spent),
        restock_budget_remaining: rupees(Math.max(0, allowance - spent)),
      });
    }
  );

  server.registerTool(
    "evaluate_offer",
    {
      title: "Evaluate a buyer's offer",
      description:
        "Decide how to answer a buyer's price. Returns accept, counter (with a counter price), or decline. The merchant's floor is never revealed; negotiate only within this answer. Never quote a price below the counter price you are given.",
      inputSchema: z.object({
        sku: z.string(),
        offered_price_paise: z.number().int().positive().describe("The buyer's offered price per unit, in paise."),
      }),
    },
    async ({ sku, offered_price_paise }) => {
      const { items } = await insights();
      const p = items.find((i) => i.sku === sku && i.active);
      if (!p) return fail(`No active product "${sku}".`);
      if (p.floorPricePaise === null) {
        return ok({ decision: "decline", reason: "This product has no recorded cost, so a person must set its price.", ask_price_paise: p.pricePaise });
      }
      const ask = p.pricePaise;
      // Room to concede: up to 10% below the current price, never below the floor.
      const lowestAcceptable = Math.max(Math.ceil(p.floorPricePaise / 100) * 100, Math.ceil((ask * 0.9) / 100) * 100);
      if (offered_price_paise >= lowestAcceptable) {
        return ok({ decision: "accept", price_paise: Math.min(offered_price_paise, ask), ask_price_paise: ask });
      }
      // Meet part-way, but only if the buyer is in the same neighbourhood.
      if (offered_price_paise < lowestAcceptable * 0.7) {
        return ok({ decision: "decline", reason: "The offer is far below what can be accepted.", counter_price_paise: lowestAcceptable, ask_price_paise: ask });
      }
      const mid = Math.ceil((offered_price_paise + ask) / 2 / 100) * 100;
      return ok({ decision: "counter", counter_price_paise: Math.max(lowestAcceptable, Math.min(mid, ask)), ask_price_paise: ask });
    }
  );

  server.registerTool(
    "list_customers",
    {
      title: "Customers who opted in",
      description: "Customers who agreed to receive offers. The only people the Selling agent may start a conversation with.",
      inputSchema: z.object({}),
    },
    async () => {
      const { data, error } = await ctx.db.from("customers").select("id, name").eq("merchant_id", ctx.merchantId).eq("marketing_opt_in", true).limit(50);
      if (error) return fail(error.message);
      return ok(data ?? []);
    }
  );

  return server;
}
