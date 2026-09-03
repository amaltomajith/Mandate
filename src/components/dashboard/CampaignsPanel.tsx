"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import {
  previewCampaign,
  launchCampaign,
  listCampaigns,
  reconcile,
  type CampaignPreview,
  type CampaignRow,
  type CampaignRunSummary } from "@/lib/actions/campaigns";
import { formatMoney } from "@/lib/format";
import { EmptyState, GhostButton, Icons, Panel, PrimaryButton, Spinner } from "./ui";
import { TimeAgo } from "./TimeAgo";

const EXAMPLES = [
  "Win back customers who haven't ordered in 30 days",
  "Sell a USB-C hub to people who bought a laptop stand",
  "Reward my highest-spending customers",
];

const SEND_LIMIT = 5;

const STATUS_COLOR: Record<string, string> = {
  offered: "var(--entity-agent)",
  paid: "var(--decision-allow)",
  held: "var(--decision-escalate)",
  refused: "var(--decision-block)",
  expired: "var(--muted-2)",
  pending: "var(--muted-2)",
};

/**
 * The campaign orchestrator, with the merchant in the middle of it.
 *
 * Three deliberate steps rather than one button. A campaign is an agent
 * spending the merchant's money across many customers at once, so the plan —
 * which product, what discount, to whom, up to what total — is the thing being
 * approved. Collapsing propose and run into a single action would make the
 * approval decorative, which is the opposite of what this product argues for.
 *
 * Nothing here is a projection. The segment size is counted from real orders,
 * the discount is computed from the catalog price, and conversion is fetched
 * from Razorpay rather than estimated.
 */
