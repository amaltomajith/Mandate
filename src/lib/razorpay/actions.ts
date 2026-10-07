import "server-only";
import type { ActionInput } from "@/lib/mcp/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordPayout } from "@/lib/ledger";
import { getRazorpayForMerchant } from "./client";
import { sandboxLink, sandboxOrder, sandboxRefund } from "./sandbox";
import { executePayout } from "./payouts";
import type { Json } from "@/types/db";

/**
 * The only place real money-moving calls happen. Called by the wall after the
 * policy engine has returned "allow" (or after a human approves an escalation) —
 * never called directly, and never called for a block or an unanswered
 * escalation.
 *
 * `order.create` and `payment_link.create` are the first leg of a sale:
 * capturing the payment is the customer's own step at Razorpay Checkout.
 * `refund.create` is end to end server-to-server. `payout.create` sends money to
 * a supplier through RazorpayX, or through the labelled sandbox executor when
 * RazorpayX is not connected (see payouts.ts). `price.change` moves no money but
 * gives some away, so it is gated the same way and applied only here.
 */

export interface ExecutionContext {
  merchantId: string;
  /** The wall's trace for this decision. Written BEFORE this runs, and used as
   *  the idempotency key so a retry cannot pay twice. */
  traceId: string;
  agentId: string | null;
}

/**
 * Razorpay's SDK rejects with a plain object, not an Error.
 *
 * Without unwrapping it, a genuine Razorpay refusal reaches the caller as
 * "[object Object]" with the actual reason discarded.
 */
function asError(err: unknown): Error {
  if (err instanceof Error) return err;
  if (typeof err === "object" && err !== null) {
    const e = err as { statusCode?: number; error?: { description?: string; code?: string; field?: string } };
    const parts = [
      e.error?.description ?? JSON.stringify(err).slice(0, 200),
      e.error?.field ? `(field: ${e.error.field})` : "",
      e.statusCode ? `[HTTP ${e.statusCode}]` : "",
    ].filter(Boolean);
    return new Error(`Razorpay refused this: ${parts.join(" ")}`);
  }
  return new Error(String(err));
}

export async function executeRealAction(input: ActionInput, ctx: ExecutionContext): Promise<Json> {
  try {
    return await dispatch(input, ctx);
  } catch (err) {
    throw asError(err);
  }
}

/** Razorpay note values are capped at 256 characters. */
function itemsNote(items: { sku: string; qty: number }[] | undefined): Record<string, string> {
  if (!items || items.length === 0) return {};
  return { items: items.map((i) => `${i.sku}x${i.qty}`).join(",").slice(0, 250) };
}

async function dispatch(input: ActionInput, ctx: ExecutionContext): Promise<Json> {
  switch (input.actionType) {
    case "order.create": {
      const rzp = await getRazorpayForMerchant(ctx.merchantId);
      if (!rzp) return sandboxOrder(ctx.traceId, input.amount, input.currency);
      const order = await rzp.orders.create({
        amount: input.amount,
        currency: input.currency,
        receipt: input.params.receipt,
        notes: { ...(input.params.notes ?? {}), ...itemsNote(input.params.lineItems), mandate_trace: ctx.traceId },
      });
      return order as unknown as Json;
    }

    // A real Razorpay payment link, and the action whose outcome is observable
    // afterwards: the link carries a `status` that moves to "paid", and the
    // captured-payment webhook turns that into a sale and a wallet credit.
    case "payment_link.create": {
      const rzp = await getRazorpayForMerchant(ctx.merchantId);
      const p = input.params;
      if (!rzp) return sandboxLink(ctx.traceId, input.amount, input.currency, p.description);
      const link = await rzp.paymentLink.create({
        amount: input.amount,
        currency: input.currency,
        description: p.description,
        customer: {
          name: p.customerName,
          ...(p.customerEmail ? { email: p.customerEmail } : {}),
          ...(p.customerContact ? { contact: p.customerContact } : {}),
        },
        // Off unless explicitly asked for. Razorpay does the sending, so a test
        // run against synthetic customers with this on would be mailing real
        // addresses that happen to look fake.
        notify: { email: p.notify, sms: p.notify },
        reminder_enable: false,
        ...(p.expiresInHours
          ? { expire_by: Math.floor(Date.now() / 1000) + p.expiresInHours * 3600 }
          : {}),
        notes: {
          ...(p.notes ?? {}),
          ...itemsNote(p.lineItems),
          discount_paise: String(p.discountPaise),
          mandate_trace: ctx.traceId,
        },
      });
      return link as unknown as Json;
    }

    case "refund.create": {
      const rzp = await getRazorpayForMerchant(ctx.merchantId);
      if (!rzp) return sandboxRefund(ctx.traceId, input.amount, input.currency);
      const refund = await rzp.payments.refund(input.params.paymentId, {
        amount: input.amount,
        // Ties the refund to the wall's decision, so a duplicate is visible at Razorpay.
        receipt: ctx.traceId.slice(0, 40),
      });
      return refund as unknown as Json;
    }

    case "payout.create": {
      const db = createAdminClient();
      // Read again at execution time, not trusted from the decision: the payee
      // must still be active at the moment the money moves.
      const { data: payee, error } = await db
        .from("payees")
        .select("id, kind, status, razorpay_fund_account_id, simulated, display_name")
        .eq("id", input.params.payeeId)
        .eq("merchant_id", ctx.merchantId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!payee || payee.status !== "active") throw new Error("This payee is no longer active, so the payout was not sent.");

      const result = await executePayout({
        traceId: ctx.traceId,
        merchantId: ctx.merchantId,
        amountPaise: input.amount,
        currency: input.currency,
        purpose: input.params.purpose,
        narration: `Mandate ${input.params.purpose}`,
        payee: { kind: payee.kind, razorpayFundAccountId: payee.razorpay_fund_account_id, simulated: payee.simulated },
      });
      await recordPayout({
        merchantId: ctx.merchantId,
        traceId: ctx.traceId,
        payeeId: payee.id,
        poId: input.params.poId,
        amountPaise: input.amount,
        razorpayPayoutId: result.id,
        status: result.status,
        simulated: result.simulated,
        note: `${input.params.purpose.replace("_", " ")} to ${payee.display_name}`,
      });
      return { payout_id: result.id, status: result.status, simulated: result.simulated, raw: result.raw } as unknown as Json;
    }

    case "price.change": {
      const db = createAdminClient();
      const { data: current, error: readError } = await db
        .from("products")
        .select("price_paise, compare_at_price_paise")
        .eq("merchant_id", ctx.merchantId)
        .eq("sku", input.params.sku)
        .maybeSingle();
      if (readError) throw new Error(readError.message);
      if (!current) throw new Error(`No product with sku "${input.params.sku}".`);

      // Remember the price a clearance started from, and forget it once the
      // product is back at (or above) it. "20% off" only means something
      // against a recorded original.
      const original = current.compare_at_price_paise ?? current.price_paise;
      const compareAt = input.amount < original ? original : null;
      const { data, error } = await db
        .from("products")
        .update({ price_paise: input.amount, compare_at_price_paise: compareAt })
        .eq("merchant_id", ctx.merchantId)
        .eq("sku", input.params.sku)
        .select("sku, price_paise, compare_at_price_paise")
        .single();
      if (error) throw new Error(error.message);
      return { sku: data.sku, new_price_paise: data.price_paise, compare_at_price_paise: data.compare_at_price_paise } as unknown as Json;
    }
  }
}
