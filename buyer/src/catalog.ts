import { config } from "./config.js";
import { signGet } from "./signGet.js";

/**
 * What the merchant sells, fetched over HTTP.
 *
 * Not imported. This agent has no access to the merchant's product table, and
 * the catalog endpoint is public precisely so a buyer can discover a merchant
 * before it holds any credentials — discovery has to come before the signature,
 * or an agent could never become a customer in the first place.
 *
 * SIGNED anyway, once this agent has an identity. The merchant answers a signed
 * request with this agent's SCOPED view — what it may actually transact — and
 * the unsigned answer is the whole public catalog. Asking unsigned would work
 * and would be worse: the agent would spend round trips proposing purchases the
 * merchant has already decided it may not make, and would learn that one
 * refusal at a time.
 *
 * The signature is dropped if it cannot be produced, because discovery still
 * has to work for an agent that has not been registered yet.
 */

export interface CatalogItem {
  sku: string;
  name: string;
  description: string;
  category: string;
  pricePaise: number;
}

export interface Storefront {
  /** What the merchant says this agent may transact, when it says anything.
   *  Null or absent means the full catalog. */
  scopeNote?: string;
  merchantName: string;
  currency: string;
  mcpEndpoint: string;
  keyDirectory: string;
  items: CatalogItem[];
}

interface CatalogResponse {
  merchant?: { name?: string; currency?: string };
  scope?: { categories?: string[] | null; note?: string };
  transact?: { endpoint?: string; auth?: { keyDirectory?: string } };
  catalog?: {
    sku: string;
    name: string;
    description: string;
    category: string;
    price?: { amount?: number; currency?: string; unit?: string };
    pricePaise?: number;
  }[];
}

export async function fetchStorefront(): Promise<Storefront> {
  const url = new URL(config.catalogUrl);
  let headers: Record<string, string> = { accept: "application/json" };
  try {
    headers = { ...headers, ...signGet(url) };
  } catch {
    // No usable key yet. Fall back to the public catalog rather than failing --
    // an agent has to be able to look at a merchant before it is registered.
  }
  // No cache hint needed on this side: Node's fetch does not cache, and the
  // merchant marks a scoped answer `private, no-store` so nothing between us
  // holds one agent's view and serves it to another.
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`The merchant's catalog is unavailable (HTTP ${res.status} from ${config.catalogUrl}).`);
  }
  const body = (await res.json()) as CatalogResponse;

  // The price field's exact name is the merchant's to choose, so read it
  // tolerantly rather than assuming one shape. An item whose price cannot be
  // read is dropped: a buyer that guesses at a price is a buyer that overspends.
  const items: CatalogItem[] = [];
  for (const raw of body.catalog ?? []) {
    // The merchant states its unit rather than leaving it implied, so honour
    // that instead of assuming paise. Reading an amount in rupees as paise
    // would make everything look a hundred times cheaper, and the agent would
    // cheerfully blow its budget while believing it was being careful.
    const amount = raw.price?.amount ?? raw.pricePaise;
    if (typeof amount !== "number") continue;
    const unit = raw.price?.unit ?? "paise";
    const paise = unit === "paise" ? amount : Math.round(amount * 100);
    items.push({
      sku: raw.sku,
      name: raw.name,
      description: raw.description,
      category: raw.category,
      pricePaise: paise,
    });
  }

  return {
    scopeNote: body.scope?.note,
    merchantName: body.merchant?.name ?? "unknown merchant",
    currency: body.merchant?.currency ?? "INR",
    mcpEndpoint: body.transact?.endpoint ?? config.mcpUrl,
    keyDirectory: body.transact?.auth?.keyDirectory ?? "",
    items,
  };
}
