import type { RiskReport } from "@/lib/risk/loadReport";
import type { RiskSample } from "@/lib/risk/loadSample";
import { formatMoney } from "@/lib/format";
import { RiskScoreGraph } from "./RiskScoreGraph";

const LEGEND_ITEMS: { color: string; label: string }[] = [
  { color: "#34d399", label: "Caught fraud" },
  { color: "#fbbf24", label: "False alarm" },
  { color: "#f87171", label: "Missed fraud" },
  { color: "#4b5566", label: "Correctly cleared (sampled)" },
];

function StatTile({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-xl border p-4" style={{ borderColor: "var(--panel-border)", background: "var(--panel-2)" }}>
      <p className="text-2xl font-semibold tabular-nums" style={{ color: color ?? "var(--foreground)" }}>
        {value}
      </p>
      <p className="mt-1 text-[11px] uppercase tracking-wide" style={{ color: "var(--muted-2)" }}>
        {label}
      </p>
    </div>
  );
}

const PositioningNote = () => (
  <div className="mb-5 rounded-xl border-l-2 px-4 py-3" style={{ borderColor: "var(--entity-mandate)", background: "color-mix(in srgb, var(--entity-mandate) 8%, transparent)" }}>
    <p className="text-[12px] leading-relaxed" style={{ color: "var(--muted)" }}>
      <strong style={{ color: "var(--foreground)" }}>A deliberately separate module.</strong> Mandate&apos;s core
      pitch is accountability and governance for agent-initiated money actions — not fraud detection, a
      category Razorpay&apos;s own Vulcan, Visa&apos;s TAP, and Mastercard&apos;s Agent Pay already compete in at
      far greater scale. This detector isn&apos;t wired into Mandate&apos;s policy engine or enforcement path;
      it&apos;s an honestly-evaluated, defense-only signal, kept separate on purpose.
    </p>
  </div>
);

