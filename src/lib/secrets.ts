import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// No `import "server-only"`: the worker (plain tsx) loads this too. It is never
// imported from client components.

/**
 * Authenticated encryption for secrets stored in the database: Gmail tokens,
 * Razorpay keys, the WhatsApp session, agent signing keys.
 *
 * AES-256-GCM with a fresh random 96-bit IV per value. The stored form is
 * `v1.<iv>.<tag>.<ciphertext>` (all base64url), so the scheme can change later
 * without a flag day. The key is MANDATE_SECRET_KEY, 32 bytes as base64 or 64
 * hex characters. Losing it makes every stored secret unrecoverable, which is
 * the intended failure mode: the database alone is not enough to use them.
 */

const VERSION = "v1";

function loadKey(): Buffer {
  const raw = process.env.MANDATE_SECRET_KEY;
  if (!raw) throw new Error("MANDATE_SECRET_KEY is not set. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"");
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("MANDATE_SECRET_KEY must decode to exactly 32 bytes.");
  return key;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", loadKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptSecret(stored: string): string {
  const [version, iv, tag, ciphertext] = stored.split(".");
  if (version !== VERSION || !iv || !tag || !ciphertext) throw new Error("Unrecognised secret format.");
  const decipher = createDecipheriv("aes-256-gcm", loadKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

export function encryptJson(value: unknown): string {
  return encryptSecret(JSON.stringify(value));
}

export function decryptJson<T>(stored: string): T {
  return JSON.parse(decryptSecret(stored)) as T;
}
