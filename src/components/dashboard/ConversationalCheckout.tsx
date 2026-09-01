"use client";

import { useState, useTransition } from "react";
import { buyFromRequest, type CheckoutResult, type CheckoutStep } from "@/lib/actions/checkout";
import { formatMoney } from "@/lib/format";
import { GhostButton, Icons, Panel, PrimaryButton, Spinner } from "./ui";

const STATUS_COLOR: Record<CheckoutStep["status"], string> = {
  ok: "var(--decision-allow)",
  escalated: "var(--decision-escalate)",
  blocked: "var(--decision-block)",
  info: "var(--entity-agent)",
};

const STATUS_LABEL: Record<CheckoutStep["status"], string> = {
  ok: "Bought",
  escalated: "Held",
  blocked: "Refused",
  info: "Agent",
};

/** Asks chosen because they land on genuinely different outcomes against the
 *  real catalog: one cheap enough to clear, one over the approval threshold,
 *  one that tests whether the agent respects the shopper's own budget rather
 *  than only the merchant's rules, and one that requires actually reading the
 *  product descriptions rather than keyword-matching a name.
 *
 *  Deliberately no "buy me some crypto" here, tempting as a banned-category
 *  demo is: there is no crypto in the catalog, so the agent correctly declines
 *  before policy is ever consulted, and the chip would demonstrate nothing
 *  about the category rule. An example that misrepresents which mechanism
 *  fired is worse than one fewer example. */
const EXAMPLES = [
  "I need a mouse for my desk setup",
  "get me the standing desk",
  "a keyboard under ₹2,000",
  "something to improve my posture",
];

/**
 * A person says what they want; an agent buys it.
 *
 * This is the same governed path everything else takes — a signed MCP call
 * through `enforce_action` — so the purchase can be cleared, held for
 * approval, or refused, and it lands in the same audit trail. The only
 * difference from the simulated traffic is who started it.
 *
 * Shows each step rather than just the outcome, because the interesting part
 * is not that something was bought: it's watching an agent be told no, and
 * then recover the sale by finding what it *is* allowed to sell.
 */
export function ConversationalCheckout() {
  const [request, setRequest] = useState("");
  const [result, setResult] = useState<CheckoutResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    setError(null);
    setResult(null);
    startTransition(async () => {
      try {
        setResult(await buyFromRequest(trimmed));
      } catch (err) {
        setError(err instanceof Error ? err.message : "The agent couldn't complete that.");
      }
    });
  }

  return (
    <Panel title="Buy something" icon={<Icons.Sparkles />} accent="var(--decision-allow)">
      <p className="mb-3 text-xs leading-relaxed" style={{ color: "var(--muted)" }}>
        Say what you want in plain language. An AI agent picks it from the catalog and buys it — through
        the same signed, policy-gated path every other agent uses, so it can be cleared, held for your
        approval, or refused.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(request);
        }}
        className="flex gap-2"
      >
        <input
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          placeholder="e.g. I need a mouse for my desk setup"
          className="flex-1 rounded-lg border px-3 py-2 text-sm outline-none transition-colors focus:border-[var(--decision-allow)]"
          style={{ borderColor: "var(--panel-border)", background: "var(--panel-2)", color: "var(--foreground)" }}
        />
        <PrimaryButton type="submit" disabled={isPending || !request.trim()} className="shrink-0 px-4">
          <span className="flex items-center justify-center gap-1.5">
            {isPending && <Spinner />}
            {isPending ? "Buying…" : "Buy"}
          </span>
        </PrimaryButton>
      </form>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            onClick={() => {
              setRequest(ex);
              submit(ex);
            }}
            disabled={isPending}
            className="rounded-full px-2.5 py-1 text-[11px] transition-colors hover:brightness-125 disabled:opacity-50"
            style={{ background: "var(--panel-2)", color: "var(--muted)" }}
          >
            {ex}
          </button>
        ))}
      </div>

      {error && (
        <p className="mt-3 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: "var(--decision-block)", color: "var(--decision-block)", background: "color-mix(in srgb, var(--decision-block) 14%, transparent)" }}>
          {error}
        </p>
      )}

      {result && (
        <div className="mt-4 space-y-1.5 border-t pt-3" style={{ borderColor: "var(--panel-border)" }}>
          {result.steps.map((step, i) => {
            const color = STATUS_COLOR[step.status];
            return (
              <div key={i} className="flex items-start gap-2.5 rounded-lg px-2 py-1.5" style={{ background: "var(--panel-2)" }}>
                <span
                  className="mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide"
                  style={{ background: `${color}26`, color }}
                >
                  {STATUS_LABEL[step.status]}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[12px] font-medium">{step.label}</p>
                  <p className="text-[11px] leading-snug" style={{ color: "var(--muted)" }}>
                    {step.detail}
                  </p>
                </div>
              </div>
            );
          })}

          {result.alternative && (
            <div
              className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-dashed px-3 py-2"
              style={{ borderColor: "var(--decision-allow)" }}
            >
              <p className="min-w-0 flex-1 text-[11px]" style={{ color: "var(--muted)" }}>
                <span className="font-semibold" style={{ color: "var(--decision-allow)" }}>
                  {result.alternative.name}
                </span>{" "}
                · {formatMoney(result.alternative.amountPaise, "INR")} — {result.alternative.reason}.
              </p>
              <GhostButton
                onClick={() => submit(`buy the ${result.alternative!.name}`)}
                disabled={isPending}
                className="shrink-0 px-3 py-1! text-[11px]!"
              >
                Buy that instead
              </GhostButton>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
