import type { z } from "zod";
import type OpenAI from "openai";
import { getLLM } from "@/lib/llm/client";
import type { ToolHub } from "./hub";
import { toOpenAiTool } from "./hub";

/**
 * The language model's place in the system: words, not money.
 *
 * Amounts, quantities, which supplier, whether to act at all are decided by code
 * from the merchant's own records (see src/lib/inventory.ts and the agents). The
 * model writes messages, reads messy replies into structured fields, and drives
 * open-ended research. Everything it returns is validated, and anything it says
 * about money is re-derived from the database before it can matter.
 *
 * Every call degrades: with no model reachable the callers fall back to plain
 * templates, so the loop still runs, just less fluently.
 */

const SENSITIVITY = "internal" as const;

export async function llmAvailable(): Promise<boolean> {
  try {
    await getLLM(SENSITIVITY);
    return true;
  } catch {
    return false;
  }
}

/** Reasoning models wrap their working in tags that must not reach a vendor. */
function clean(text: string | null | undefined): string {
  return (text ?? "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

export async function completeText(system: string, user: string, temperature = 0.4): Promise<string | null> {
  try {
    const llm = await getLLM(SENSITIVITY);
    const res = await llm.client.chat.completions.create({
      model: llm.model,
      temperature,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    const text = clean(res.choices[0]?.message?.content);
    return text || null;
  } catch (err) {
    console.warn("[llm] completeText failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** A model reply parsed into `schema`, or null. Retries once with the error. */
export async function completeJson<T>(schema: z.ZodType<T>, system: string, user: string): Promise<T | null> {
  let llm;
  try {
    llm = await getLLM(SENSITIVITY);
  } catch {
    return null;
  }
  let feedback = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await llm.client.chat.completions.create({
        model: llm.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: `${system}\n\nReply with a single JSON object and nothing else.${feedback}` },
          { role: "user", content: user },
        ],
      });
      const raw = clean(res.choices[0]?.message?.content);
      const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
      const parsed = schema.safeParse(JSON.parse(json));
      if (parsed.success) return parsed.data;
      feedback = `\n\nYour previous reply was invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`;
    } catch (err) {
      feedback = `\n\nYour previous reply could not be parsed as JSON (${err instanceof Error ? err.message : "error"}).`;
    }
  }
  return null;
}

export interface LoopStep {
  kind: "tool" | "text";
  name?: string;
  args?: unknown;
  result?: string;
  isError?: boolean;
}

const MAX_RESULT_CHARS = 6000;

/**
 * A bounded tool-calling loop. The model sees only the tools in `allow`, every
 * result is truncated, and the loop stops at `maxSteps` whatever the model wants.
 */
export async function toolLoop(opts: {
  system: string;
  task: string;
  hub: ToolHub;
  allow: (toolName: string) => boolean;
  maxSteps?: number;
  onStep?: (step: LoopStep) => void;
}): Promise<{ text: string; steps: LoopStep[] }> {
  const llm = await getLLM(SENSITIVITY);
  const tools = opts.hub.list(opts.allow).map(toOpenAiTool);
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.task },
  ];
  const steps: LoopStep[] = [];
  const maxSteps = opts.maxSteps ?? 8;

  for (let i = 0; i < maxSteps; i++) {
    const res = await llm.client.chat.completions.create({
      model: llm.model,
      temperature: 0.2,
      messages,
      tools,
      tool_choice: "auto",
    });
    const msg = res.choices[0]?.message;
    if (!msg) break;
    messages.push(msg as OpenAI.Chat.ChatCompletionMessageParam);

    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) {
      const text = clean(msg.content);
      const step: LoopStep = { kind: "text", result: text };
      steps.push(step);
      opts.onStep?.(step);
      return { text, steps };
    }

    for (const call of calls) {
      if (call.type !== "function") continue;
      let args: Record<string, unknown> = {};
      try {
        args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
      } catch {
        args = {};
      }
      // A tool outside the allow-list is refused even if the model names it:
      // the prompt not containing a tool does not stop a model inventing one.
      const permitted = opts.allow(call.function.name);
      const result = permitted
        ? await opts.hub.call(call.function.name, args)
        : { text: `Tool "${call.function.name}" is not available to you.`, isError: true };
      const text = result.text.length > MAX_RESULT_CHARS ? `${result.text.slice(0, MAX_RESULT_CHARS)}\n[truncated]` : result.text;
      const step: LoopStep = { kind: "tool", name: call.function.name, args, result: text, isError: result.isError };
      steps.push(step);
      opts.onStep?.(step);
      messages.push({ role: "tool", tool_call_id: call.id, content: text });
    }
  }
  return { text: "", steps };
}
