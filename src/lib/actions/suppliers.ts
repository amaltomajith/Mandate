"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireDashboardUser } from "./authGuard";
import { getCurrentMerchant } from "@/lib/merchant";
import { loadRazorpayXCredentials } from "@/lib/razorpay/client";
import { createFundAccount, maskPayee, validatePayeeDetails, type PayeeDetails } from "@/lib/razorpay/payees";
import type { Channel } from "@/types/db";
import { getSettings } from "@/lib/settings";
import { encryptJson } from "@/lib/secrets";
import { IdSchema, PayeeNameSchema, VendorInputSchema, VendorStatusSchema, parse } from "./schemas";

/**
 * Suppliers and who may be paid.
 *
 * The line this file draws: AGENTS find and talk to suppliers, but only a PERSON,
 * here, approves a supplier or a payee. An approved payee is the only kind the
 * Payment Wall will ever pay, so these actions are the one place money is
 * allowed to be pointed at somebody. They take the signed-in user's identity and
 * record it on the approval; none accept a merchant id from the caller.
 */

async function scope() {
  const user = await requireDashboardUser();
  return { user, merchant: await getCurrentMerchant(), db: createAdminClient() };
}

export interface VendorInput {
  name: string;
  channel: Channel;
  email?: string;
  phone?: string;
  website?: string;
  categories: string[];
  notes?: string;
}

export async function saveVendor(rawId: string | null, rawInput: VendorInput): Promise<void> {
  const { merchant, db } = await scope();
  const id = rawId === null ? null : parse(IdSchema, rawId, "The supplier id");
  const input = parse(VendorInputSchema, rawInput, "The supplier");
  const name = input.name;
  if (input.channel === "email" && !input.email) throw new Error("An email supplier needs an email address.");
  if (input.channel === "whatsapp" && !input.phone) throw new Error("A WhatsApp supplier needs a phone number.");
  // A person can only add real suppliers here. The sandbox channel is reserved
  // for the sample store, so nothing a merchant adds can be mistaken for one.
  if (input.channel === "sandbox") throw new Error("The sandbox channel is only used by the sample store.");

  const row = {
    name,
    channel: input.channel,
    email: input.email?.trim() || null,
    phone: input.phone?.trim() || null,
    website: input.website?.trim() || null,
    categories: input.categories,
    notes: input.notes?.trim() || null,
  };
  if (id) {
    const { error } = await db.from("vendors").update(row).eq("id", id).eq("merchant_id", merchant.id);
    if (error) throw new Error(error.message);
  } else {
    // Added by a person, so it starts approved to be CONTACTED, but it still has
    // no payee: nothing can be paid until a payee is added and approved.
    const { error } = await db.from("vendors").insert({ merchant_id: merchant.id, ...row, status: "approved", source: "manual" });
    if (error) throw new Error(error.message.includes("vendors_merchant_name_key") ? `You already have a supplier called "${name}".` : error.message);
  }
  revalidatePath("/dashboard");
}

export async function setVendorStatus(rawId: string, rawStatus: "approved" | "blocked" | "candidate"): Promise<void> {
  const { merchant, db } = await scope();
  const id = parse(IdSchema, rawId, "The supplier id");
  const status = parse(VendorStatusSchema, rawStatus, "The supplier status");
  const { error } = await db.from("vendors").update({ status }).eq("id", id).eq("merchant_id", merchant.id);
  if (error) throw new Error(error.message);
  if (status === "blocked") {
    // Blocking a supplier cuts off their payees too: money may not flow to
    // someone the merchant has just refused.
    await db.from("payees").update({ status: "revoked" }).eq("vendor_id", id).eq("merchant_id", merchant.id).neq("status", "revoked");
  }
  revalidatePath("/dashboard");
}

