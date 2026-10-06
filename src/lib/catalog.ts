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
 * Active-only, and this is the single place that decides it. ALL FOUR readers
 * now go through here -- the headroom probe, counter-offer candidates, campaign
 * planning and the public /catalog route. The route used to run its own query,
 * and pass one flagged that duplication as the real risk; adding per-agent
 * scope on top of it would have meant two copies of the scope filter as well,
 * so the duplication was removed rather than doubled. The route only ever
 * differed in sort order and response shape, both of which it can do itself.
 */
export async function fetchCatalog(
  db: SupabaseClient,
  merchantId: string,
  /**
   * The acting agent's catalog scope, when there is one.
   *
   * `undefined` and `null` both mean the full active catalog — no agent, or an
   * agent that is explicitly unscoped. An array restricts to those categories,
   * and an EMPTY array correctly yields nothing, because that is what an empty
   * scope means.
   *
   * Filtering here is a convenience for the READER, never the enforcement. An
   * agent that names an out-of-scope SKU directly still has to be refused by
   * the engine, and is — see the catalog_scope rule. A listing that hides
   * something is not a rule that forbids it, and building on the assumption
   * that it is would leave the boundary enforced only for agents polite enough
   * to look at the menu first.
   */
  agentCatalogScope?: string[] | null
): Promise<CatalogItem[]> {
  let query = db
    .from("products")
    .select("sku, name, description, price_paise, category")
    .eq("merchant_id", merchantId)
    .eq("active", true);
  if (Array.isArray(agentCatalogScope)) {
    // `.in` with an empty list matches nothing, which is exactly right for an
    // empty scope and worth stating so nobody "fixes" it later.
    query = query.in("category", agentCatalogScope);
  }
  const { data, error } = await query.order("name");
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
