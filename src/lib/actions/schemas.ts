import { z } from "zod";

/**
 * Runtime checks for what the dashboard's server actions accept.
 *
 * A server action is an HTTP endpoint: a TypeScript signature says what the
 * dashboard's own buttons send, not what a hand-written request sends. So every
 * enum is checked here and every free-text field has a ceiling. Pure (no
 * "use server", no server imports) so the same schemas are unit-tested.
 */

export const IdSchema = z.uuid();
export const AgentStatusSchema = z.enum(["active", "paused"]);
export const ChannelModeSchema = z.enum(["sandbox", "live"]);
export const PayoutModeSchema = z.enum(["auto", "manual"]);
export const VendorStatusSchema = z.enum(["approved", "blocked", "candidate"]);
export const PayeeNameSchema = z.string().trim().min(1).max(120);

const optionalText = (max: number) => z.string().trim().max(max).optional();

export const VendorInputSchema = z.object({
  name: z.string().trim().min(2, "Give the supplier a name.").max(120),
  channel: z.enum(["email", "whatsapp", "sandbox"]),
  email: z.string().trim().max(254).pipe(z.union([z.literal(""), z.email()])).optional(),
  phone: z
    .string()
    .trim()
    .max(20)
    .regex(/^(\+?[0-9][0-9 ()-]{5,18})?$/, "A phone number is digits, with an optional + and country code.")
    .optional(),
  website: z
    .string()
    .trim()
    .max(300)
    .refine((v) => v === "" || /^https?:\/\//i.test(v), "A website starts with http:// or https://.")
    .optional(),
  categories: z.array(z.string().trim().min(1).max(40)).max(10),
  notes: optionalText(1000),
});

export type ValidVendorInput = z.infer<typeof VendorInputSchema>;

/** Turns a failed parse into the first sentence a person can act on. */
export function firstProblem(error: z.ZodError): string {
  return error.issues[0]?.message ?? "That input was not valid.";
}

/** Parses or throws a sentence a person can read. */
export function parse<T>(schema: z.ZodType<T>, value: unknown, what = "That input"): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new Error(`${what} was not valid: ${firstProblem(r.error)}`);
  return r.data;
}