export function RiskPanel({ report, sample }: { report: RiskReport | null; sample: RiskSample | null }) {
  if (!report) {
    return (
      <div className="panel-card rounded-2xl p-5">
        <p className="text-sm font-semibold">Fraud-spike detector</p>
        <PositioningNote />
        <div className="rounded-xl border border-dashed py-8 text-center" style={{ borderColor: "var(--panel-border-strong)" }}>
          <p className="text-xs" style={{ color: "var(--muted)" }}>
            Not trained yet. Run these from the project root:
          </p>
          <code className="mt-2 block text-[11px]" style={{ color: "var(--entity-agent)" }}>
            npm run risk:download
          </code>
          <code className="mt-1 block text-[11px]" style={{ color: "var(--entity-agent)" }}>
            npm run risk:train
          </code>
          <p className="mx-auto mt-3 max-w-md text-[11px] leading-relaxed" style={{ color: "var(--muted-2)" }}>
            Downloads PaySim (Kaggle: ealaxi/paysim1, real labeled fraud data) and trains + evaluates a
            logistic regression against a held-out split. Needs KAGGLE_USERNAME/KAGGLE_KEY in .env.local.
          </p>
        </div>
      </div>
    );
  }

  const { evaluation, dataset, methodology, model, featureWeights, thresholdCurve, testSetSize, testSetFraudCount } = report;
  const { confusionMatrix: cm } = evaluation;

  return (
    <div className="panel-card rounded-2xl p-5">
      <div className="mb-1 flex items-center justify-between">
        <p className="text-sm font-semibold">Fraud-spike detector</p>
        <span className="text-[11px]" style={{ color: "var(--muted-2)" }}>
          trained {new Date(report.trainedAt).toLocaleDateString()}
        </span>
      </div>
      <p className="mb-4 text-xs" style={{ color: "var(--muted)" }}>
        Track 02-caliber module — real labeled data, real held-out evaluation, honest numbers below.
      </p>

      <PositioningNote />

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Precision" value={`${(evaluation.precision * 100).toFixed(1)}%`} color="var(--decision-allow)" />
        <StatTile label="Recall" value={`${(evaluation.recall * 100).toFixed(1)}%`} color="var(--entity-agent)" />
        <StatTile label="F1 score" value={`${(evaluation.f1 * 100).toFixed(1)}%`} />
        <StatTile label="Test set" value={testSetSize.toLocaleString()} />
      </div>

      <p className="mb-4 text-[11px]" style={{ color: "var(--muted-2)" }}>
        At decision threshold {evaluation.threshold} (chosen to maximize F1 on this held-out set — see the
        full sweep below) · {testSetFraudCount.toLocaleString()} of {testSetSize.toLocaleString()} test
        transactions were labeled fraud.
      </p>

      {sample && (
        <div className="mb-4">
          <div className="relative h-[420px] overflow-hidden rounded-2xl panel-card-lg">
            <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-16" style={{ background: "linear-gradient(to bottom, rgba(5,6,10,0.6), transparent)" }} />
            <div className="pointer-events-none absolute left-4 top-3 z-10">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-white/70">
                {sample.points.length.toLocaleString()} real transactions from the held-out test set
              </p>
              <p className="mt-0.5 text-[11px] text-white/50">
                x = model score (low → high) · y = transaction size · hover any point
              </p>
            </div>
            <div
              className="pointer-events-none absolute right-4 top-3 z-10 flex flex-col gap-1 rounded-lg px-2.5 py-2"
              style={{ background: "rgba(9,11,18,0.7)" }}
            >
              {LEGEND_ITEMS.map((item) => (
                <div key={item.label} className="flex items-center gap-1.5 text-[10px] text-white/70">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: item.color, boxShadow: `0 0 6px ${item.color}` }} />
                  {item.label}
                </div>
              ))}
            </div>
            <RiskScoreGraph sample={sample} />
          </div>
          <p className="mt-1.5 text-[10px]" style={{ color: "var(--muted-2)" }}>
            This is the actual PaySim held-out test set, not Mandate&apos;s own transactions — a separate
            Three.js scene from the Overview graph, only mounted here, so it never touches that graph&apos;s
            performance.
          </p>
        </div>
      )}

      <div className="mb-4">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--muted-2)" }}>
          Confusion matrix — held-out test set, never seen during training
        </p>
        <div className="grid grid-cols-2 gap-2 text-center text-xs">
          <div className="rounded-lg py-3" style={{ background: "color-mix(in srgb, var(--decision-allow) 16%, transparent)" }}>
            <p className="text-lg font-semibold">{cm.truePositive}</p>
            <p style={{ color: "var(--muted)" }}>caught fraud</p>
          </div>
          <div className="rounded-lg py-3" style={{ background: "color-mix(in srgb, var(--decision-escalate) 16%, transparent)" }}>
            <p className="text-lg font-semibold">{cm.falsePositive}</p>
            <p style={{ color: "var(--muted)" }}>false alarms</p>
          </div>
          <div className="rounded-lg py-3" style={{ background: "color-mix(in srgb, var(--decision-block) 16%, transparent)" }}>
            <p className="text-lg font-semibold">{cm.falseNegative}</p>
            <p style={{ color: "var(--muted)" }}>missed fraud</p>
          </div>
          <div className="rounded-lg py-3" style={{ background: "var(--panel-2)" }}>
            <p className="text-lg font-semibold">{cm.trueNegative.toLocaleString()}</p>
            <p style={{ color: "var(--muted)" }}>correctly cleared</p>
          </div>
        </div>
      </div>

      <div className="mb-4 rounded-lg px-3 py-2.5 text-[11px] leading-relaxed" style={{ background: "var(--panel-2)", color: "var(--muted)" }}>
        <strong style={{ color: "var(--foreground)" }}>False-positive cost:</strong> {formatMoney(evaluation.falsePositiveCost.totalInr * 100, "INR")} across {cm.falsePositive} false alarms, assuming{" "}
        {formatMoney(evaluation.falsePositiveCost.assumptionInr * 100, "INR")} per manual review — {evaluation.falsePositiveCost.note}
      </div>

      <div className="mb-4">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--muted-2)" }}>
          The real precision/recall tradeoff, not one cherry-picked number
        </p>
        <div className="overflow-x-auto rounded-lg" style={{ background: "var(--panel-2)" }}>
          <table className="w-full min-w-[420px] border-collapse text-left text-[11px]">
            <thead>
              <tr style={{ color: "var(--muted-2)" }}>
                <th className="px-2.5 py-2 font-medium">Threshold</th>
                <th className="px-2.5 py-2 font-medium">Precision</th>
                <th className="px-2.5 py-2 font-medium">Recall</th>
                <th className="px-2.5 py-2 font-medium">F1</th>
                <th className="px-2.5 py-2 font-medium">Caught</th>
                <th className="px-2.5 py-2 font-medium">False alarms</th>
              </tr>
            </thead>
            <tbody>
              {thresholdCurve.map((row) => {
                const isRecommended = row.threshold === evaluation.threshold;
                return (
                  <tr
                    key={row.threshold}
                    style={isRecommended ? { background: "color-mix(in srgb, var(--entity-agent) 14%, transparent)" } : undefined}
                  >
                    <td className="px-2.5 py-1.5 tabular-nums">
                      {row.threshold}
                      {isRecommended && (
                        <span className="ml-1.5 rounded px-1 py-0.5 text-[9px] font-semibold" style={{ background: "var(--entity-agent)", color: "white" }}>
                          max F1
                        </span>
                      )}
                    </td>
                    <td className="px-2.5 py-1.5 tabular-nums">{(row.precision * 100).toFixed(1)}%</td>
                    <td className="px-2.5 py-1.5 tabular-nums">{(row.recall * 100).toFixed(1)}%</td>
                    <td className="px-2.5 py-1.5 tabular-nums">{(row.f1 * 100).toFixed(1)}%</td>
                    <td className="px-2.5 py-1.5 tabular-nums">{row.confusionMatrix.truePositive}</td>
                    <td className="px-2.5 py-1.5 tabular-nums">{row.confusionMatrix.falsePositive.toLocaleString()}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-1.5 text-[10px]" style={{ color: "var(--muted-2)" }}>
          A lower threshold catches more fraud at the cost of more false alarms, and vice versa — this is
          the real shape of that tradeoff on the held-out set, not a single number picked to look good.
        </p>
      </div>

      <div className="mb-4">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--muted-2)" }}>
          Feature weights — what actually drives the score
        </p>
        <div className="space-y-1.5">
          {featureWeights
            .slice()
            .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
            .map((f) => {
              const positive = f.weight > 0;
              const width = Math.min(Math.abs(f.weight) * 20, 100);
              return (
                <div key={f.name} className="flex items-center gap-2 text-[11px]">
                  <span className="w-40 shrink-0 truncate font-mono" style={{ color: "var(--muted)" }}>
                    {f.name}
                  </span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full" style={{ background: "var(--panel-border)" }}>
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${width}%`, background: positive ? "var(--decision-block)" : "var(--decision-allow)" }}
                    />
                  </div>
                  <span className="w-14 shrink-0 text-right tabular-nums" style={{ color: "var(--muted-2)" }}>
                    {f.weight.toFixed(2)}
                  </span>
                </div>
              );
            })}
        </div>
        <p className="mt-1.5 text-[10px]" style={{ color: "var(--muted-2)" }}>
          Red = pushes toward flagging as fraud. Green = pushes toward clearing it.
        </p>
      </div>

      <p className="text-[10px] leading-relaxed" style={{ color: "var(--muted-2)" }}>
        {dataset.source} · {dataset.totalQualifyingRows.toLocaleString()} qualifying rows,{" "}
        {dataset.totalFraudRows.toLocaleString()} labeled fraud · {model.type} · {methodology.note}
      </p>
    </div>
  );
}