export function CampaignsPanel() {
  const [goal, setGoal] = useState("");
  const [preview, setPreview] = useState<CampaignPreview | null>(null);
  const [budgetRupees, setBudgetRupees] = useState("");
  const [summary, setSummary] = useState<CampaignRunSummary | null>(null);
  const [rows, setRows] = useState<CampaignRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const refresh = useCallback(() => {
    startTransition(async () => {
      try {
        setRows(await listCampaigns());
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't load campaigns.");
      }
    });
  }, []);

  useEffect(() => {
    const id = setTimeout(refresh, 0);
    return () => clearTimeout(id);
  }, [refresh]);

  function propose(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    setError(null);
    setSummary(null);
    setPreview(null);
    startTransition(async () => {
      try {
        const p = await previewCampaign(trimmed);
        setPreview(p);
        setBudgetRupees(String(Math.round(p.suggestedBudgetPaise / 100)));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't plan that campaign.");
      }
    });
  }

  function launch() {
    if (!preview) return;
    setError(null);
    startTransition(async () => {
      try {
        const result = await launchCampaign(
          goal || preview.plan.rationale,
          preview.plan,
          Math.round(Number(budgetRupees) * 100),
          SEND_LIMIT
        );
        setSummary(result);
        setPreview(null);
        setRows(await listCampaigns());
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't launch that campaign.");
      }
    });
  }

  function check(campaignId: string) {
    setError(null);
    startTransition(async () => {
      try {
        await reconcile(campaignId);
        setRows(await listCampaigns());
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't check conversions.");
      }
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <Panel title="Run a campaign" icon={<Icons.Sparkles />} accent="var(--entity-agent)">
        <p className="mb-3 text-xs leading-relaxed" style={{ color: "var(--muted)" }}>
          Say what you want to achieve. The agent picks a product, a discount and which past customers
          to offer it to — then you approve before anything is sent. Every offer goes out as a signed,
          policy-gated payment link, so it can be cleared, held for your approval, or refused.
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            propose(goal);
          }}
          className="flex gap-2"
        >
          <input
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="e.g. win back customers who haven't ordered in a month"
            className="flex-1 rounded-lg border px-3 py-2 text-sm outline-none transition-colors focus:border-[var(--entity-agent)]"
            style={{ borderColor: "var(--panel-border)", background: "var(--panel-2)", color: "var(--foreground)" }}
          />
          <PrimaryButton type="submit" disabled={isPending || !goal.trim()} className="shrink-0 px-4">
            <span className="flex items-center justify-center gap-1.5">
              {isPending && !preview && <Spinner />}
              {isPending && !preview ? "Planning…" : "Plan it"}
            </span>
          </PrimaryButton>
        </form>

        <div className="mt-2 flex flex-wrap gap-1.5">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              onClick={() => {
                setGoal(ex);
                propose(ex);
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
          <p
            className="mt-3 rounded-lg border px-3 py-2 text-xs"
            style={{
              borderColor: "var(--decision-block)",
              color: "var(--decision-block)",
              background: "color-mix(in srgb, var(--decision-block) 14%, transparent)",
            }}
          >
            {error}
          </p>
        )}

        {preview && (
          <div
            className="mt-4 rounded-xl border p-3"
            style={{ borderColor: "var(--entity-agent)", background: "color-mix(in srgb, var(--entity-agent) 7%, transparent)" }}
          >
            <p className="text-[13px] font-semibold">{preview.plan.name}</p>
            <p className="mt-0.5 text-[11px] leading-snug" style={{ color: "var(--muted)" }}>
              {preview.plan.rationale}
            </p>

            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Fact label="Offer" value={`${preview.plan.discountPct}% off`} sub={preview.plan.item.name} />
              <Fact
                label="Each customer pays"
                value={formatMoney(preview.plan.unitChargePaise, "INR")}
                sub={`was ${formatMoney(preview.plan.unitPricePaise, "INR")}`}
              />
              <Fact
                label="You give up"
                value={formatMoney(preview.plan.unitDiscountPaise, "INR")}
                sub="per order"
              />
              <Fact label="Audience" value={String(preview.segmentSize)} sub="customers matched" />
            </div>

            <p className="mt-2.5 text-[11px]" style={{ color: "var(--muted)" }}>
              {preview.segmentDescription}.
            </p>

            {preview.unattributableOrders > 0 && (
              <p className="mt-1 text-[10.5px] leading-snug" style={{ color: "var(--muted-2)" }}>
                {preview.unattributableOrders} older order
                {preview.unattributableOrders === 1 ? "" : "s"} could not be matched to a customer, so
                nobody behind {preview.unattributableOrders === 1 ? "it" : "them"} is reachable by this
                campaign.
              </p>
            )}

            {preview.segmentSize === 0 && (
              <p
                className="mt-3 rounded-lg border px-3 py-2 text-[11px] leading-snug"
                style={{
                  borderColor: "var(--decision-escalate)",
                  color: "var(--decision-escalate)",
                  background: "color-mix(in srgb, var(--decision-escalate) 12%, transparent)",
                }}
              >
                Nobody matches this yet, so there is nothing to send. Try a wider goal — or let more
                orders accumulate, since the audience is built from purchase history.
              </p>
            )}

            <div className="mt-3 flex flex-wrap items-end gap-3 border-t pt-3" style={{ borderColor: "var(--panel-border)" }}>
              <label className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--muted-2)" }}>
                Budget (₹)
                <input
                  value={budgetRupees}
                  onChange={(e) => setBudgetRupees(e.target.value.replace(/[^0-9]/g, ""))}
                  inputMode="numeric"
                  className="mt-1 block w-28 rounded-lg border px-2 py-1.5 text-sm tabular-nums outline-none"
                  style={{ borderColor: "var(--panel-border)", background: "var(--panel-2)", color: "var(--foreground)" }}
                />
              </label>
              <p className="flex-1 text-[10.5px] leading-snug" style={{ color: "var(--muted-2)" }}>
                A ceiling on what you give away, not on what customers pay. The run stops when the next
                offer would cross it. At most {SEND_LIMIT} offers go out per run.
              </p>
              <PrimaryButton
                onClick={launch}
                disabled={isPending || !budgetRupees || preview.segmentSize === 0}
                className="shrink-0 px-4"
              >
                <span className="flex items-center justify-center gap-1.5">
                  {isPending && <Spinner />}
                  {isPending ? "Sending…" : "Approve and send"}
                </span>
              </PrimaryButton>
            </div>
          </div>
        )}

        {summary && (
          <div className="mt-4 border-t pt-3" style={{ borderColor: "var(--panel-border)" }}>
            <p className="text-[12px] font-medium">{summary.campaign.name}</p>
            <p className="mt-0.5 text-[11px]" style={{ color: "var(--muted)" }}>
              {summary.description}
            </p>
            <div className="mt-2 space-y-1.5">
              {summary.result.sent.map((s) => (
                <div key={s.customerId} className="flex items-start gap-2.5 rounded-lg px-2.5 py-2" style={{ background: "var(--panel-2)" }}>
                  <span
                    className="mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide"
                    style={{
                      background: `${STATUS_COLOR[s.decision === "allow" ? "offered" : s.decision === "escalate" ? "held" : "refused"]}26`,
                      color: STATUS_COLOR[s.decision === "allow" ? "offered" : s.decision === "escalate" ? "held" : "refused"],
                    }}
                  >
                    {s.decision === "allow" ? "Sent" : s.decision === "escalate" ? "Held" : "Refused"}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="truncate text-[12px] font-medium">{s.customerName}</p>
                      <p className="shrink-0 text-[12px] font-semibold tabular-nums">
                        {formatMoney(s.amountPaise, "INR")}
                      </p>
                    </div>
                    <p className="mt-0.5 truncate text-[10px]" style={{ color: "var(--muted-2)" }}>
                      {s.paymentLinkUrl ?? s.reasoning}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Panel>

      <Panel
        title="Campaigns"
        icon={<Icons.CheckCircle />}
        accent="var(--decision-allow)"
        action={
          <GhostButton onClick={refresh} disabled={isPending} className="py-1! px-2.5! text-[10px]!">
            {isPending ? "…" : "Refresh"}
          </GhostButton>
        }
      >
        {!rows || rows.length === 0 ? (
          <EmptyState text="No campaigns yet. Plan one above." />
        ) : (
          <div className="space-y-2.5">
            {rows.map(({ campaign, targets, committedPaise, paid, revenuePaise }) => (
              <div key={campaign.id} className="rounded-xl border p-2.5" style={{ borderColor: "var(--panel-border)", background: "var(--panel-2)" }}>
                <div className="flex items-baseline justify-between gap-2">
                  <p className="truncate text-[12px] font-semibold">{campaign.name}</p>
                  <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide" style={{ color: "var(--muted-2)" }}>
                    {campaign.status}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-[10.5px]" style={{ color: "var(--muted-2)" }}>
                  {campaign.goal} · <TimeAgo iso={campaign.created_at} />
                </p>

                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
                  <span>
                    <strong className="tabular-nums">{targets.length}</strong> offered
                  </span>
                  <span style={{ color: "var(--decision-allow)" }}>
                    <strong className="tabular-nums">{paid}</strong> paid
                  </span>
                  <span className="tabular-nums" style={{ color: "var(--muted)" }}>
                    {formatMoney(revenuePaise, "INR")} in
                  </span>
                  <span className="tabular-nums" style={{ color: "var(--muted-2)" }}>
                    {formatMoney(committedPaise, "INR")} of {formatMoney(campaign.budget_paise, "INR")} given up
                  </span>
                  <GhostButton onClick={() => check(campaign.id)} disabled={isPending} className="ml-auto py-1! px-2.5! text-[10px]!">
                    Check conversions
                  </GhostButton>
                </div>

                {paid === 0 && targets.length > 0 && (
                  <p className="mt-1.5 text-[10px] leading-snug" style={{ color: "var(--muted-2)" }}>
                    Nothing paid yet. In test mode a link only reaches &ldquo;paid&rdquo; when someone opens
                    it and pays with a test card — this reads 0% until they do, and the figure is fetched
                    from Razorpay rather than estimated.
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

function Fact({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div>
      <p className="text-[9.5px] font-semibold uppercase tracking-wider" style={{ color: "var(--muted-2)" }}>
        {label}
      </p>
      <p className="mt-0.5 text-[14px] font-semibold tabular-nums">{value}</p>
      <p className="truncate text-[9.5px]" style={{ color: "var(--muted-2)" }}>
        {sub}
      </p>
    </div>
  );
}
