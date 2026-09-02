import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";

ed.hashes.sha512 = sha512;

/**
 * Mints this agent's identity.
 *
 * Under Web Bot Auth the keypair IS the identity: there is no API key to be
 * issued and no account to be created. The merchant registers the public half
 * and publishes it in their key directory; the private half never leaves here.
 */
const { secretKey, publicKey } = ed.keygen();
console.log("");
console.log("  BUYER_PRIVATE_KEY=" + Buffer.from(secretKey).toString("base64"));
console.log("");
console.log("  public key (give this to the merchant to register):");
console.log("  " + Buffer.from(publicKey).toString("base64"));
console.log("");
console.log("  The merchant returns an agent id. That id is the keyid you sign");
console.log("  with, and goes in BUYER_AGENT_ID.");
console.log("");
