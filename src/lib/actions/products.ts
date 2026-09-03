"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireDashboardUser } from "./authGuard";
import { getCurrentMerchant } from "@/lib/merchant";
import { PRODUCT_CATEGORIES, type ProductCategory } from "@/lib/demo/catalog";

/**
 * The merchant's side of managing what it sells.
 *
 * Every mutation matches on merchant as well as id. A row id is not
 * authorization — §17 of the handover records treating one as such as a real
 * bug — and the cost of the extra predicate is nothing, so the worst case for a
 * forged id is an update that matches no rows rather than a write into someone
 * else's catalog.
 *
 * No function here accepts a merchant id from the caller. The tenant always
 * comes from the Clerk session, because a merchant id in a client payload is a
 * merchant id a client can change.
 */

async function merchantScope() {
  await requireDashboardUser();
  return { merchant: await getCurrentMerchant(), db: createAdminClient() };
}

export interface ProductRow {
  id: string;
  sku: string;
  name: string;
  description: string;
  pricePaise: number;
  category: string;
  active: boolean;
  createdAt: string;
  /** Derived from traces, never stored. Every other panel derives its totals
   *  and a stored counter is a second source of truth that drifts the moment a
   *  write fails after the sale happened. */
  unitsSold: number;
  revenuePaise: number;
  /** True when nothing in the audit trail references this SKU, so deleting it
   *  outright would destroy no history. */
  deletable: boolean;
}

/**
 * The full catalog including retired products.
 *
 * Deliberately NOT `fetchCatalog`, which is active-only because it answers a
 * different question — "what can an agent buy right now". A merchant managing
 * its catalog has to be able to see the thing it just retired, or the retire
 * button looks like a delete button.
 */
export async function listProducts(): Promise<ProductRow[]> {
  const { merchant, db } = await merchantScope();

  const [{ data: products, error }, { data: traces }] = await Promise.all([
    db
      .from("products")
      .select("id, sku, name, description, price_paise, category, active, created_at")
      .eq("merchant_id", merchant.id)
      .order("name"),
    // One pass over the merchant's settled actions, bucketed by SKU here rather
    // than one count query per product.
    db
      .from("traces")
      .select("params, decision")
      .eq("merchant_id", merchant.id)
      .eq("mode", "enforce"),
  ]);
  if (error) throw new Error(error.message);

  const sold = new Map<string, { units: number; revenue: number }>();
  const everSeen = new Set<string>();
  for (const t of traces ?? []) {
    const p = t.params as { amount?: number; notes?: { sku?: string } } | null;
    const sku = p?.notes?.sku;
    if (!sku) continue;
    // Seen at all — including blocked and escalated. What makes a product
    // undeletable is appearing in the audit trail, not having sold.
    everSeen.add(sku);
    if (t.decision !== "allow") continue;
    const acc = sold.get(sku) ?? { units: 0, revenue: 0 };
    acc.units += 1;
    acc.revenue += typeof p?.amount === "number" ? p.amount : 0;
    sold.set(sku, acc);
  }

  return (products ?? []).map((p) => {
    const s = sold.get(p.sku) ?? { units: 0, revenue: 0 };
    return {
      id: p.id,
      sku: p.sku,
      name: p.name,
      description: p.description,
      pricePaise: p.price_paise,
      category: p.category,
      active: p.active,
      createdAt: p.created_at,
      unitsSold: s.units,
      revenuePaise: s.revenue,
      deletable: !everSeen.has(p.sku),
    };
  });
}

export interface ProductInput {
  sku: string;
  name: string;
  description: string;
  pricePaise: number;
  category: string;
}

/**
 * Shape-checked before the database sees it, so a bad value produces a sentence
 * rather than a constraint violation.
 *
 * The category check is the one that matters most and looks the most like
 * fussiness. `category_block` rules match the string EXACTLY, so a product
 * typed "electronic" would walk straight past a rule blocking "electronics" —
 * and nothing anywhere would report an error, because both are valid strings.
 * A closed vocabulary is what makes that class of silent bypass impossible.
 */
function validate(input: ProductInput): {
  sku: string;
  name: string;
  description: string;
  price_paise: number;
  category: ProductCategory;
} {
  const sku = input.sku.trim().toLowerCase();
  const name = input.name.trim();
  const description = input.description.trim();

  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(sku)) {
    throw new Error(
      "A SKU is lowercase letters, digits and dashes, 2–41 characters — it is the identifier agents ground against, so it has to be stable and unambiguous."
    );
  }
  if (name.length < 2) throw new Error("Give the product a name.");
  if (description.length < 10) {
    throw new Error(
      "Write a real description. An agent has nothing but this text to reason from — a product without one is much weaker for a buyer than it is for a human, who can at least infer from the name."
    );
  }
  if (!Number.isFinite(input.pricePaise) || !Number.isInteger(input.pricePaise) || input.pricePaise <= 0) {
    throw new Error("Price must be a whole number of paise, greater than zero.");
  }
  if (!(PRODUCT_CATEGORIES as readonly string[]).includes(input.category)) {
    throw new Error(
      `"${input.category}" is not one of the known categories (${PRODUCT_CATEGORIES.join(", ")}). ` +
        "Policy rules match categories exactly, so an unknown one would silently escape any rule blocking it."
    );
  }
  return { sku, name, description, price_paise: input.pricePaise, category: input.category as ProductCategory };
}

