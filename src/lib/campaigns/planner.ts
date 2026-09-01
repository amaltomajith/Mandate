import { z } from "zod";
import { getLLM } from "@/lib/llm/client";
import { SegmentDefinition } from "./segment";
import type { CatalogItem } from "@/lib/demo/catalog";

/**
 * A merchant's sentence, turned into a campaign a machine can run.
 *
 * Same shape as `draft_policy` and for the same reason: the model produces a
 * structured plan, a human approves the plan, and everything after that is
 * deterministic. Nothing here sends anything or spends anything — it only
 * proposes. The orchestrator is what acts, and only on a plan someone said yes
 * to.
 *
 * Classified `internal`. The prompt carries the catalog, which is public, but
 * also the merchant's commercial intent — what they are willing to discount and
 * by how much — which is not. That is competitive information and it stays on
 * the machine.
 */

const OFFER_MAX_DISCOUNT_PCT = 40;

export const CampaignPlan = z.object({
  name: z.string().min(1).max(80),
  /** The SKU being promoted. Grounded against the real catalog below; a plan
   *  naming a product that doesn't exist is rejected rather than repaired,
   *  because the repair would be a guess about what the merchant meant. */
  sku: z.string(),
  discountPct: z.number().int().min(1).max(OFFER_MAX_DISCOUNT_PCT),
  segment: SegmentDefinition,
  /** One sentence the merchant reads before approving. */
  rationale: z.string(),
});
export type CampaignPlan = z.infer<typeof CampaignPlan>;

export interface PlannedCampaign extends CampaignPlan {
  item: CatalogItem;
  /** Per-customer figures, computed from the catalog price and the discount —
   *  never taken from the model. A model that can state the price is a model
   *  that can state it wrong. */
  unitPricePaise: number;
  unitDiscountPaise: number;
  unitChargePaise: number;
}

const SYSTEM_PROMPT = `You plan one marketing campaign for a merchant, from their goal and their product catalog.

A campaign has three parts: which product to promote, what discount to offer, and which past customers to offer it to.

Choose the segment by what the merchant is trying to achieve:
- Winning back lapsed customers: set inactiveForDays.
- Selling a companion product: set boughtSku to the product they already own and notBoughtSku to the one being promoted, so nobody is offered something they already bought.
- Rewarding or upselling the best customers: set minSpendPaise.
Leave any field null when it does not apply. Do not set every field.

Discount is a whole percentage between 1 and ${OFFER_MAX_DISCOUNT_PCT}. Propose the smallest discount that would plausibly work — it is the merchant's money, and a bigger number is not a better plan.

Respond with ONLY a JSON object shaped like:
{"name": string, "sku": string, "discountPct": number, "segment": {"boughtSku": string|null, "notBoughtSku": string|null, "inactiveForDays": number|null, "minSpendPaise": number|null}, "rationale": string}

Every sku you use, in "sku" and inside "segment", must appear in the provided catalog. Never invent one. minSpendPaise is in paise: 5000 rupees is 500000.`;

/**
 * Returns null rather than throwing on any failure — no model, malformed
 * output, or a SKU that isn't real. A campaign that couldn't be planned is a
 * campaign that doesn't run, which is the safe outcome; the merchant sees that
 * nothing was proposed rather than a half-formed plan they might approve.
 */
export async function planCampaign(goal: string, catalog: CatalogItem[]): Promise<PlannedCampaign | null> {
  if (catalog.length === 0) return null;

  let raw: string;
  try {
    // The catalog is public, but what the merchant is willing to discount is
    // commercial intent and stays on the machine.
    const llm = await getLLM("internal");
    const response = await llm.client.chat.completions.create({
      model: llm.model,
      response_format: { type: "json_object" },
      temperature: 0.3,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify({
            goal,
            catalog: catalog.map((c) => ({
              sku: c.sku,
              name: c.name,
              description: c.description,
              category: c.category,
              priceInPaise: c.priceInPaise,
            })),
          }),
        },
      ],
    });
    raw = response.choices[0]?.message?.content ?? "{}";
  } catch (err) {
    console.error("[campaigns] planning call failed:", err);
    return null;
  }

  let plan: CampaignPlan;
  try {
    plan = CampaignPlan.parse(JSON.parse(raw));
  } catch (err) {
    console.error("[campaigns] model did not return a valid plan shape:", err);
    return null;
  }

  // Grounding, same contract as cross-sell: every SKU the plan mentions has to
  // be a real one. A segment referring to a product that doesn't exist would
  // silently match nobody, which is the worst kind of wrong — it looks like a
  // campaign that simply found no audience.
  const item = catalog.find((c) => c.sku === plan.sku);
  if (!item) {
    console.error(`[campaigns] plan named unknown sku "${plan.sku}", discarding.`);
    return null;
  }
  for (const sku of [plan.segment.boughtSku, plan.segment.notBoughtSku]) {
    if (sku && !catalog.some((c) => c.sku === sku)) {
      console.error(`[campaigns] segment named unknown sku "${sku}", discarding.`);
      return null;
    }
  }

  const unitDiscountPaise = Math.round((item.priceInPaise * plan.discountPct) / 100);
  return {
    ...plan,
    item,
    unitPricePaise: item.priceInPaise,
    unitDiscountPaise,
    unitChargePaise: item.priceInPaise - unitDiscountPaise,
  };
}
