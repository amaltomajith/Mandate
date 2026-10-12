"use client";

import type { ReplayResult } from "@/lib/policy/timeMachine";
import { Pill, Table, rupees } from "./kit";

const WORDS: Record<string, { text: string; color: string }> = {
  "escalate>allow": { text: "would have gone through without asking you", color: "var(--decision-allow)" },
  "block>allow": { text: "would have been allowed", color: "var(--decision-allow)" },
  "block>escalate": { text: "would have waited for you instead of being refused", color: "var(--decision-escalate)" },
  "allow>escalate": { text: "would have waited for your approval", color: "var(--decision-escalate)" },
  "escalate>block": { text: "would have been refused instead of waiting", color: "var(--decision-block)" },
  "allow>block": { text: "would have been refused", color: "var(--decision-block)" },
};
const day = (d: Date) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" }).format(new Date(d));

/**
 * The result of replaying the last month under proposed limits. Plain counts and
 * rupees, what could not be replayed, and how closely the replay reproduces what
 * really happened (so the number can be trusted for what it is).
 */
export function PolicyReplay({ r }: { r: ReplayResult }) {
  const entries = Object.entries(r.transitions).filter(([k]) => WORDS[k]);
  return (
    <section className="surface p-7" aria-label="What this would have changed" role="status">
      <p className="text-[17px] font-semibold tracking-[-0.01em]">What this would have changed</p>
      <p className="mt-1 text-[14px]" style={{ color: "var(--muted)" }}>
        The last 30 days: {r.evaluated} decision{r.evaluated === 1 ? "" : "s"} replayed. Nothing has been saved.
      </p>

      {r.evaluated === 0 ? (
        <p className="mt-4 text-[15px]">There is no history to replay yet.</p>
      ) : entries.length === 0 ? (
        <p className="mt-4 text-[15px]">None of them would have gone differently.</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {entries.map(([k, v]) => (
            <li key={k} className="flex flex-wrap items-center gap-3 text-[15px]">
              <Pill color={WORDS[k].color}>
                {v.count} payment{v.count === 1 ? "" : "s"}, {rupees(v.valuePaise)}
              </Pill>
              <span>{WORDS[k].text}</span>
            </li>
          ))}
        </ul>
      )}

      {r.top.length > 0 && (
        <div className="mt-5">
          <Table head={["When", "Amount", "Was", "Would be"]}>
            {r.top.slice(0, 8).map((c) => (
              <tr key={c.id}>
                <td>{day(c.at)}</td>
                <td className="num">{rupees(c.amount)}</td>
                <td>{c.from}</td>
                <td>{c.to}</td>
              </tr>
            ))}
          </Table>
          {r.changed.length > 8 && (
            <p className="mt-2 text-[13px]" style={{ color: "var(--muted-2)" }}>
              The {Math.min(8, r.top.length)} largest of {r.changed.length} changes.
            </p>
          )}
        </div>
      )}

      <div className="mt-5 space-y-1.5 text-[13px]" style={{ color: "var(--muted-2)" }}>
        {r.fidelity.total > 0 && (
          <p>
            Replaying your current limits reproduces {r.fidelity.matched} of {r.fidelity.total} real decisions. Differences come from facts the history does not keep.
          </p>
        )}
        {r.notReplayed.length > 0 && <p>Not replayed, because they depend on facts that were true at the time: {r.notReplayed.join(", ")}.</p>}
      </div>
    </section>
  );
}
