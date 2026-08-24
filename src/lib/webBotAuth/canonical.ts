import { sha256 } from "@noble/hashes/sha2.js";

/**
 * A minimal implementation of the *shape* of RFC 9421 (HTTP Message Signatures),
 * covering the four components Mandate actually needs: @method, @path, @authority,
 * and a content digest. It is not a full implementation of the spec (no support for
 * the rest of the derived-component vocabulary, no signature-agility negotiation).
 *
 * That's a deliberate, documented choice, not an oversight — see HANDOVER.md.
 * Web Bot Auth's own IETF working group has no adopted documents yet (chartered
 * 2026), so there is no single canonical implementation to be fully compatible
 * with. What matters for the pitch is real asymmetric-key request signing with a
 * real verification step and a real key registry, in the RFC 9421 header shape
 * (Signature-Input / Signature / Content-Digest) that Visa's TAP and Mastercard's
 * Agent Pay also build on — not byte-for-byte spec compliance.
 */

export const COVERED_COMPONENTS = ["@method", "@path", "@authority", "content-digest"] as const;

export function computeContentDigest(body: string): string {
  const digest = sha256(new TextEncoder().encode(body));
  return `sha-256=:${Buffer.from(digest).toString("base64")}:`;
}

export interface SignatureParams {
  keyid: string;
  created: number; // unix seconds
  alg: "ed25519";
}

export function buildSignatureInputHeader(params: SignatureParams): string {
  const componentList = COVERED_COMPONENTS.map((c) => `"${c}"`).join(" ");
  return `sig1=(${componentList});created=${params.created};keyid="${params.keyid}";alg="${params.alg}"`;
}

/** Parses a Signature-Input header produced by {@link buildSignatureInputHeader}. */
export function parseSignatureInputHeader(header: string): SignatureParams & { components: string[] } {
  const match = header.match(/^sig1=\(([^)]*)\);(.+)$/);
  if (!match) throw new Error("Malformed Signature-Input header");
  const components = match[1]
    .split(" ")
    .map((c) => c.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);

  const paramsPart = match[2];
  const createdMatch = paramsPart.match(/created=(\d+)/);
  const keyidMatch = paramsPart.match(/keyid="([^"]+)"/);
  const algMatch = paramsPart.match(/alg="([^"]+)"/);
  if (!createdMatch || !keyidMatch || !algMatch) {
    throw new Error("Signature-Input header missing created/keyid/alg");
  }
  if (algMatch[1] !== "ed25519") throw new Error(`Unsupported alg "${algMatch[1]}"`);

  return {
    components,
    created: Number(createdMatch[1]),
    keyid: keyidMatch[1],
    alg: "ed25519",
  };
}

export interface SignatureBaseInput {
  method: string;
  path: string; // pathname + search, e.g. "/api/mcp"
  authority: string; // host header, e.g. "mandate.example.com" or "localhost:3000"
  contentDigest: string;
  signatureInputHeaderValue: string; // everything after "sig1="
}

/** Builds the exact string that gets signed / verified — both sides must produce
 *  byte-identical output or verification fails. */
export function buildSignatureBase(input: SignatureBaseInput): string {
  const sigParamsValue = input.signatureInputHeaderValue.replace(/^sig1=/, "");
  const lines = [
    `"@method": ${input.method.toUpperCase()}`,
    `"@path": ${input.path}`,
    `"@authority": ${input.authority}`,
    `"content-digest": ${input.contentDigest}`,
    `"@signature-params": ${sigParamsValue}`,
  ];
  return lines.join("\n");
}
