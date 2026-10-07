import { z } from "zod";

/**
 * Shared input contract for `simulate_action` and `enforce_action`. `agentId` is
 * deliberately NOT part of this schema — it comes from the verified Web Bot Auth
 * signature (keyid -> agents.id), never from the request body, so a caller can't
 * claim to be a different agent than the one that signed the request.
 */

/**
 * What a sale is made of. The server resolves each SKU to a product and reads
 * its cost from the database; the caller never states a cost, so a margin
 * cannot be argued into passing.
 */
export const LineItem = z.object({
  sku: z.string().min(1),
  qty: z.number().int().positive().max(100000),
});
export type LineItem = z.infer<typeof LineItem>;

export const OrderCreateParams = z.object({
  receipt: z.string().optional(),
  notes: z.record(z.string(), z.string()).optional(),
  lineItems: z.array(LineItem).min(1).optional(),
});

export const RefundCreateParams = z.object({
  paymentId: z.string(),
});

/**
 * A payment link is how the Selling agent asks a buyer to pay: it names a
 * buyer, decides an offer, and creates a link for the discounted amount.
 *
 * `discountPaise` is carried alongside rather than folded into `amount`.
 * `amount` stays what it is for every other action -- what the customer is
 * asked to pay -- so caps and step-up thresholds keep one consistent meaning
 * across every action type. The giveaway is a separate quantity a merchant may
 * want bounded separately, and conflating the two would have made "cap orders
 * at 20,000" silently mean something different for links.
 *
 * `notify` is off by default. Razorpay sends the email/SMS itself when it is
 * on, and a test run against synthetic customers should not be mailing
 * anyone -- an opt-in flag is the difference between a demo and an incident.
 */
export const PaymentLinkCreateParams = z.object({
  description: z.string().max(2048),
  customerName: z.string(),
  customerEmail: z.string().email().optional(),
  customerContact: z.string().optional(),
  discountPaise: z.number().int().nonnegative().default(0),
  notify: z.boolean().default(false),
  expiresInHours: z.number().int().positive().max(720).optional(),
  notes: z.record(z.string(), z.string()).optional(),
  lineItems: z.array(LineItem).min(1).optional(),
});

/**
 * Money out to a supplier. The agent names a payee by id and a purchase order;
 * it never supplies an account number, UPI id or name. Those live at Razorpay,
 * attached to a payee record only a human can create and approve.
 */
export const PayoutCreateParams = z.object({
  payeeId: z.string().uuid(),
  poId: z.string().uuid().optional(),
  purpose: z.enum(["vendor_advance", "vendor_payment", "refund_to_vendor"]).default("vendor_advance"),
  note: z.string().max(200).optional(),
});

/** Change what a product sells for. Gated like money because a price drop is
 *  money given away. `amount` carries the new price. */
export const PriceChangeParams = z.object({
  sku: z.string().min(1),
  reason: z.string().max(200).optional(),
});

export const ActionInput = z.discriminatedUnion("actionType", [
  z.object({
    actionType: z.literal("order.create"),
    amount: z.number().int().positive(),
    currency: z.string().length(3).default("INR"),
    category: z.string().optional(),
    customerId: z.string().uuid().optional(),
    params: OrderCreateParams,
  }),
  z.object({
    actionType: z.literal("refund.create"),
    amount: z.number().int().positive(),
    currency: z.string().length(3).default("INR"),
    category: z.string().optional(),
    customerId: z.string().uuid().optional(),
    params: RefundCreateParams,
  }),
  z.object({
    actionType: z.literal("payment_link.create"),
    amount: z.number().int().positive(),
    currency: z.string().length(3).default("INR"),
    category: z.string().optional(),
    customerId: z.string().uuid().optional(),
    params: PaymentLinkCreateParams,
  }),
  z.object({
    actionType: z.literal("payout.create"),
    amount: z.number().int().positive(),
    currency: z.string().length(3).default("INR"),
    category: z.string().optional(),
    customerId: z.string().uuid().optional(),
    params: PayoutCreateParams,
  }),
  z.object({
    actionType: z.literal("price.change"),
    amount: z.number().int().positive(),
    currency: z.string().length(3).default("INR"),
    category: z.string().optional(),
    customerId: z.string().uuid().optional(),
    params: PriceChangeParams,
  }),
]);

export type ActionInput = z.infer<typeof ActionInput>;

export const ExplainInput = z.object({
  traceId: z.string().uuid(),
});

export const DraftPolicyInput = z.object({
  text: z.string().min(10),
  sourceLabel: z.string().optional(), // e.g. "Horizon: RBI circular DPSS.CO.PD No.1234"
  source: z.enum(["human", "horizon"]).default("human"),
});
