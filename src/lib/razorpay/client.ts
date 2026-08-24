import "server-only";
import Razorpay from "razorpay";

let cached: Razorpay | null = null;

/** Standard Razorpay SDK — Orders, Payments, Refunds, Subscriptions, Plans.
 *  Test-mode vs live is purely a function of which key pair is in the env. */
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