export async function deleteVendor(rawId: string): Promise<void> {
  const { merchant, db } = await scope();
  const id = parse(IdSchema, rawId, "The supplier id");
  const { count } = await db.from("purchase_orders").select("id", { count: "exact", head: true }).eq("merchant_id", merchant.id).eq("vendor_id", id);
  if ((count ?? 0) > 0) throw new Error("This supplier has purchase orders on record. Block it instead of deleting.");
  const { error } = await db.from("vendors").delete().eq("id", id).eq("merchant_id", merchant.id);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

export interface PayeeInput {
  vendorId: string;
  displayName: string;
  details: PayeeDetails;
}

/**
 * Adds a payee in PENDING. It cannot be paid until a person approves it with
 * {@link approvePayee}, which is a separate, deliberate step: adding payment
 * details and trusting them are two different decisions.
 */
export async function addPayee(rawInput: PayeeInput): Promise<void> {
  const { merchant, db } = await scope();
  const input: PayeeInput = {
    ...rawInput,
    vendorId: parse(IdSchema, rawInput.vendorId, "The supplier id"),
    displayName: parse(PayeeNameSchema, rawInput.displayName, "The account holder name"),
  };
  validatePayeeDetails(input.details);
  const { data: vendor } = await db.from("vendors").select("id, name, status").eq("id", input.vendorId).eq("merchant_id", merchant.id).maybeSingle();
  if (!vendor) throw new Error("Unknown supplier.");
  if (vendor.status === "blocked") throw new Error("This supplier is blocked.");

  const settings = await getSettings(db, merchant.id);
  const manual = settings.payout_mode === "manual";

  // MANUAL: the merchant pays this supplier from their own bank, so nothing is
  // registered with Razorpay. The full details are kept, encrypted, for exactly
  // one purpose: showing them to the signed-in merchant at the moment they make
  // the payment. They are never sent to an agent or to the browser as stored.
  //
  // AUTO: with RazorpayX connected the details are registered there and only the
  // last digits are kept here. Without it the payee is a sandbox payee: stored the
  // same way, but only the labelled sandbox executor will ever "pay" it.
  const creds = manual ? null : await loadRazorpayXCredentials(merchant.id);
  let contactId: string | null = null;
  let fundAccountId: string | null = null;
  if (creds) {
    const ids = await createFundAccount(creds, input.displayName.trim() || vendor.name, input.details);
    contactId = ids.contactId;
    fundAccountId = ids.fundAccountId;
  }

  const { error } = await db.from("payees").insert({
    merchant_id: merchant.id,
    vendor_id: vendor.id,
    kind: input.details.kind,
    display_name: input.displayName.trim() || vendor.name,
    masked_identifier: maskPayee(input.details),
    razorpay_contact_id: contactId,
    razorpay_fund_account_id: fundAccountId,
    details_enc: manual ? encryptJson(input.details) : null,
    status: "pending",
    simulated: manual ? false : !creds,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

export async function approvePayee(rawId: string): Promise<void> {
  const id = parse(IdSchema, rawId, "The payee id");
  const { user, merchant, db } = await scope();
  const { data: payee } = await db.from("payees").select("id, vendor_id, status").eq("id", id).eq("merchant_id", merchant.id).maybeSingle();
  if (!payee) throw new Error("Unknown payee.");
  const { data: vendor } = await db.from("vendors").select("status").eq("id", payee.vendor_id).eq("merchant_id", merchant.id).single();
  if (vendor?.status !== "approved") throw new Error("Approve the supplier first.");
  const { error } = await db
    .from("payees")
    .update({ status: "active", approved_by: user.email, approved_at: new Date().toISOString() })
    .eq("id", id)
    .eq("merchant_id", merchant.id);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

export async function revokePayee(rawId: string): Promise<void> {
  const id = parse(IdSchema, rawId, "The payee id");
  const { merchant, db } = await scope();
  const { error } = await db.from("payees").update({ status: "revoked" }).eq("id", id).eq("merchant_id", merchant.id);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}

/** Goods arrived: add the ordered quantities to stock and close the order. */
export async function markPurchaseOrderReceived(rawPoId: string): Promise<void> {
  const poId = parse(IdSchema, rawPoId, "The order id");
  const { merchant, db } = await scope();
  const { data: po } = await db.from("purchase_orders").select("id, status").eq("id", poId).eq("merchant_id", merchant.id).maybeSingle();
  if (!po) throw new Error("Unknown purchase order.");
  if (po.status !== "paid" && po.status !== "approved") throw new Error("Only an order that has been paid for can be marked received.");

  // Claim first, then add stock, so a double click cannot add it twice.
  const { data: claimed } = await db
    .from("purchase_orders")
    .update({ status: "received", received_at: new Date().toISOString() })
    .eq("id", poId)
    .eq("merchant_id", merchant.id)
    .in("status", ["paid", "approved"])
    .select("id");
  if (!claimed?.length) return;

  const { data: lines } = await db.from("po_lines").select("product_id, qty").eq("po_id", poId).eq("merchant_id", merchant.id);
  for (const l of lines ?? []) {
    const { data: p } = await db.from("products").select("stock_qty").eq("id", l.product_id).eq("merchant_id", merchant.id).single();
    if (p) await db.from("products").update({ stock_qty: p.stock_qty + l.qty }).eq("id", l.product_id).eq("merchant_id", merchant.id);
  }
  revalidatePath("/dashboard");
}

export async function cancelPurchaseOrder(rawPoId: string): Promise<void> {
  const poId = parse(IdSchema, rawPoId, "The order id");
  const { merchant, db } = await scope();
  const { error } = await db
    .from("purchase_orders")
    .update({ status: "cancelled" })
    .eq("id", poId)
    .eq("merchant_id", merchant.id)
    .in("status", ["draft", "quoting", "awaiting_approval"]);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}
