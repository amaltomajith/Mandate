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
    .select("secret_enc, status, meta")
    .eq("merchant_id", merchantId)
    .eq("kind", "razorpay")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || data.status !== "connected") return null;
  // "Use the server's test keys": a connection that stores no secret of its own
  // and says so. The merchant chose it explicitly on the Connections page.
  if ((data.meta as { source?: string } | null)?.source === "env") {
    const key_id = process.env.RAZORPAY_KEY_ID;
    const key_secret = process.env.RAZORPAY_KEY_SECRET;
    return key_id && key_secret ? { key_id, key_secret } : null;
  }
  if (!data.secret_enc) return null;
  return decryptJson<RazorpayCredentials>(data.secret_enc);
}

export async function loadRazorpayXCredentials(merchantId: string): Promise<RazorpayXCredentials | null> {
  const { data, error } = await createAdminClient()
    .from("connections")
    .select("secret_enc, status, meta")
    .eq("merchant_id", merchantId)
    .eq("kind", "razorpayx")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || data.status !== "connected") return null;

  // Borrowing the server's RazorpayX account is only ever an explicit choice a
  // merchant made on the Connections page (and only the operator of the
  // deployment should offer it). Without that, a merchant who connected nothing
  // would be paying suppliers out of someone else's account.
  if ((data.meta as { source?: string } | null)?.source === "env") {
    const account_number = process.env.RAZORPAYX_ACCOUNT_NUMBER;
    const key_id = process.env.RAZORPAY_KEY_ID;
    const key_secret = process.env.RAZORPAY_KEY_SECRET;
    return account_number && key_id && key_secret ? { key_id, key_secret, account_number } : null;
  }
  if (!data.secret_enc) return null;
  return decryptJson<RazorpayXCredentials>(data.secret_enc);
}

/**
 * A Razorpay client for one merchant, or null when they should be on the
 * sandbox: no connected account of their own. Real calls only ever use keys the
 * merchant connected (or explicitly chose to borrow from the server); a merchant
 * who has connected nothing never reaches Razorpay by accident, and the results
 * they get are labelled `simulated: true`.
 */
export async function getRazorpayForMerchant(merchantId: string): Promise<Razorpay | null> {
  const hit = clients.get(merchantId);
  if (hit && Date.now() - hit.at < PER_MERCHANT_TTL_MS) return hit.client;

  const creds = await loadRazorpayCredentials(merchantId);
  if (!creds) return null;
  const client = new Razorpay({ key_id: creds.key_id, key_secret: creds.key_secret });
  clients.set(merchantId, { at: Date.now(), client });
  return client;
}
