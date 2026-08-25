import OpenAI from "openai";

// No `import "server-only"` — this is loaded both by real Next.js server code
// (explain.ts, draftPolicy.ts) and by src/lib/demo/crossSell.ts, which in turn
// is loaded directly by tsx via scripts/checkout-agent.ts. "server-only"
// throws immediately outside Next's server bundling context. Still never
// imported from client components in practice.

let cached: OpenAI | null = null;

/**
 * Groq's chat completions API is OpenAI-compatible, so the `openai` SDK works
 * unmodified pointed at Groq's base URL — no Groq-specific SDK dependency needed.
 * (Swapped in place of Gemini/@google/genai — the free Gemini tier wasn't usable
 * for this build; Groq's free tier serves open-weight models, notably fast.)
 */
export function getLLM(): OpenAI {
  if (cached) return cached;
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not set.");
  cached = new OpenAI({ apiKey, baseURL: "https://api.groq.com/openai/v1" });
  return cached;
}

// `llama-3.3-70b-versatile` (what Groq's own docs listed) 404'd on this
// account — Groq's catalog is account/region-gated in ways their docs don't
// always reflect. Verified live against GET /v1/models with this project's own
// key instead of trusting docs a second time. gpt-oss-120b is a reasoning
// model: it spends tokens on hidden chain-of-thought before `message.content`,
// so callers must NOT cap `max_tokens` low or the real answer gets truncated
// before it's written (see src/lib/mcp/tools/explain.ts and draftPolicy.ts —
// neither sets max_tokens, on purpose).
export const LLM_MODEL = "openai/gpt-oss-120b";
