"use client";

import { useState, type ReactNode } from "react";
import { CaretDown, ShieldCheck, ShieldWarning } from "@phosphor-icons/react";
import type { MerchantSettings, PolicyRule } from "@/types/db";
import type { PolicyIssue } from "@/lib/policy/audit";
import { updateGuardrails } from "@/lib/actions/team";
import { PrimaryButton } from "./ui";
import { ErrorLine, inputClass, inputStyle, useRunner } from "./kit";
import { Reveal } from "./motion";
import { PolicyRulesPanel } from "./PolicyRulesPanel";
import { PolicyHealthPanel } from "./PolicyHealthPanel";

const money = (v: string) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}` : "that amount";
};

/**
 * Six numbers, in rupees and percent. That is the whole interface for the rules
 * that stand between the team and the merchant's money. Each save rewrites the
 * matching rules for the Payment Wall; the raw rules are below for anyone who
 * wants to read or tune them directly.
 */
export function GuardrailsTab({
  settings,
  rules,
  deterministicIssues,
  highlightRuleId,
}: {
  settings: MerchantSettings;
  rules: PolicyRule[];
  deterministicIssues: PolicyIssue[];
  highlightRuleId: string | null;
}) {
  const { error, pending, run } = useRunner();
  const [saved, setSaved] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const r = (paise: number) => String(Number(paise) / 100);
  const [f, setF] = useState({
    maxSingle: r(settings.max_single_payout_paise),
    approval: r(settings.approval_threshold_paise),
    margin: String(settings.min_margin_bps / 100),
    weekly: r(settings.weekly_payout_budget_paise),
    pct: String(settings.payout_budget_pct),
    float: r(settings.starting_float_paise),
    approvedOnly: settings.require_approved_vendors,
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setSaved(false);
    setF({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  };

  const activeRules = rules.filter((x) => x.status === "active").length;
  const healthy = deterministicIssues.length === 0;
  // A jump from Activity to a specific rule must show it, so open the advanced section then.
  const open = advancedOpen || highlightRuleId !== null;

  const cards: { key: keyof typeof f; title: string; unit: "rupee" | "percent"; hint: string; preview: string }[] = [
    { key: "maxSingle", title: "Largest single payout", unit: "rupee", hint: "A hard ceiling. Anything bigger is refused outright.", preview: `A payout over ${money(f.maxSingle)} is refused.` },
    { key: "approval", title: "Ask me for payouts of", unit: "rupee", hint: "Below this the team pays on its own; at or above it waits for you.", preview: `A payout of ${money(f.approval)} or more waits for your approval.` },
    { key: "margin", title: "Never sell below this margin", unit: "percent", hint: "Checked against each product's cost, for sales and price drops.", preview: `Nothing sells for less than ${f.margin || "0"}% over what it cost.` },
    { key: "weekly", title: "Restock budget per week", unit: "rupee", hint: "The most the team may pay suppliers in a week.", preview: `At most ${money(f.weekly)} goes to suppliers in a week.` },
    { key: "pct", title: "Spend up to this share of sales", unit: "percent", hint: "Restocking pays for itself: new payouts are funded by sales.", preview: `Payouts stay within ${f.pct || "0"}% of what you have sold.` },
    { key: "float", title: "Starting float", unit: "rupee", hint: "What can be spent before any sales have come in.", preview: `${money(f.float)} may be spent before the first sale.` },
  ];

  return (
    <div className="flex flex-col gap-8">
      <Reveal>
        <section className="surface flex flex-wrap items-center gap-6 p-8">
          <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-[18px]" style={{ background: `color-mix(in srgb, ${healthy ? "var(--decision-allow)" : "var(--decision-escalate)"} 16%, transparent)`, color: healthy ? "var(--decision-allow)" : "var(--decision-escalate)" }}>
            {healthy ? <ShieldCheck size={34} weight="fill" /> : <ShieldWarning size={34} weight="fill" />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[24px] font-semibold leading-[30px] tracking-tight">{healthy ? "The Payment Wall is protecting you" : `${deterministicIssues.length} thing${deterministicIssues.length === 1 ? "" : "s"} to look at`}</p>
            <p className="mt-1.5 max-w-2xl text-[15px] leading-6" style={{ color: "var(--muted)" }}>
              Your team can only act inside these limits. The Payment Wall enforces them in code, not by the agents&apos; judgement, so no message, email or clever prompt can talk them out of it.
            </p>
          </div>
          <p className="num text-[14px]" style={{ color: "var(--muted)" }}>
            {activeRules} active rules
          </p>
        </section>
      </Reveal>

      <ErrorLine error={error} />

      <section className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3" aria-label="Limits">
        {cards.map((c, idx) => (
          <Reveal key={c.key} index={idx} className="h-full">
            <LimitCard title={c.title} hint={c.hint} preview={c.preview}>
              <div className="relative">
                {c.unit === "rupee" && <span className="num pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[24px]" style={{ color: "var(--muted-2)" }}>₹</span>}
                <input
                  aria-label={c.title}
                  className={`${inputClass} num !min-h-[60px] !text-[26px] !font-semibold ${c.unit === "rupee" ? "!pl-10" : "!pr-12"}`}
                  style={inputStyle}
                  inputMode="decimal"
                  value={f[c.key] as string}
                  onChange={set(c.key)}
                />
                {c.unit === "percent" && <span className="num pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[22px]" style={{ color: "var(--muted-2)" }}>%</span>}
              </div>
            </LimitCard>
          </Reveal>
        ))}
      </section>

      <section className="surface flex flex-wrap items-center justify-between gap-6 p-7">
        <label className="flex max-w-2xl cursor-pointer items-start gap-4">
          <input type="checkbox" className="mt-1.5 h-5 w-5 accent-[#7c5cff]" checked={f.approvedOnly} onChange={set("approvedOnly")} />
          <span className="text-[16px] font-medium leading-6">
            Only pay suppliers I have approved
            <span className="mt-1 block text-[14px] font-normal leading-6" style={{ color: "var(--muted)" }}>
              Strongly recommended. With it off, a payee still has to be approved, but its supplier does not.
            </span>
          </span>
        </label>
        <div className="flex items-center gap-4">
          {saved && (
            <span className="text-[14px]" style={{ color: "var(--decision-allow)" }}>
              Saved. The wall is using these now.
            </span>
          )}
          <PrimaryButton
            disabled={pending}
            className="px-7"
            onClick={() =>
              run(async () => {
                await updateGuardrails({
                  maxSinglePayoutRupees: parseFloat(f.maxSingle),
                  approvalThresholdRupees: parseFloat(f.approval),
                  minMarginPercent: parseFloat(f.margin),
                  weeklyBudgetRupees: parseFloat(f.weekly),
                  budgetPercentOfRevenue: parseFloat(f.pct),
                  startingFloatRupees: parseFloat(f.float),
                  requireApprovedVendors: f.approvedOnly,
                });
                setSaved(true);
              })
            }
          >
            {pending ? "Saving…" : "Save guardrails"}
          </PrimaryButton>
        </div>
      </section>

      <section className="surface overflow-hidden">
        <button type="button" onClick={() => setAdvancedOpen((v) => !v)} aria-expanded={open} className="focus-ring flex w-full items-center justify-between gap-4 px-7 py-6 text-left">
          <span>
            <span className="block text-[17px] font-semibold tracking-[-0.01em]">Advanced: the underlying rules</span>
            <span className="mt-0.5 block text-[14px]" style={{ color: "var(--muted)" }}>
              {activeRules} active. Read them, or tune them directly.
            </span>
          </span>
          <CaretDown size={18} style={{ color: "var(--muted)", transform: open ? "rotate(180deg)" : "none", transition: "transform 0.3s var(--ease-out)" }} />
        </button>
        {open && (
          <div className="grid grid-cols-1 gap-6 border-t p-6 lg:grid-cols-2" style={{ borderColor: "var(--hairline)" }}>
            <PolicyRulesPanel rules={rules} highlightRuleId={highlightRuleId} />
            <PolicyHealthPanel deterministicIssues={deterministicIssues} />
          </div>
        )}
      </section>
    </div>
  );
}

function LimitCard({ title, hint, preview, children }: { title: string; hint: string; preview: string; children: ReactNode }) {
  return (
    <div className="surface flex h-full flex-col p-6">
      <p className="text-[16px] font-semibold tracking-[-0.01em]">{title}</p>
      <p className="mb-5 mt-1 text-[14px] leading-5" style={{ color: "var(--muted)" }}>
        {hint}
      </p>
      <div className="mt-auto">
        {children}
        <p className="mt-4 rounded-[12px] bg-white/[0.04] px-4 py-3 text-[14px] leading-5" style={{ color: "var(--foreground)" }}>
          {preview}
        </p>
      </div>
    </div>
  );
}
