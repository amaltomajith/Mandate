import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { fail, ok, rupees, type McpContext } from "./shared";

/**
 * Suppliers, quotes and purchase orders, as an MCP server.
 *
 * This server can record what a supplier said and draft an order. It cannot pay
 * anyone, create a payee or approve a vendor: those are a human's, done in the
 * dashboard, and money moves only through the Payment Wall. A purchase order here
 * is a record of intent; the payout that funds it is a separate action the wall
 * judges.
 */

export function createPurchasingServer(ctx: McpContext): McpServer {
  const server = new McpServer({ name: "purchasing", version: "0.3.0" });

  server.registerTool(
    "list_vendors",
    {
      title: "Suppliers",
      description: "The merchant's suppliers with their status, categories and whether they have an approved payment account. Only approved vendors can be contacted or paid.",
      inputSchema: z.object({ category: z.string().optional() }),
    },
    async ({ category }) => {
      const [vendors, payees] = await Promise.all([
        ctx.db.from("vendors").select("*").eq("merchant_id", ctx.merchantId).order("reliability", { ascending: false }),
        ctx.db.from("payees").select("vendor_id, status").eq("merchant_id", ctx.merchantId),
      ]);
      if (vendors.error) return fail(vendors.error.message);
      const active = new Set((payees.data ?? []).filter((p) => p.status === "active").map((p) => p.vendor_id));
      return ok(
        (vendors.data ?? [])
          .filter((v) => !category || (v.categories as string[]).includes(category))
          .map((v) => ({
            id: v.id,
            name: v.name,
            status: v.status,
            channel: v.channel,
            categories: v.categories,
            reliability: v.reliability,
            has_approved_payee: active.has(v.id),
            simulated: v.simulated,
          }))
      );
    }
  );

  server.registerTool(
    "add_vendor_candidate",
    {
      title: "Add a supplier candidate",
      description:
        "Record a supplier found by research. It lands as a CANDIDATE: nobody will contact or pay it until the merchant approves it in the dashboard. Include whatever contact details were found.",
      inputSchema: z.object({
        name: z.string().min(2).max(120),
        website: z.string().url().optional(),
        email: z.string().email().optional(),
        phone: z.string().max(30).optional(),
        categories: z.array(z.string()).max(5).default([]),
        notes: z.string().max(500).optional(),
      }),
    },
    async (v) => {
      if (!v.email && !v.phone && !v.website) return fail("A candidate needs at least an email, phone or website.");
      const { data: dup } = await ctx.db.from("vendors").select("id").eq("merchant_id", ctx.merchantId).ilike("name", v.name).maybeSingle();
      if (dup) return ok({ id: dup.id, created: false, note: "A supplier with this name already exists." });
      const { data, error } = await ctx.db
        .from("vendors")
        .insert({
          merchant_id: ctx.merchantId,
          name: v.name,
          website: v.website ?? null,
          email: v.email ?? null,
          phone: v.phone ?? null,
          categories: v.categories,
          notes: v.notes ?? null,
          source: "research",
          status: "candidate",
          channel: v.email ? "email" : v.phone ? "whatsapp" : "email",
        })
        .select("id")
        .single();
      if (error) return fail(error.message);
      return ok({ id: data.id, created: true, status: "candidate", note: "Awaiting the merchant's approval before any contact." });
    }
  );

  server.registerTool(
    "list_quotes",
    {
      title: "Quotes for a product",
      description: "Open supplier quotes for a product, newest first.",
      inputSchema: z.object({ sku: z.string() }),
    },
    async ({ sku }) => {
      const { data: product } = await ctx.db.from("products").select("id").eq("merchant_id", ctx.merchantId).eq("sku", sku).maybeSingle();
      if (!product) return fail(`No product "${sku}".`);
      const { data, error } = await ctx.db
        .from("quotes")
        .select("id, vendor_id, unit_price_paise, moq, lead_time_days, valid_until, status, created_at")
        .eq("merchant_id", ctx.merchantId)
        .eq("product_id", product.id)
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) return fail(error.message);
      return ok((data ?? []).map((q) => ({ ...q, unit_price: rupees(q.unit_price_paise) })));
    }
  );

  server.registerTool(
    "list_purchase_orders",
    {
      title: "Purchase orders",
      description: "Purchase orders and where each stands.",
      inputSchema: z.object({ status: z.string().optional() }),
    },
    async ({ status }) => {
      let q = ctx.db.from("purchase_orders").select("*").eq("merchant_id", ctx.merchantId).order("created_at", { ascending: false }).limit(30);
      if (status) q = q.eq("status", status);
      const { data, error } = await q;
      if (error) return fail(error.message);
      return ok((data ?? []).map((p) => ({ ...p, total: rupees(Number(p.total_paise)), advance: rupees(Number(p.advance_paise)) })));
    }
  );

  return server;
}
