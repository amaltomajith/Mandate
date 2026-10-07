import type { CooData } from "@/lib/cooData";
import type { Trace } from "@/types/db";
import { rupees } from "./kit";

/**
 * Says what an action is about, in the merchant's terms.
 *
 * A trace records ids and paise. A person deciding whether to approve a payout
 * needs "₹82,099 advance to Shenzhen Peripherals for 58 x Mechanical Keyboard".
 * Built from the merchant's own records, never from text an agent wrote, so what
 * the approval card says is what the database says.
 */
export function makeDescriber(coo: CooData) {
  const payees = new Map(coo.payees.map((p) => [p.id, p]));
  const pos = new Map(coo.purchaseOrders.map((p) => [p.id, p]));
  const bySku = new Map(coo.insights.map((i) => [i.sku, i]));
  const byProduct = new Map(coo.insights.map((i) => [i.productId, i]));

  return (trace: Trace): { title: string; detail?: string } | null => {
    const p = trace.params as Record<string, unknown> | null;
    if (!p) return null;
    const amount = typeof p.amount === "number" ? p.amount : 0;

    switch (trace.action_type) {
      case "payout.create": {
        const payee = payees.get(String(p.payeeId));
        const po = p.poId ? pos.get(String(p.poId)) : undefined;
        const lines = po ? coo.poLines.filter((l) => l.po_id === po.id) : [];
        const what = lines.map((l) => `${l.qty} x ${byProduct.get(l.product_id)?.name ?? "item"}`).join(", ");
        return {
          title: `${rupees(amount)} ${String(p.purpose ?? "payment").replace("_", " ")} to ${payee?.display_name ?? "an unrecognised payee"}`,
          detail: [what && `For ${what}`, po && `Order total ${rupees(Number(po.total_paise))}`, payee && `Account ${payee.masked_identifier}`].filter(Boolean).join(" · "),
        };
      }
      case "payment_link.create": {
        const items = Array.isArray(p.lineItems) ? (p.lineItems as { sku: string; qty: number }[]) : [];
        const what = items.map((i) => `${i.qty} x ${bySku.get(i.sku)?.name ?? i.sku}`).join(", ");
        return { title: `Payment link for ${what || String(p.description ?? "a sale")}`, detail: p.customerName ? `For ${String(p.customerName)}` : undefined };
      }
      case "price.change": {
        const item = bySku.get(String(p.sku));
        return {
          title: `Change ${item?.name ?? String(p.sku)} to ${rupees(amount)}`,
          detail: item ? `Currently ${rupees(item.pricePaise)}${typeof p.reason === "string" ? ` · ${p.reason}` : ""}` : undefined,
        };
      }
      default:
        return null;
    }
  };
}