export async function createProduct(input: ProductInput): Promise<ProductRow["id"]> {
  const { merchant, db } = await merchantScope();
  const row = validate(input);

  // Checked here as well as by the unique index, so the merchant gets a
  // sentence naming the clash instead of a Postgres error code.
  const { data: clash } = await db
    .from("products")
    .select("id, name, active")
    .eq("merchant_id", merchant.id)
    .eq("sku", row.sku)
    .maybeSingle();
  if (clash) {
    throw new Error(
      `SKU "${row.sku}" is already used by "${clash.name}"${clash.active ? "" : " (retired)"}. ` +
        "SKUs have to be unique — an agent grounds against them, and two products sharing one makes every reference ambiguous."
    );
  }

  const { data, error } = await db
    .from("products")
    .insert({ merchant_id: merchant.id, ...row, active: true })
    .select("id")
    .single();
  if (error) throw new Error(error.message);

  revalidatePath("/dashboard");
  return data.id;
}

export async function updateProduct(id: string, input: ProductInput): Promise<void> {
  const { merchant, db } = await merchantScope();
  const row = validate(input);

  const { data: clash } = await db
    .from("products")
    .select("id, name")
    .eq("merchant_id", merchant.id)
    .eq("sku", row.sku)
    .neq("id", id)
    .maybeSingle();
  if (clash) throw new Error(`SKU "${row.sku}" is already used by "${clash.name}".`);

  const { error } = await db
    .from("products")
    .update(row)
    .eq("id", id)
    .eq("merchant_id", merchant.id);
  if (error) throw new Error(error.message);

  revalidatePath("/dashboard");
}

/**
 * Retire or restore a product.
 *
 * Retiring removes it from the public catalog, from counter-offer candidates
 * and from campaign planning — every reader that asks "what is for sale" —
 * while leaving the row in place so past traces still resolve to a name.
 */
export async function setProductActive(id: string, active: boolean): Promise<void> {
  const { merchant, db } = await merchantScope();
  const { error } = await db
    .from("products")
    .update({ active })
    .eq("id", id)
    .eq("merchant_id", merchant.id);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

/**
 * Hard delete, allowed only when nothing references this SKU.
 *
 * The audit trail is the product here. Traces record a SKU in
 * `params.notes.sku` and nothing enforces that as a foreign key, so deleting a
 * product that has sold would not fail — it would quietly leave traces pointing
 * at a name that no longer resolves. Refusing is the only honest answer;
 * retiring does what the merchant actually wanted anyway.
 */
export async function deleteProduct(id: string): Promise<void> {
  const { merchant, db } = await merchantScope();

  const { data: product } = await db
    .from("products")
    .select("sku, name")
    .eq("id", id)
    .eq("merchant_id", merchant.id)
    .maybeSingle();
  if (!product) throw new Error("Product not found.");

  const { data: traces, error: traceError } = await db
    .from("traces")
    .select("params")
    .eq("merchant_id", merchant.id)
    .eq("mode", "enforce");
  if (traceError) throw new Error(traceError.message);

  const referenced = (traces ?? []).some(
    (t) => (t.params as { notes?: { sku?: string } } | null)?.notes?.sku === product.sku
  );
  if (referenced) {
    throw new Error(
      `"${product.name}" appears in the audit trail, so deleting it would leave those traces pointing at a product that no longer exists. Retire it instead — it stops being sold, and the history still reads correctly.`
    );
  }

  const { error } = await db.from("products").delete().eq("id", id).eq("merchant_id", merchant.id);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

export interface CatalogHealthIssue {
  sku: string;
  name: string;
  problem: string;
  why: string;
}

/**
 * What an AI buyer needs from a catalog, checked deterministically.
 *
 * No model involved, same as the policy health checker. Every check below is a
 * fact about the row, and the "why" is the part worth reading: a human browsing
 * a shop fills gaps from context, a photo, a shelf label. An agent has the JSON
 * and nothing else, so a missing description is not untidy — it is a product
 * the agent cannot reason about and will pass over.
 */
export async function catalogHealth(): Promise<CatalogHealthIssue[]> {
  const products = await listProducts();
  const issues: CatalogHealthIssue[] = [];

  for (const p of products.filter((x) => x.active)) {
    if (p.description.trim().length < 20) {
      issues.push({
        sku: p.sku,
        name: p.name,
        problem: "Description is thin or missing",
        why: "An agent reasons only from this text. With nothing to go on it will pass the product over rather than guess.",
      });
    }
    if (!(PRODUCT_CATEGORIES as readonly string[]).includes(p.category)) {
      issues.push({
        sku: p.sku,
        name: p.name,
        problem: `Category "${p.category}" is not a known one`,
        why: "Policy rules match categories exactly, so this product escapes any rule written against a category it should belong to.",
      });
    }
    if (p.pricePaise <= 0) {
      issues.push({
        sku: p.sku,
        name: p.name,
        problem: "Price is zero or negative",
        why: "An agent re-checks price during a purchase. A non-price is not a discount, it is an item it cannot transact.",
      });
    }
  }

  // A catalog with one item cannot demonstrate a complement, and the
  // counter-offer path silently returns null rather than erroring.
  const activeCount = products.filter((p) => p.active).length;
  if (activeCount < 2) {
    issues.push({
      sku: "—",
      name: "The catalog as a whole",
      problem: activeCount === 0 ? "Nothing is for sale" : "Only one product is active",
      why: "Counter-offers need at least two active products to have anything to pair. Below that the merchant simply never counter-offers.",
    });
  }

  return issues;
}
