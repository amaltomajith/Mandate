import "server-only";
import Razorpay from "razorpay";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptJson } from "@/lib/secrets";

let cached: Razorpay | null = null;

/** Standard Razorpay SDK — Orders, Payments, Refunds, Payment Links.
 *  Test-mode vs live is purely a function of which key pair is in use.
 *  This is the environment fallback; merchants normally bring their own keys
 *  (see {@link getRazorpayForMerchant}). */
export function getRazorpay(): Razorpay {
  if (cached) return cached;

  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key_id || !key_secret) {
    throw new Error("RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set.");
  }

  cached = new Razorpay({ key_id, key_secret });
  return cached;
}

export interface RazorpayCredentials {
  key_id: string;
  key_secret: string;
  webhook_secret?: string;
}

export interface RazorpayXCredentials extends RazorpayCredentials {
  /** The RazorpayX current-account number payouts are drawn from. */
  account_number: string;
}

const PER_MERCHANT_TTL_MS = 60_000;
const clients = new Map<string, { at: number; client: Razorpay }>();

/** The merchant's own stored credentials, if they connected any. */
export async function loadRazorpayCredentials(merchantId: string): Promise<RazorpayCredentials | null> {
  const { data, error } = await createAdminClient()
    .from("connections")
    .select("secret_enc, status")
    .eq("merchant_id", merchantId)
    .eq("kind", "razorpay")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.secret_enc || data.status !== "connected") return null;
  return decryptJson<RazorpayCredentials>(data.secret_enc);
}

export async function loadRazorpayXCredentials(merchantId: string): Promise<RazorpayXCredentials | null> {
  const { data, error } = await createAdminClient()
    .from("connections")
    .select("secret_enc, status")
    .eq("merchant_id", merchantId)
    .eq("kind", "razorpayx")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (data?.secret_enc && data.status === "connected") return decryptJson<RazorpayXCredentials>(data.secret_enc);

  // Environment fallback for the default tenant: only usable when an account
  // number is configured, which is what separates live payouts from sandbox.
  const account_number = process.env.RAZORPAYX_ACCOUNT_NUMBER;
  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;
  if (account_number && key_id && key_secret) return { key_id, key_secret, account_number };
  return null;
}

/** A Razorpay client for one merchant: their stored keys, else the environment's. */
export async function getRazorpayForMerchant(merchantId: string): Promise<Razorpay> {
  const hit = clients.get(merchantId);
  if (hit && Date.now() - hit.at < PER_MERCHANT_TTL_MS) return hit.client;

  const creds = await loadRazorpayCredentials(merchantId);
  const client = creds ? new Razorpay({ key_id: creds.key_id, key_secret: creds.key_secret }) : getRazorpay();
  clients.set(merchantId, { at: Date.now(), client });
  return client;
}
