import "server-only";
import OpenAI from "openai";

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

// Verified against console.groq.com/docs/models — exact production model IDs.
export const LLM_MODEL = "llama-3.3-70b-versatile";
