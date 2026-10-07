"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireDashboardUser } from "./authGuard";
import { getCurrentMerchant } from "@/lib/merchant";
import { PRODUCT_CATEGORIES } from "@/lib/catalog";

/**
 * The merchant's own management of what they sell.
 *
 * Every mutation matches on merchant as well as id: a row id is not
 * authorization, and no function here accepts a merchant id from the caller. The
 * tenant always comes from the signed-in session.
 */

async function scope() {
  await requireDashboardUser();
  return { merchant: await getCurrentMerchant(), db: createAdminClient() };
}

export interface ProductInput {
  sku: string;
  name: string;
  description: string;
  category: string;
  pricePaise: number;
  /** Landed unit cost. Null leaves it unknown, which makes the margin rule hold every sale of it for a person. */
  costPaise: number | null;
  stockQty: number;
  reorderPoint: number;
  leadTimeDays: number;
}

const wholeNumber = (n: unknown, min: number, label: string): number => {
  if (typeof n !== "number" || !Number.isInteger(n) || n < min) throw new Error(`${label} must be a whole number, ${min} or more.`);
  return n;
};

function validate(input: ProductInput) {
  const sku = input.sku.trim().toLowerCase();
  const name = input.name.trim();
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(sku)) throw new Error("A SKU is lowercase letters, digits and dashes, 2 to 41 characters.");
  if (name.length < 2) throw new Error("Give the product a name.");
  if (!(PRODUCT_CATEGORIES as readonly string[]).includes(input.category)) {
    // Category rules match the string exactly, so an unknown one would slip past a rule blocking it.
    throw new Error(`"${input.category}" is not a known category (${PRODUCT_CATEGORIES.join(", ")}).`);
  }
  const price = wholeNumber(input.pricePaise, 1, "Price");
  const cost = input.costPaise === null ? null : wholeNumber(input.costPaise, 0, "Cost");
  return {
    sku,
    name,
    description: input.description.trim() || name,
    category: input.category,
    price_paise: price,
    cost_price_paise: cost,
    stock_qty: wholeNumber(input.stockQty, 0, "Stock"),
    reorder_point: wholeNumber(input.reorderPoint, 0, "Reorder point"),
    lead_time_days: wholeNumber(input.leadTimeDays, 0, "Lead time"),
  };
}

export async function saveProduct(id: string | null, input: ProductInput): Promise<void> {
  const { merchant, db } = await scope();
  const row = validate(input);

  const { data: clash } = await db.from("products").select("id, name").eq("merchant_id", merchant.id).eq("sku", row.sku).maybeSingle();
  if (clash && clash.id !== id) throw new Error(`SKU "${row.sku}" is already used by "${clash.name}".`);

  if (id) {
    // Changing the price by hand ends any clearance, so "was" is not left pointing at a stale original.
    const { error } = await db.from("products").update({ ...row, compare_at_price_paise: null }).eq("id", id).eq("merchant_id", merchant.id);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await db.from("products").insert({ merchant_id: merchant.id, ...row, active: true });
    if (error) throw new Error(error.message);
  }
  revalidatePath("/dashboard");
}

export async function setProductActive(id: string, active: boolean): Promise<void> {
  const { merchant, db } = await scope();
  const { error } = await db.from("products").update({ active }).eq("id", id).eq("merchant_id", merchant.id);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

/** Deleting is only allowed for a product with no history; retiring does what is usually meant. */
export async function deleteProduct(id: string): Promise<void> {
  const { merchant, db } = await scope();
  const [{ count: sold }, { count: ordered }] = await Promise.all([
    db.from("sales").select("id", { count: "exact", head: true }).eq("merchant_id", merchant.id).eq("product_id", id),
    db.from("po_lines").select("id", { count: "exact", head: true }).eq("merchant_id", merchant.id).eq("product_id", id),
  ]);
  if ((sold ?? 0) > 0 || (ordered ?? 0) > 0) throw new Error("This product has sales or orders on record, so it can only be retired, not deleted.");
  const { error } = await db.from("products").delete().eq("id", id).eq("merchant_id", merchant.id);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

/** Sets stock to a counted number, for a stock-take. */
export async function setStock(id: string, qty: number): Promise<void> {
  const { merchant, db } = await scope();
  const n = wholeNumber(qty, 0, "Stock");
  const { error } = await db.from("products").update({ stock_qty: n }).eq("id", id).eq("merchant_id", merchant.id);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

/** Rows from a pasted CSV: sku,name,category,price,cost,stock,reorder,lead_days. Prices in rupees. */
export async function importProductsCsv(csv: string): Promise<{ created: number; updated: number; errors: string[] }> {
  const { merchant, db } = await scope();
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error("Paste at least one row.");
  const start = /^sku\b/i.test(lines[0]) ? 1 : 0;
  let created = 0;
  let updated = 0;
  const errors: string[] = [];

  for (const [i, line] of lines.slice(start).entries()) {
    const c = line.split(",").map((x) => x.trim());
    const n = (v: string | undefined) => (v === undefined || v === "" ? null : Math.round(parseFloat(v) * 100));
    try {
      const sku = (c[0] ?? "").toLowerCase();
      const row = validate({
        sku,
        name: c[1] ?? "",
        description: "",
        category: (c[2] ?? "").toLowerCase(),
        pricePaise: n(c[3]) ?? 0,
        costPaise: n(c[4]),
        stockQty: parseInt(c[5] ?? "0", 10) || 0,
        reorderPoint: parseInt(c[6] ?? "0", 10) || 0,
        leadTimeDays: parseInt(c[7] ?? "7", 10) || 0,
      });
      const { data: existing } = await db.from("products").select("id").eq("merchant_id", merchant.id).eq("sku", row.sku).maybeSingle();
      if (existing) {
        const { error } = await db.from("products").update(row).eq("id", existing.id).eq("merchant_id", merchant.id);
        if (error) throw new Error(error.message);
        updated++;
      } else {
        const { error } = await db.from("products").insert({ merchant_id: merchant.id, ...row, active: true });
        if (error) throw new Error(error.message);
        created++;
      }
    } catch (err) {
      errors.push(`Row ${i + 1 + start}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  revalidatePath("/dashboard");
  return { created, updated, errors };
}
