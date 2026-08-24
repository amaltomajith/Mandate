import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import {
  buildSignatureBase,
  computeContentDigest,
  parseSignatureInputHeader,
} from "./canonical";

ed.hashes.sha512 = sha512;

const MAX_CLOCK_SKEW_SECONDS = 300; // replay-protection window

export type VerifyFailureReason =
  | "missing_headers"
  | "malformed_signature_input"
  | "unknown_keyid"
  | "digest_mismatch"
  | "stale_or_future_created"
  | "bad_signature";

export type VerifyResult =
  | { valid: true; keyid: string }
  | { valid: false; reason: VerifyFailureReason; detail?: string };

export interface VerifyRequestInput {
  method: string;
  path: string;
  authority: string;
  body: string;
  headers: {
    "content-digest"?: string | null;
    "signature-input"?: string | null;
    signature?: string | null;
  };
  /** Looks up the registered Ed25519 public key (base64) for a keyid, or null if unknown. */
  lookupPublicKey: (keyid: string) => Promise<string | null> | string | null;
}

/**
 * Server-side counterpart to {@link signRequest}. This is the "live self-defense"
 * layer: it runs before any tool call reaches the policy engine, so a malformed or
 * tampered request never gets a chance to be evaluated as a money action at all —
 * it's rejected at the protocol layer, logged as a `protocol_reject` trace.
 */
export async function verifySignedRequest(input: VerifyRequestInput): Promise<VerifyResult> {
  const { "content-digest": contentDigest, "signature-input": signatureInputHeader, signature } =
    input.headers;

  if (!contentDigest || !signatureInputHeader || !signature) {
    return { valid: false, reason: "missing_headers" };
  }

  let parsed;
  try {
    parsed = parseSignatureInputHeader(signatureInputHeader);
  } catch (err) {
    return { valid: false, reason: "malformed_signature_input", detail: String(err) };
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsed.created) > MAX_CLOCK_SKEW_SECONDS) {
    return { valid: false, reason: "stale_or_future_created" };
  }

  const expectedDigest = computeContentDigest(input.body);
  if (expectedDigest !== contentDigest) {
    return { valid: false, reason: "digest_mismatch" };
  }

  const publicKeyBase64 = await input.lookupPublicKey(parsed.keyid);
  if (!publicKeyBase64) {
    return { valid: false, reason: "unknown_keyid", detail: parsed.keyid };
  }

  const sigMatch = signature.match(/^sig1=:(.+):$/);
  if (!sigMatch) {
    return { valid: false, reason: "malformed_signature_input", detail: "signature header" };
  }

  const base = buildSignatureBase({
    method: input.method,
    path: input.path,
    authority: input.authority,
    contentDigest,
    signatureInputHeaderValue: signatureInputHeader,
  });

  const publicKey = Buffer.from(publicKeyBase64, "base64");
  const signatureBytes = Buffer.from(sigMatch[1], "base64");

  const ok = await ed.verifyAsync(signatureBytes, new TextEncoder().encode(base), publicKey);
  if (!ok) return { valid: false, reason: "bad_signature" };

  return { valid: true, keyid: parsed.keyid };
}
