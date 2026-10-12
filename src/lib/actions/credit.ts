"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireDashboardUser } from "./authGuard";
import { getCurrentMerchant } from "@/lib/merchant";
import { getSettings } from "@/lib/settings";
import { changedFields, logConfigChange } from "@/lib/configLog";
import { receivePayment, sellOnCredit, writeOff } from "@/lib/credit";
import { CreditCustomerSchema, CreditPaymentSchema, CreditSaleSchema, parse } from "./schemas";

/**
 * Selling on credit and collecting it. Only a signed-in person can do any of
 * this: agents can read the ledger and remind, never lend. The limits (per
 * customer, overall, stock) are enforced in the database; these actions only
 * translate a refusal into a sentence.
 */

async function scope() {
  const user = await requireDashboardUser();
  return { user, merchant: await getCurrentMerchant(), db: createAdminClient() };
}

const done = () => revalidatePath("/dashboard");

/** Adds a customer or changes their credit limit and terms. */
export async function saveCreditCustomer(raw: z.infer<typeof CreditCustomerSchema>): Promise<void> {
  const { user, merchant, db } = await scope();
  const v = parse(CreditCustomerSchema, raw, "The customer");
  const limit = Math.round(v.limitRupees * 100);
  if (v.customerId) {
    const { data: before } = await db.from("customers").select("name, credit_limit_paise").eq("id", v.customerId).eq("merchant_id", merchant.id).maybeSingle();
    if (!before) throw new Error("That customer was not found.");
    const { error } = await db.from("customers").update({ credit_limit_paise: limit, credit_terms_days: v.termsDays }).eq("id", v.customerId).eq("merchant_id", merchant.id);
    if (error) throw new Error(error.message);
    await logConfigChange(db as never, merchant.id, user.email, changedFields({ [`credit limit for ${before.name}`]: Number(before.credit_limit_paise) / 100 }, { [`credit limit for ${before.name}`]: v.limitRupees }, [`credit limit for ${before.name}`]));
  } else {
    if (!v.name) throw new Error("Give the customer a name.");
    const { error } = await db.from("customers").insert({ merchant_id: merchant.id, name: v.name, phone: v.phone || null, email: v.email || null, credit_limit_paise: limit, credit_terms_days: v.termsDays });
    if (error) throw new Error(error.message);
    await logConfigChange(db as never, merchant.id, user.email, changedFields({ [`credit limit for ${v.name}`]: 0 }, { [`credit limit for ${v.name}`]: v.limitRupees }, [`credit limit for ${v.name}`]));
  }
  done();
}

/** The overall cap on what customers may owe in total. */
export async function setCreditCap(rawRupees: number): Promise<void> {
  const { user, merchant, db } = await scope();
  const rupees = parse(z.number().finite().min(0).max(100_000_000), rawRupees, "The cap");
  const before = (await getSettings(db, merchant.id)) as unknown as Record<string, unknown>;
  const patch = { credit_exposure_cap_paise: Math.round(rupees * 100) };
  const { error } = await db.from("merchant_settings").update({ ...patch, updated_at: new Date().toISOString() }).eq("merchant_id", merchant.id);
  if (error) throw new Error(error.message);
  await logConfigChange(db as never, merchant.id, user.email, changedFields(before, { ...before, ...patch }, Object.keys(patch)));
  done();
}

export async function sellOnCreditAction(raw: z.infer<typeof CreditSaleSchema>): Promise<void> {
  const { user, merchant, db } = await scope();
  const v = parse(CreditSaleSchema, raw, "The sale");
  const r = await sellOnCredit(db as never, merchant.id, v.customerId, [{ sku: v.sku, qty: v.qty }], user.email, v.ref);
  if (!r.ok) throw new Error(r.message);
  done();
}

export async function receiveCreditPayment(raw: z.infer<typeof CreditPaymentSchema>): Promise<void> {
  const { user, merchant, db } = await scope();
  const v = parse(CreditPaymentSchema, raw, "The payment");
  const r = await receivePayment(db as never, merchant.id, v.customerId, Math.round(v.amountRupees * 100), user.email, { ref: v.ref });
  if (!r.ok) throw new Error(r.message);
  done();
}

export async function writeOffCredit(raw: z.infer<typeof CreditPaymentSchema>): Promise<void> {
  const { user, merchant, db } = await scope();
  const v = parse(CreditPaymentSchema, raw, "The write-off");
  const r = await writeOff(db as never, merchant.id, v.customerId, Math.round(v.amountRupees * 100), user.email, { ref: v.ref });
  if (!r.ok) throw new Error(r.message);
  done();
}
