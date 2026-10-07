import "server-only";
import type { Json } from "@/types/db";
import { loadRazorpayXCredentials } from "./client";

/**
 * RazorpayX payouts: money leaving the business to a supplier.
 *
 * The SDK in use has no payouts resource, so this speaks to the REST API
 * directly. Two things matter more than the plumbing:
 *
 *  - The idempotency key is the wall's own trace id. If the same approved action
 *    is retried (a double click, a retry after a timeout) Razorpay returns the
 *    first payout instead of creating a second one.
 *  - There are two executors and they never blur. With RazorpayX credentials the
 *    payout is real. Without them, or for a payee marked simulated, the sandbox
 *    executor answers with `simulated: true` and moves nothing. A sandbox result
 *    is never shaped like a live one by accident: every consumer can see the flag.
 */

export interface PayoutRequest {
  traceId: string;
  merchantId: string;
  amountPaise: number;
  currency: string;
  purpose: string;
  narration: string;
  payee: {
    kind: "bank" | "upi";
    razorpayFundAccountId: string | null;
    simulated: boolean;
  };
}

export interface PayoutResult {
  id: string;
  status: "queued" | "processing" | "processed" | "failed" | "reversed";
  simulated: boolean;
  raw: Json;
}

const API = "https://api.razorpay.com/v1";

/** Razorpay's own purposes. Anything else is rejected by the API. */
const PURPOSE: Record<string, string> = {
  vendor_advance: "vendor bill",
  vendor_payment: "vendor bill",
  refund_to_vendor: "refund",
};

function mapStatus(s: string | undefined): PayoutResult["status"] {
  switch (s) {
    case "processed":
      return "processed";
    case "reversed":
      return "reversed";
    case "failed":
    case "rejected":
    case "cancelled":
      return "failed";
    case "queued":
    case "pending":
      return "queued";
    default:
      return "processing";
  }
}

export async function executePayout(req: PayoutRequest): Promise<PayoutResult> {
  const creds = await loadRazorpayXCredentials(req.merchantId);

  if (!creds || req.payee.simulated) {
    return {
      id: `sim_pout_${req.traceId.replaceAll("-", "").slice(0, 14)}`,
      status: "processed",
      simulated: true,
      raw: {
        simulated: true,
        note: req.payee.simulated
          ? "This payee is a sandbox payee, so no money moved."
          : "RazorpayX is not connected, so the sandbox executor answered. No money moved.",
        amount: req.amountPaise,
        currency: req.currency,
        purpose: req.purpose,
      },
    };
  }

  if (!req.payee.razorpayFundAccountId) {
    throw new Error("This payee has no Razorpay fund account yet, so it cannot be paid. Re-approve it from the dashboard.");
  }

  const res = await fetch(`${API}/payouts`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Basic ${Buffer.from(`${creds.key_id}:${creds.key_secret}`).toString("base64")}`,
      "X-Payout-Idempotency": req.traceId,
    },
    body: JSON.stringify({
      account_number: creds.account_number,
      fund_account_id: req.payee.razorpayFundAccountId,
      amount: req.amountPaise,
      currency: req.currency,
      mode: req.payee.kind === "upi" ? "UPI" : "IMPS",
      purpose: PURPOSE[req.purpose] ?? "vendor bill",
      queue_if_low_balance: true,
      reference_id: req.traceId,
      narration: req.narration.slice(0, 30),
    }),
    signal: AbortSignal.timeout(20_000),
  });

  const body = (await res.json().catch(() => ({}))) as { id?: string; status?: string; error?: { description?: string } };
  if (!res.ok || !body.id) {
    throw new Error(`RazorpayX refused this payout: ${body.error?.description ?? `HTTP ${res.status}`}`);
  }
  return { id: body.id, status: mapStatus(body.status), simulated: false, raw: body as unknown as Json };
}
