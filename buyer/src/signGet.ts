import { randomUUID } from "node:crypto";
import * as ed from "@noble/ed25519";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { config } from "./config.js";

ed.hashes.sha512 = sha512;

/**
 * Signing a GET, in one place.
 *
 * The control endpoint and the catalog both need this. The buyer already
 * reimplements the merchant's signature base once by design — an independent
 * implementation is the point of this program, and if the two ever disagree
 * verification fails loudly, which is the second opinion worth having.
 * Reimplementing it a THIRD time inside the same program is not independence,
 * it is duplication, and the copies would drift the first time the base moves.
 */

const COVERED = ["@method", "@path", "@authority", "content-digest"] as const;

export function signGet(url: URL): Record<string, string> {
  // A GET carries no body. The digest covers the empty string, which still
  // binds the signature to this method, path and authority.
  const digest = `sha-256=:${Buffer.from(sha256(new TextEncoder().encode(""))).toString("base64")}:`;
  const created = Math.floor(Date.now() / 1000);
  const sigInput =
    `sig1=(${COVERED.map((c) => `"${c}"`).join(" ")});created=${created};` +
    `keyid="${config.agentId}";alg="ed25519";nonce="${randomUUID()}"`;
  const base = [
    `"@method": GET`,
    `"@path": ${url.pathname + url.search}`,
    `"@authority": ${url.host}`,
    `"content-digest": ${digest}`,
    `"@signature-params": ${sigInput.replace(/^sig1=/, "")}`,
  ].join("\n");
  const signature = ed.sign(new TextEncoder().encode(base), Buffer.from(config.privateKey, "base64"));
  return {
    "content-digest": digest,
    "signature-input": sigInput,
    signature: `sig1=:${Buffer.from(signature).toString("base64")}:`,
  };
}
