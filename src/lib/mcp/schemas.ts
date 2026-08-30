import { z } from "zod";

/**
 * Shared input contract for `simulate_action` and `enforce_action`. `agentId` is
 * deliberately NOT part of this schema — it comes from the verified Web Bot Auth
 * signature (keyid -> agents.id), never from the request body, so a caller can't
 * claim to be a different agent than the one that signed the request.
 */

export const OrderCreateParams = z.object({
  receipt: z.string().optional(),
  notes: z.record(z.string(), z.string()).optional(),
});

export const RefundCreateParams = z.object({
  paymentId: z.string(),
});

export const SubscriptionCreateParams = z.object({
  planName: z.string(),
  period: z.enum(["daily", "weekly", "monthly", "yearly"]),
  interval: z.number().int().positive().default(1),
  totalCount: z.number().int().positive(),
  customerNotify: z.boolean().default(false),
});

export const ActionInput = z.discriminatedUnion("actionType", [
  z.object({
    actionType: z.literal("order.create"),
    amount: z.number().int().positive(),
    currency: z.string().length(3).default("INR"),
    category: z.string().optional(),
    customerId: z.string().uuid().optional(),
    forkFrom: z.string().uuid().optional(),
    params: OrderCreateParams,
  }),
  z.object({
    actionType: z.literal("refund.create"),
    amount: z.number().int().positive(),
    currency: z.string().length(3).default("INR"),
    category: z.string().optional(),
    customerId: z.string().uuid().optional(),
    forkFrom: z.string().uuid().optional(),
    params: RefundCreateParams,
  }),
  z.object({
    actionType: z.literal("subscription.create"),
    amount: z.number().int().positive(),
    currency: z.string().length(3).default("INR"),
    category: z.string().optional(),
    customerId: z.string().uuid().optional(),
    forkFrom: z.string().uuid().optional(),
    params: SubscriptionCreateParams,
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
