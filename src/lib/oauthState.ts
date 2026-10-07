import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Signed, expiring `state` for OAuth round trips.
 *
 * `state` exists to stop a forged callback from attaching someone else's
 * account to a merchant. It carries the merchant and a nonce, is signed with a
 * key derived from MANDATE_SECRET_KEY, and the nonce is also kept in an httpOnly
 * cookie, so a callback is only accepted from the same browser that started it.
 */

function key(): Buffer {
  const raw = process.env.MANDATE_SECRET_KEY;
  if (!raw) throw new Error("MANDATE_SECRET_KEY is not set.");
  return createHmac("sha256", "oauth-state").update(raw).digest();
}

const sign = (payload: string) => createHmac("sha256", key()).update(payload).digest("base64url");

export function createState(merchantId: string, ttlSeconds = 600): { state: string; nonce: string } {
  const nonce = randomBytes(16).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${merchantId}.${nonce}.${exp}`;
  return { state: `${payload}.${sign(payload)}`, nonce };
}

export function verifyState(state: string, merchantId: string, cookieNonce: string | undefined): boolean {
  const parts = state.split(".");
  if (parts.length !== 4) return false;
  const [mid, nonce, exp, sig] = parts;
  const expected = sign(`${mid}.${nonce}.${exp}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  if (mid !== merchantId) return false;
  if (!cookieNonce || cookieNonce !== nonce) return false;
  return Number(exp) >= Math.floor(Date.now() / 1000);
}
