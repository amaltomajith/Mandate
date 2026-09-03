import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A real product catalog, stored in Supabase (`products` table,
 * migration 0002) — a merchant could edit this without a code deploy. Small
 * on purpose: it's read in full and handed to the LLM as context for
 * cross-sell reasoning (src/lib/demo/crossSell.ts) rather than searched via
 * vector/embedding retrieval. That's a right-sized choice, not a shortcut —
 * a full-catalog prompt is exact and cheap at a handful of SKUs; it stops
 * being the right choice once a real catalog runs into the thousands, at
 * which point retrieval (embeddings + a vector index) is the correct next
 * step, not a "nice to have." See HANDOVER.md for the fuller reasoning.
 */
/**
 * The categories a product may carry.
 *
 * A closed vocabulary, and not for tidiness. `category_block` rules match the
 * category string EXACTLY -- a product typed as "electronic" instead of
 * "electronics" would silently walk straight past a rule blocking
 * "electronics", and nothing would report an error because both are valid
 * strings. The same exactness is what lets the model reason about complements
 * by category. Free text here would make both of those quietly unreliable.
 *
 * `gambling` and `crypto` are in the list deliberately: the seeded policy
 * blocks them, and a merchant needs to be able to create a product in a
 * blocked category to see the block actually fire.
 */
export const PRODUCT_CATEGORIES = [
  "electronics",
  "office",
  "fitness",
  "furniture",
  "apparel",
  "gambling",
  "crypto",
] as const;

export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

export interface CatalogItem {
  sku: string;
  name: string;
  description: string;
  priceInPaise: number;
  category: string;
}

// Seed data only — the live catalog always comes from `fetchCatalog`, reading
// the `products` table, so an edit here only affects a *fresh* database.
export const SEED_PRODUCTS: CatalogItem[] = [
  {
    sku: "mouse-01",
    name: "Wireless Mouse",
    description: "A compact 2.4GHz wireless mouse for everyday desk use.",
    priceInPaise: 89900,
    category: "electronics",
  },
  {
    sku: "keyboard-01",
    name: "Mechanical Keyboard",
    description: "A tactile mechanical keyboard with per-key backlighting, built for long typing sessions.",
    priceInPaise: 449900,
    category: "electronics",
  },
  {
    sku: "stand-01",
    name: "Laptop Stand",
    description: "An aluminum laptop stand that raises screen height for better posture.",
    priceInPaise: 219900,
    category: "office",
  },
  {
    sku: "hub-01",
    name: "USB-C Hub",
    description: "A 6-port USB-C hub adding HDMI, USB-A, and SD card slots to a single laptop port.",
    priceInPaise: 129900,
    category: "electronics",
  },
  {
    sku: "desk-01",
    name: "Premium Standing Desk",
    description: "A motorized sit-stand desk with programmable height presets.",
    priceInPaise: 699900,
    category: "office",
  },
  {
    sku: "yogamat-01",
    name: "Yoga Mat",
    description: "A non-slip yoga mat for home workouts.",
    priceInPaise: 119900,
    category: "fitness",
  },
];

export async function applySeedProducts(
  db: SupabaseClient,
  merchantId: string
): Promise<{ created: number }> {
  let created = 0;
  for (const p of SEED_PRODUCTS) {
    const { data: existing } = await db.from("products").select("id").eq("merchant_id", merchantId).eq("sku", p.sku).maybeSingle();
    if (existing) continue;
    const { error } = await db
      .from("products")
      .insert({ merchant_id: merchantId, sku: p.sku, name: p.name, description: p.description, price_paise: p.priceInPaise, category: p.category });
    if (error) throw error;
    created++;
  }
  return { created };
}

/**
 * The LIVE catalog: what an agent can actually buy right now.
 *
 * Active-only, and this is the single place that decides it. Three of the four
 * readers -- the headroom probe, counter-offer candidates and campaign planning
 * -- go through here, so a retired product leaves all three at once. The fourth,
 * the public /catalog route, runs its own query and filters the same way; that
 * duplication is called out in both files because two places deciding what "for
 * sale" means is exactly how a deactivated SKU stays offerable.
 */
export async function fetchCatalog(db: SupabaseClient, merchantId: string): Promise<CatalogItem[]> {
  const { data, error } = await db
    .from("products")
    .select("sku, name, description, price_paise, category")
    .eq("merchant_id", merchantId)
    .eq("active", true)
    .order("name");
  if (error) throw error;
  return (data ?? []).map((p) => ({
    sku: p.sku,
    name: p.name,
    description: p.description,
    priceInPaise: p.price_paise,
    category: p.category,
  }));
}

export function findItem(catalog: CatalogItem[], sku: string): CatalogItem {
  const item = catalog.find((i) => i.sku === sku);
  if (!item) throw new Error(`Unknown catalog sku: ${sku}`);
  return item;
}
