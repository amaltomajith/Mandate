import "server-only";
import { randomUUID } from "node:crypto";
import type { ActionInput } from "@/lib/mcp/schemas";
import { getRazorpay } from "./client";
import { createContact, createPayout, createVpaFundAccount } from "./x";
import type { Json } from "@/types/db";

/** Razorpay's Plans/Subscriptions API returns a plain 401 when the
 *  "Subscriptions" product isn't activated on the account — the same
 *  category of test-mode gate as RazorpayX needing a registered business
 *  (§6). Confirmed by direct diagnostic: the exact same key pair that
 *  succeeds on `orders.create` gets `{statusCode: 401, error:
 *  "Unauthorized"}` on `plans.create` alone — not a credentials problem. */
function isSubscriptionsNotActivated(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "statusCode" in err &&
    (err as { statusCode: unknown }).statusCode === 401
  );
}

/**
 * The only place real money-moving Razorpay/RazorpayX calls happen. Called by
 * `enforce_action` after the policy engine has already returned "allow" — never
 * called directly, and never called for a "block"/"escalate" decision.
 *
 * Scope note (see HANDOVER.md "What's real vs illustrative"): `order.create` and
 * `subscription.create` are real, server-to-server Razorpay API calls that
 * represent the *first* leg of those flows. Actually capturing a payment or
 * authorizing a UPI Autopay mandate is, by Razorpay's own design, a customer-facing
 * step (Checkout / an auth link) that happens outside this control plane — Mandate's
 * job is the gate before and the record after, not reimplementing Razorpay's own
 * checkout UI. `payout.create` and `refund.create` are genuinely end-to-end
 * server-to-server with no customer-facing step, which is why the demo script
 * leans on payouts as its primary "real money movement" beat.
 */
export async function executeRealAction(input: ActionInput): Promise<Json> {
  switch (input.actionType) {
    case "order.create": {
      const rzp = getRazorpay();
      const order = await rzp.orders.create({
        amount: input.amount,
        currency: input.currency,
        receipt: input.params.receipt,
        notes: input.params.notes,
      });
      return order as unknown as Json;
    }

    case "refund.create": {
      const rzp = getRazorpay();
      const refund = await rzp.payments.refund(input.params.paymentId, {
        amount: input.amount,
      });
      return refund as unknown as Json;
    }

    case "payout.create": {
      const contact = await createContact({
        name: input.params.vendorName,
        type: "vendor",
      });
      const fundAccount = await createVpaFundAccount(contact.id, input.params.vpa);
      const payout = await createPayout({
        fundAccountId: fundAccount.id,
        amount: input.amount,
        currency: input.currency,
        purpose: input.params.purpose ?? "payout",
        narration: input.params.narration,
      });
      return { contact, fundAccount, payout } as unknown as Json;
    }

    case "subscription.create": {
      const rzp = getRazorpay();
      try {
        const plan = await rzp.plans.create({
          period: input.params.period,
          interval: input.params.interval,
          item: {
            name: input.params.planName,
            amount: input.amount,
            currency: input.currency,
          },
        });
        const subscription = await rzp.subscriptions.create({
          plan_id: plan.id,
          total_count: input.params.totalCount,
          customer_notify: input.params.customerNotify ? 1 : 0,
        });
        return { plan, subscription } as unknown as Json;
      } catch (err) {
        if (!isSubscriptionsNotActivated(err)) throw err;
        // Falls back to a locally-recorded, clearly-labeled mandate object
        // rather than failing the whole action — exactly the "real if the
        // API cooperates, else a clearly-labeled simplified mandate object"
        // scope decision this project already made for UPI Autopay (§6).
        // The part this actually demonstrates — a merchant revoking a
        // mandate blocking the agent's next action — doesn't depend on the
        // subscription object underneath it being genuinely from Razorpay.
        const subscriptionId = `sim_sub_${randomUUID()}`;
        return {
          plan: null,
          subscription: { id: subscriptionId, status: "created" },
          simulated: true,
          note: "Razorpay's Subscriptions API isn't activated on this test account (see HANDOVER.md §6) — recorded as a simplified mandate object instead of a real Razorpay subscription.",
        } as unknown as Json;
      }
    }
  }
}
