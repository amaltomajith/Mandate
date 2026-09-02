import "dotenv/config";

/**
 * Everything this agent knows about the world.
 *
 * Three secrets and a persona. Deliberately not four: no database URL, no
 * service-role key, no Razorpay secret, no Clerk key. If this file ever needs
 * one of those, the agent has stopped being a third party and the isolation it
 * exists to demonstrate is gone.
 *
 * The merchant is reached at one URL. Everything else about them — what they
 * sell, what it costs, which tools they expose, how to sign — is discovered
 * over HTTP at runtime.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Copy buyer/.env.example to buyer/.env and fill it in — ` +
        `run \`npm --prefix buyer run keygen\` for a keypair.`
    );
  }
  return value;
}

export const config = {
  mcpUrl: required("MANDATE_MCP_URL"),
  agentId: required("BUYER_AGENT_ID"),
  privateKey: required("BUYER_PRIVATE_KEY"),
  groqApiKey: process.env.GROQ_API_KEY ?? "",

  /** The catalog lives beside the MCP endpoint on the same merchant path. */
  catalogUrl: required("MANDATE_MCP_URL").replace(/\/mcp$/, "/catalog"),

  /**
   * Who this buyer is. A persona and a budget, nothing else — the model is
   * asked to reason from these rather than being told what to buy.
   */
  persona:
    process.env.BUYER_PERSONA ??
    "You are setting up a home office. You care about ergonomics and about not " +
      "cluttering the desk. You would rather buy one good thing than three cheap ones.",
  budgetPaise: Number(process.env.BUYER_BUDGET_PAISE ?? 1_500_000),
} as const;
