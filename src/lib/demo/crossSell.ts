import { z } from "zod";
import { getLLM } from "../llm/client";
import type { CatalogItem } from "./catalog";

/**
 * Replaces what used to be a hardcoded { sku -> sku } pairing map. The LLM
 * reasons over the actual catalog (descriptions + categories) to propose a
 * complementary cross-sell — genuinely dynamic: add a product to the
 * `products` table and the reasoning changes with it, no code edit needed.
 *
 * Grounded, not trusted blindly: the model's chosen SKU is checked against
 * the real catalog before it's used for anything. If it names a SKU that
 * doesn't exist, or the call fails outright, this returns `null` — a failed
 * upsell suggestion is never a reason to fail the purchase it's attached to.
 */

const CrossSellSuggestion = z.object({
  sku: z.string().nullable(),
  pitch: z.string(),
});

export interface CrossSellResult {
  item: CatalogItem;
  pitch: string;
}

const SYSTEM_PROMPT = `You are a merchant's cross-sell assistant. Given a product catalog (JSON array of {sku, name, description, category}) and the sku of an item a customer just bought, pick the ONE remaining catalog item that most naturally complements it — something a real customer buying the first item would plausibly also want on the same order. If nothing in the catalog is a good complement, respond with "sku": null. Respond with ONLY a JSON object shaped like {"sku": string | null, "pitch": string} — pitch is one persuasive sentence a shopper would find convincing, or "" if sku is null. Never invent a sku that isn't in the provided catalog.`;

export async function suggestCrossSell(catalog: CatalogItem[], justBoughtSku: string): Promise<CrossSellResult | null> {
  const candidates = catalog.filter((i) => i.sku !== justBoughtSku);
  if (candidates.length === 0) return null;

  let raw: string;
  try {
    // catalog + a sku, both already served unauthenticated at /api/catalog
    const llm = await getLLM("public");
    const response = await llm.client.chat.completions.create({
      model: llm.model,
      response_format: { type: "json_object" },
      temperature: 0.3,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify({ catalog: candidates, justBoughtSku }) },
      ],
    });
    raw = response.choices[0]?.message?.content ?? "{}";
  } catch (err) {
    console.error("[crossSell] LLM call failed:", err);
    return null;
  }

  let parsed: z.infer<typeof CrossSellSuggestion>;
  try {
    parsed = CrossSellSuggestion.parse(JSON.parse(raw));
  } catch (err) {
    console.error("[crossSell] Model did not return a valid suggestion shape:", err);
    return null;
  }

  if (!parsed.sku) return null;

  const item = candidates.find((i) => i.sku === parsed.sku);
  if (!item) {
    console.error(`[crossSell] Model suggested an unknown sku "${parsed.sku}" — not in the catalog, ignoring.`);
    return null;
  }

  return { item, pitch: parsed.pitch || `pairs well with what you just bought` };
}
