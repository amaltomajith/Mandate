import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

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
 *
 * PROFILES. One process was one agent, reading one `.env`, which made "several
 * independent buyers" impossible to actually run — and several is the whole
 * point, because trust only visibly diverges when different agents behave
 * differently against the same catalog. `--profile <name>` reads
 * `buyer/profiles/<name>.env` instead. Each profile is a separate identity with
 * its own keypair, persona, budget and pace, and nothing is shared between them
 * but the merchant's URL.
 *
 * Paths resolve from this file rather than from `process.cwd()`. `npm --prefix
 * buyer start` and `cd buyer && npm start` do not agree about the working
 * directory, and a config that loads a different file depending on where you
 * typed the command is a debugging afternoon nobody needs.
 */

const buyerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function resolveEnvFile(): { file: string; profile: string | null } {
  const arg = process.argv.slice(2).find((a) => a === "--profile" || a.startsWith("--profile="));
  let profile: string | null = null;
  if (arg) {
    profile = arg.includes("=") ? arg.split("=")[1] : process.argv[process.argv.indexOf(arg) + 1];
    if (!profile || profile.startsWith("--")) {
      throw new Error("--profile needs a name, e.g. --profile ergonomic");
    }
    // A profile name becomes a path segment, so it may not contain one.
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(profile)) {
      throw new Error(`"${profile}" is not a valid profile name (letters, digits, dash, underscore).`);
    }
  }

  const file = profile ? path.join(buyerRoot, "profiles", `${profile}.env`) : path.join(buyerRoot, ".env");
  if (!existsSync(file)) {
    throw new Error(
      profile
        ? `No profile at ${file}.\n` +
          `Create it from buyer/profiles/${profile}.env.example, or mint a fresh identity with:\n` +
          `  npm --prefix buyer run keygen -- --profile ${profile}`
        : `No ${file}. Copy buyer/.env.example to buyer/.env and fill it in — ` +
          `run \`npm --prefix buyer run keygen\` for a keypair.`
    );
  }
  return { file, profile };
}

const { file: envFile, profile } = resolveEnvFile();
dotenv.config({ path: envFile, quiet: true });

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set in ${path.relative(process.cwd(), envFile)}. ` +
        `Run \`npm --prefix buyer run keygen${profile ? ` -- --profile ${profile}` : ""}\` for a keypair.`
    );
  }
  return value;
}

export const config = {
  /** Which profile is running, for the log banner. Two buyers interleaving
   *  output in one terminal are unreadable without it. */
  profile,
  envFile,

  mcpUrl: required("MANDATE_MCP_URL"),
  agentId: required("BUYER_AGENT_ID"),
  privateKey: required("BUYER_PRIVATE_KEY"),
  groqApiKey: process.env.GROQ_API_KEY ?? "",

  /** The catalog and the control channel live beside the MCP endpoint on the
   *  same merchant path. Derived rather than configured separately: three URLs
   *  that can drift apart is three chances to point at the wrong merchant. */
  catalogUrl: required("MANDATE_MCP_URL").replace(/\/mcp$/, "/catalog"),
  controlUrl: required("MANDATE_MCP_URL").replace(/\/mcp$/, "/agent-control"),

  /** Fallback pace when the merchant has not stated one. Their pace_ms wins. */
  paceMs: Number(process.env.BUYER_GAP_MS ?? 30000),

  /**
   * A hard ceiling on actions in one run, independent of everything else.
   *
   * Belt and braces on purpose. The merchant's pace and pause are cooperative,
   * and this agent honours them — but they arrive over a network that can fail,
   * and a runaway loop spending real money must not depend on a remote server
   * being reachable to stop. This bound holds even with the control endpoint
   * down, the catalog empty, and the model looping.
   */
  maxActions: Number(process.env.BUYER_MAX_ACTIONS ?? 20),

  /**
   * Who this buyer is. A persona and a budget, nothing else — the model is
   * asked to reason from these rather than being told what to buy.
   *
   * This is the entire mechanism behind divergent trust. Both decisions the
   * brain makes — what to buy, and whether to accept a counter-offer — reason
   * from these two values, so a frugal persona with a small budget genuinely
   * behaves differently against the same catalog than one buying in bulk.
   */
  persona:
    process.env.BUYER_PERSONA ??
    "You are setting up a home office. You care about ergonomics and about not " +
      "cluttering the desk. You would rather buy one good thing than three cheap ones.",
  budgetPaise: Number(process.env.BUYER_BUDGET_PAISE ?? 1_500_000),

  /**
   * Whether to walk away from a purchase the merchant would escalate.
   *
   * Off by default, because an escalation is not a refusal -- it means a person
   * will decide, and a buyer that wants the item submits it and waits. Turning
   * this on is a persona choice for a buyer with no patience for sign-off, not
   * a safety setting.
   */
  avoidsEscalation: process.env.BUYER_AVOIDS_ESCALATION === "true",
} as const;
