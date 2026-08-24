import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";

// @noble/ed25519 ships async-only by default to stay dependency-free; wiring in a
// sync sha512 unlocks the sync sign/verify/keygen calls this module uses.
ed.hashes.sha512 = sha512;

export interface Ed25519KeyPair {
  /** base64, raw 32-byte seed. Keep this secret — only the demo agent holds it. */
  secretKey: string;
  /** base64, raw 32-byte public key. This is what gets published in the key directory. */
  publicKey: string;
}

export function generateKeyPair(): Ed25519KeyPair {
  const { secretKey, publicKey } = ed.keygen();
  return {
    secretKey: Buffer.from(secretKey).toString("base64"),
    publicKey: Buffer.from(publicKey).toString("base64"),
  };
}

export function publicKeyFromSecret(secretKeyBase64: string): string {
  const secretKey = Buffer.from(secretKeyBase64, "base64");
  const publicKey = ed.getPublicKey(secretKey);
  return Buffer.from(publicKey).toString("base64");
}
