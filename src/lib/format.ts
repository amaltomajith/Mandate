// Shared client-safe formatting helpers — used by both the dashboard panels
// and the 3D graph's hover tooltips, so a merchant sees the same "₹6,000" /
// "New purchase order" phrasing everywhere, not raw paise or action-type slugs
// in one place and friendly text in another.

const ACTION_TYPE_LABELS: Record<string, string> = {
  "order.create": "New purchase order",
  "payout.create": "Vendor payout",
  "refund.create": "Refund",
  "subscription.create": "New subscription",
};

export function actionTypeLabel(actionType: string): string {
  return ACTION_TYPE_LABELS[actionType] ?? actionType;
}

/** Mirrors the formatting in src/lib/policy/engine.ts's server-side
 *  `formatMoney` (which builds reasoning strings) — this one runs client-side
 *  on raw amount/currency pairs pulled off a trace's params. */
export function formatMoney(amountPaise: number, currency: string): string {
  const amount = amountPaise / 100;
  const formatted = amount.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  return currency === "INR" ? `₹${formatted}` : `${formatted} ${currency}`;
}
