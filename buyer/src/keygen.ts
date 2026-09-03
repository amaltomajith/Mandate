import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";

ed.hashes.sha512 = sha512;

/**
 * Mints this agent's identity.
 *
 * Under Web Bot Auth the keypair IS the identity: there is no API key to be
 * issued and no account to be created. The merchant registers the public half
 * and publishes it in their key directory; the private half never leaves here.
 *
 * With `--profile <name>` it also prints a ready-to-save profile file, because
 * running three buyers means doing this three times and the step people get
 * wrong is pasting the private key where the public one belongs. Printing both
 * halves labelled, in the shape they each go into, removes the guess.
 *
 *   npm --prefix buyer run keygen
 *   npm --prefix buyer run keygen -- --profile ergonomic
 */

const args = process.argv.slice(2);
const profileArg = args.find((a) => a === "--profile" || a.startsWith("--profile="));
const profile = profileArg
  ? profileArg.includes("=")
    ? profileArg.split("=")[1]
    : args[args.indexOf(profileArg) + 1]
  : null;

const { secretKey, publicKey } = ed.keygen();
const priv = Buffer.from(secretKey).toString("base64");
const pub = Buffer.from(publicKey).toString("base64");

console.log("");
console.log("  ┌─ STEP 1 ─ give the merchant the PUBLIC half ─────────────────");
console.log("  │");
console.log("  │  " + pub);
console.log("  │");
console.log("  │  Dashboard -> Agents -> Register an agent. Paste it into the");
console.log("  │  public key field. The merchant hands back an agent id.");
console.log("  └──────────────────────────────────────────────────────────────");
console.log("");

if (profile) {
  console.log(`  ┌─ STEP 2 ─ save as buyer/profiles/${profile}.env ${"─".repeat(Math.max(0, 24 - profile.length))}`);
  console.log("  │");
  console.log("  │  MANDATE_MCP_URL=http://localhost:3000/api/m/<merchant-slug>/mcp");
  console.log("  │  BUYER_AGENT_ID=<the id the dashboard gave you>");
  console.log("  │  BUYER_PRIVATE_KEY=" + priv);
  console.log("  │  BUYER_PERSONA=<who this buyer is, in a sentence or two>");
  console.log("  │  BUYER_BUDGET_PAISE=1500000");
  console.log("  │  BUYER_GAP_MS=30000");
  console.log("  │  BUYER_MAX_ACTIONS=20");
  console.log("  │  GROQ_API_KEY=<your key>");
  console.log("  │");
  console.log(`  │  Then: npm --prefix buyer start -- --profile ${profile}`);
  console.log("  └──────────────────────────────────────────────────────────────");
} else {
  console.log("  ┌─ STEP 2 ─ save as buyer/.env ────────────────────────────────");
  console.log("  │");
  console.log("  │  BUYER_PRIVATE_KEY=" + priv);
  console.log("  │  BUYER_AGENT_ID=<the id the dashboard gave you>");
  console.log("  │");
  console.log("  │  For several buyers side by side, re-run this with");
  console.log("  │  --profile <name> and see buyer/README.md.");
  console.log("  └──────────────────────────────────────────────────────────────");
}
console.log("");
console.log("  The private half is printed once and stored nowhere else. It never");
console.log("  goes to the merchant — they only ever see the public half.");
console.log("");
