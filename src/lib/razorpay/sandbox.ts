import type { Json } from "@/types/db";

/**
 * Stand-ins for Razorpay's payment objects, for merchants who have not connected
 * an account. They look like the real thing closely enough for the rest of the
 * system to work end to end, and every one carries `simulated: true` and a URL
 * that is plainly not Razorpay's, so a sandbox sale can never be mistaken for a
 * real one. Nothing here talks to the network.
 */

const short = (traceId: string) => traceId.replaceAll("-", "").slice(0, 12);

export function sandboxLink(traceId: string, amount: number, currency: string, description: string): Json {
  const id = `sim_plink_${short(traceId)}`;
  return {
    id,
    short_url: `https://sandbox.mandate.invalid/pay/${short(traceId)}`,
    status: "created",
    amount,
    currency,
    description,
    simulated: true,
    note: "Sandbox payment link: no Razorpay account is connected, so nothing real was created.",
  };
}

export function sandboxOrder(traceId: string, amount: number, currency: string): Json {
  return { id: `sim_order_${short(traceId)}`, status: "created", amount, currency, simulated: true, note: "Sandbox order: no Razorpay account is connected." };
}

export function sandboxRefund(traceId: string, amount: number, currency: string): Json {
  return { id: `sim_rfnd_${short(traceId)}`, status: "processed", amount, currency, simulated: true, note: "Sandbox refund: no Razorpay account is connected." };
}
