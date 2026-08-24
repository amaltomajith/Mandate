import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import {
  buildSignatureBase,
  buildSignatureInputHeader,
  computeContentDigest,
} from "./canonical";

ed.hashes.sha512 = sha512;

export interface SignRequestInput {
  secretKeyBase64: string;
  keyid: string;
  method: string;
  path: string;
  authority: string;
  body: string;
}

export interface SignedHeaders {
  "content-digest": string;
  "signature-input": string;
  signature: string;
}

/** Used by any MCP client (the demo Checkout Agent, or a third-party agent) to sign
 *  a tool-call request before sending it. Mirrors {@link verifySignedRequest}. */
export function signRequest(input: SignRequestInput): SignedHeaders {
  const contentDigest = computeContentDigest(input.body);
  const created = Math.floor(Date.now() / 1000);
  const signatureInput = buildSignatureInputHeader({ keyid: input.keyid, created, alg: "ed25519" });

  const base = buildSignatureBase({
    method: input.method,
    path: input.path,
    authority: input.authority,
    contentDigest,
    signatureInputHeaderValue: signatureInput,
  });

  const secretKey = Buffer.from(input.secretKeyBase64, "base64");
  const signature = ed.sign(new TextEncoder().encode(base), secretKey);

  return {
    "content-digest": contentDigest,
    "signature-input": signatureInput,
    signature: `sig1=:${Buffer.from(signature).toString("base64")}:`,
  };
}
