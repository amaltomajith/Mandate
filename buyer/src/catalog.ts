import { config } from "./config.js";

/**
 * What the merchant sells, fetched over HTTP.
 *
 * Not imported. This agent has no access to the merchant's product table, and
 * the catalog endpoint is public precisely so a buyer can discover a merchant
 * before it holds any credentials — discovery has to come before the signature,
 * or an agent could never become a customer in the first place.
 */

export interface CatalogItem {
  sku: string;
  name: string;
  description: string;
  category: string;
  pricePaise: number;
}

export interface Storefront {
  merchantName: string;
  currency: string;
  mcpEndpoint: string;
  keyDirectory: string;
  items: CatalogItem[];
}

interface CatalogResponse {
  merchant?: { name?: string; currency?: string };
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
  const res = await fetch(config.catalogUrl, { headers: { accept: "application/json" } });
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
    merchantName: body.merchant?.name ?? "unknown merchant",
    currency: body.merchant?.currency ?? "INR",
    mcpEndpoint: body.transact?.endpoint ?? config.mcpUrl,
    keyDirectory: body.transact?.auth?.keyDirectory ?? "",
    items,
  };
}
