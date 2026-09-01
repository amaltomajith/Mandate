import { z } from "zod";
import { getLLM } from "../llm/client";
import type { CatalogItem } from "./catalog";

/**
 * Turns what a person typed into a specific thing in the catalog.
 *
 * Grounded the same way the cross-sell agent is: the model chooses from the
 * real catalog and its answer is checked against it before anything is bought.
 * A model that invents a SKU, or names one that doesn't exist, produces
 * nothing rather than an order — the one failure mode that must never reach
 * `enforce_action` is a purchase for something the merchant doesn't sell.
 *
 * `maxAmountPaise` is captured separately because a shopper's budget is a
 * constraint on the *purchase*, not a property of the item. "A keyboard under
 * ₹3,000" should fail honestly when the only keyboard costs ₹4,499, rather
 * than quietly buying it anyway — a control plane that ignores the buyer's own
 * stated limit has no business enforcing the merchant's.
 */

const ShopperIntent = z.object({
  sku: z.string().nullable(),
  reason: z.string(),
  maxAmountPaise: z.number().nullable().optional(),
});

export interface ShopperChoice {
  item: CatalogItem;
  reason: string;
  /** The shopper's own stated ceiling, if they gave one. */
  maxAmountPaise: number | null;
}

export interface ShopperMiss {
  reason: string;
  maxAmountPaise: number | null;
}

const SYSTEM_PROMPT = `You are a shopping agent for a merchant. You are given a product catalog (JSON array of {sku, name, description, category, priceInPaise}) and a shopper's request in plain language. Pick the ONE catalog item that best matches what they asked for. If nothing in the catalog reasonably matches, respond with "sku": null.

If the shopper states a budget or price ceiling, convert it to paise (multiply rupees by 100) and return it as maxAmountPaise. If they state no budget, return null.

Respond with ONLY a JSON object shaped like {"sku": string | null, "reason": string, "maxAmountPaise": number | null}. "reason" is one short sentence explaining the choice to the shopper, or explaining why nothing matched. Never invent a sku that isn't in the provided catalog.`;

export async function interpretRequest(
  catalog: CatalogItem[],
  request: string
): Promise<ShopperChoice | ShopperMiss> {
  if (catalog.length === 0) return { reason: "This merchant has nothing listed yet.", maxAmountPaise: null };

  let raw: string;
  try {
    // the same public catalog plus the shopper's own sentence
    const llm = await getLLM("public");
    const response = await llm.client.chat.completions.create({
      model: llm.model,
      response_format: { type: "json_object" },
      temperature: 0.2,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify({ catalog, request }) },
      ],
    });
    raw = response.choices[0]?.message?.content ?? "{}";
  } catch (err) {
    console.error("[shopper] LLM call failed:", err);
    return { reason: "Couldn't reach the shopping agent just now — try again.", maxAmountPaise: null };
  }

  let parsed: z.infer<typeof ShopperIntent>;
  try {
    parsed = ShopperIntent.parse(JSON.parse(raw));
  } catch (err) {
    console.error("[shopper] Model did not return a valid intent shape:", err);
    return { reason: "Couldn't make sense of that request.", maxAmountPaise: null };
  }

  const maxAmountPaise = typeof parsed.maxAmountPaise === "number" ? parsed.maxAmountPaise : null;
  if (!parsed.sku) return { reason: parsed.reason || "Nothing in the catalog matches that.", maxAmountPaise };

  const item = catalog.find((c) => c.sku === parsed.sku);
  if (!item) {
    console.error(`[shopper] Model chose an unknown sku "${parsed.sku}" — not in the catalog, ignoring.`);
    return { reason: "The agent picked something that isn't in the catalog, so nothing was bought.", maxAmountPaise };
  }

  return { item, reason: parsed.reason, maxAmountPaise };
}

export function isChoice(result: ShopperChoice | ShopperMiss): result is ShopperChoice {
  return "item" in result;
}
