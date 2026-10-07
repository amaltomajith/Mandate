"use client";

import { useState } from "react";
import type { MerchantSettings, PolicyRule } from "@/types/db";
import type { PolicyIssue } from "@/lib/policy/audit";
import { updateGuardrails } from "@/lib/actions/team";
import { Icons, Panel, PrimaryButton } from "./ui";
import { ErrorLine, Field, inputClass, inputStyle, useRunner } from "./kit";
import { PolicyRulesPanel } from "./PolicyRulesPanel";
import { PolicyHealthPanel } from "./PolicyHealthPanel";

/**
 * Four numbers, in rupees and percent. That is the whole interface for the rules
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

  return (
    <div className="flex flex-col gap-5">
      <Panel title="Your guardrails" icon={<Icons.Shield />} accent="var(--decision-allow)">
        <p className="mb-5 max-w-2xl text-[13px] leading-relaxed" style={{ color: "var(--muted)" }}>
          Your team can only act inside these. They are enforced by the Payment Wall in code, not by the agents&apos; judgement, so no message, email or clever prompt can talk them
          out of it. Anything above the approval amount waits for you.
        </p>
        <ErrorLine error={error} />
        <div className="grid grid-cols-1 gap-x-6 gap-y-5 md:grid-cols-2 xl:grid-cols-3">
          <Field label="Largest single payout (₹)" hint="A hard ceiling. Anything bigger is refused outright.">
            <input className={inputClass} style={inputStyle} inputMode="decimal" value={f.maxSingle} onChange={set("maxSingle")} />
          </Field>
          <Field label="Ask me for payouts of (₹) or more" hint="Below this the team pays on its own; at or above it waits for your approval.">
            <input className={inputClass} style={inputStyle} inputMode="decimal" value={f.approval} onChange={set("approval")} />
          </Field>
          <Field label="Never sell below this margin (%)" hint="Checked against each product's recorded cost, for sales and price drops.">
            <input className={inputClass} style={inputStyle} inputMode="decimal" value={f.margin} onChange={set("margin")} />
          </Field>
          <Field label="Restock budget per week (₹)" hint="The most the team may pay suppliers in a week.">
            <input className={inputClass} style={inputStyle} inputMode="decimal" value={f.weekly} onChange={set("weekly")} />
          </Field>
          <Field label="Spend up to this % of what you sold" hint="Restocking pays for itself: new payouts are funded by sales.">
            <input className={inputClass} style={inputStyle} inputMode="decimal" value={f.pct} onChange={set("pct")} />
          </Field>
          <Field label="Starting float (₹)" hint="What can be spent before any sales have come in.">
            <input className={inputClass} style={inputStyle} inputMode="decimal" value={f.float} onChange={set("float")} />
          </Field>
        </div>
        <label className="mt-5 flex items-start gap-2.5 text-[13px]">
          <input type="checkbox" className="mt-0.5" checked={f.approvedOnly} onChange={set("approvedOnly")} />
          <span>
            Only pay suppliers I have approved
            <span className="block text-[11.5px]" style={{ color: "var(--muted-2)" }}>
              Strongly recommended. With it off, a payee still has to be approved, but its supplier does not.
            </span>
          </span>
        </label>
        <div className="mt-5 flex items-center gap-3">
          <PrimaryButton
            disabled={pending}
            className="px-6"
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
          {saved && <span className="text-[12.5px]" style={{ color: "var(--decision-allow)" }}>Saved. The wall is using these now.</span>}
        </div>
      </Panel>

      <details className="group">
        <summary className="cursor-pointer select-none text-[13px] font-medium" style={{ color: "var(--muted)" }}>
          Advanced: the underlying rules ({rules.filter((x) => x.status === "active").length} active)
        </summary>
        <div className="mt-4 grid grid-cols-1 gap-5 lg:grid-cols-2">
          <PolicyRulesPanel rules={rules} highlightRuleId={highlightRuleId} />
          <PolicyHealthPanel deterministicIssues={deterministicIssues} />
        </div>
      </details>
    </div>
  );
}
