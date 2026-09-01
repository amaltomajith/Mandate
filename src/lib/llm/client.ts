import OpenAI from "openai";

// No `import "server-only"` — this is loaded both by real Next.js server code
// (explain.ts, draftPolicy.ts) and by src/lib/demo/crossSell.ts, which is also
// loaded directly by tsx from scripts. "server-only" throws immediately outside
// Next's server bundling context. Still never imported from client components.

/**
 * Where a prompt is allowed to be sent.
 *
 * Mandate's whole argument is that money actions should be bounded and the
 * bound should be visible. It was not applying that to itself: the semantic
 * policy audit posts every active rule — every cap, every threshold, every
 * blocked category — to a third-party API, which is precisely the map
 * `/api/catalog` deliberately withholds from the public because it would let
 * an adversary structure underneath it. Publishing it to no one and shipping
 * it to Groq are not the same decision, and the product was making both.
 *
 * So egress is classified per call site rather than left to whichever provider
 * happens to be configured:
 *
 * - `public`   Nothing in the prompt that isn't already served unauthenticated.
 *              The catalog and a shopper's own sentence qualify; both are
 *              readable at /api/catalog by anyone. Safe to send anywhere.
 *
 * - `internal` The merchant's policy configuration, a customer identifier, or
 *              a trace's full parameters. Under the default `auto` provider
 *              these never leave the machine: if no local model is reachable
 *              the call fails rather than falling back, because a fallback that
 *              silently ships the policy set off-box would make the
 *              classification decorative. Setting LLM_PROVIDER=groq overrides
 *              this deliberately and says so in the log — the guard is against
 *              accidents, not against a choice someone made on purpose.
 */
export type Sensitivity = "public" | "internal";

export interface Llm {
  client: OpenAI;
  model: string;
  provider: "local" | "groq";
}

/** Thrown when an `internal` call has nowhere local to run. Callers already
 *  treat an LLM failure as "no answer" and degrade to their deterministic
 *  path, so this needs no special handling — but it is a distinct type so the
 *  UI can say "local inference is not running" instead of a generic error. */
export class LocalInferenceUnavailable extends Error {
  constructor(url: string) {
    super(
      `No local model is reachable at ${url}, and this call handles merchant policy ` +
        `data that must not leave the machine. Start Ollama (\`ollama serve\`) or set ` +
        `LLM_PROVIDER=groq to explicitly accept off-box inference.`
    );
    this.name = "LocalInferenceUnavailable";
  }
}

function localUrl(): string {
  return process.env.OLLAMA_URL ?? "http://localhost:11434/v1";
}

/**
 * Ollama's OpenAI-compatible endpoint speaks enough of the API that the
 * `openai` SDK works against it unmodified: `messages`, `temperature`,
 * `response_format` (JSON mode), `max_tokens` and `seed` are all supported,
 * which covers every call this codebase makes. Their docs do flag the
 * compatibility layer as experimental, so the native client stays the escape
 * hatch if it ever drifts — but going through the OpenAI SDK means one client
 * type for both providers and no branching at the call sites.
 *
 * The API key is a placeholder Ollama ignores; the SDK requires the field.
 * `maxRetries: 0` because a local model that just failed is not going to
 * succeed on an immediate retry — it is either not running or out of memory,
 * and both want the caller's fallback, not a stall.
 */
const LOCAL_MODEL = process.env.LOCAL_LLM_MODEL ?? "granite4";

// `llama-3.3-70b-versatile` (what Groq's own docs listed) 404'd on this
// account — Groq's catalog is account/region-gated in ways their docs don't
// always reflect. Verified live against GET /v1/models with this project's own
// key instead of trusting docs a second time. gpt-oss-120b is a reasoning
// model: it spends tokens on hidden chain-of-thought before `message.content`,
// so callers must NOT cap `max_tokens` low or the real answer gets truncated
// before it's written.
const GROQ_MODEL = "openai/gpt-oss-120b";

let localClient: OpenAI | null = null;
let groqClient: OpenAI | null = null;

function local(): Llm {
  localClient ??= new OpenAI({
    apiKey: "ollama",
    baseURL: localUrl(),
    maxRetries: 0,
    timeout: 120_000,
  });
  return { client: localClient, model: LOCAL_MODEL, provider: "local" };
}

function groq(): Llm {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not set.");
  groqClient ??= new OpenAI({ apiKey, baseURL: "https://api.groq.com/openai/v1" });
  return { client: groqClient, model: GROQ_MODEL, provider: "groq" };
}

/**
 * Reachability, cached briefly.
 *
 * Probing before every call would add a round trip to work that is already the
 * slowest thing on the page; never probing would mean a dead Ollama shows up
 * as a 120-second hang instead of an immediate fallback. Thirty seconds is
 * short enough that starting Ollama mid-session is noticed without being
 * asked about constantly.
 */
let probe: { at: number; ok: boolean } | null = null;
const PROBE_TTL_MS = 30_000;

export async function localAvailable(force = false): Promise<boolean> {
  if (!force && probe && Date.now() - probe.at < PROBE_TTL_MS) return probe.ok;
  let ok = false;
  try {
    const res = await fetch(`${localUrl()}/models`, {
      signal: AbortSignal.timeout(2_000),
    });
    ok = res.ok;
  } catch {
    ok = false;
  }
  probe = { at: Date.now(), ok };
  return ok;
}

let warnedEgress = false;
function warnExplicitEgress() {
  if (warnedEgress) return;
  warnedEgress = true;
  console.warn(
    "[llm] LLM_PROVIDER=groq is set, so policy-sensitive prompts (rules, thresholds, " +
      "trace params) are being sent off-box. This is an explicit configuration, not a " +
      "default — unset LLM_PROVIDER and run Ollama to keep them local."
  );
}

/**
 * Pick a provider for a call of the given sensitivity.
 *
 * LLM_PROVIDER pins it: `local` never leaves the machine at all and fails if
 * nothing is running, `groq` is the old behaviour and warns once when internal
 * data goes off-box, and the default `auto` prefers local and falls back to
 * Groq only for prompts that carry nothing private.
 */
export async function getLLM(sensitivity: Sensitivity): Promise<Llm> {
  const pinned = process.env.LLM_PROVIDER;

  if (pinned === "local") {
    if (!(await localAvailable())) throw new LocalInferenceUnavailable(localUrl());
    return local();
  }

  // An explicit pin is a deliberate choice and is honoured, including for
  // internal work — the classification exists to stop policy data leaving the
  // machine *by accident*, not to overrule someone who configured it on
  // purpose. It says so in the log, once, rather than silently: a deployment
  // that opted in should be able to see that it did.
  if (pinned === "groq") {
    if (sensitivity === "internal") warnExplicitEgress();
    return groq();
  }

  if (await localAvailable()) return local();
  if (sensitivity === "internal") throw new LocalInferenceUnavailable(localUrl());
  return groq();
}

/** Which provider a call of this sensitivity would use right now, for display.
 *  Never throws — the dashboard asks this to render a status line, and a
 *  status line that can crash the page is worse than one that says "none". */
export async function currentProvider(sensitivity: Sensitivity): Promise<"local" | "groq" | "none"> {
  try {
    return (await getLLM(sensitivity)).provider;
  } catch {
    return "none";
  }
}
