// Shared client-safe formatting helpers — used by both the dashboard panels
// and the 3D graph's hover tooltips, so a merchant sees the same "₹6,000" /
// "New purchase order" phrasing everywhere, not raw paise or action-type slugs
// in one place and friendly text in another.

const ACTION_TYPE_LABELS: Record<string, string> = {
  "order.create": "New purchase order",
  "refund.create": "Refund",
  "subscription.create": "New subscription",
  // `payout.create` is no longer an accepted action type (RazorpayX needs a
  // registered business Razorpay gates, so it could never execute here — see
  // src/lib/razorpay/actions.ts). Its label stays because traces recorded
  // before it was removed are still in the database and still render in the
  // Transactions table; dropping it would show them a raw slug instead.
  "payout.create": "Vendor payout",
};

export function actionTypeLabel(actionType: string): string {
  // Traces logged at the protocol layer (src/app/api/mcp/route.ts) use a
  // `protocol.<attempted method>` action type deliberately — it's namespaced
  // so it can never collide with a real money action type. The exact
  // attempted method name isn't meaningful to a merchant reading this; what
  // matters is that a signature failed to verify.
  if (actionType.startsWith("protocol.")) return "Blocked forged/tampered request";
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
