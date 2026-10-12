"use client";

import { useState } from "react";
import type { CooData } from "@/lib/cooData";
import { Icons, Panel } from "./ui";
import { Field, inputClass, inputStyle } from "./kit";

/** First and last day of the previous month, as YYYY-MM-DD (India time). */
function lastMonth(): { from: string; to: string } {
  const now = new Date(Date.now() + 5.5 * 3600_000);
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

/**
 * The records an accountant asks for at month end. Sales are read as GST-inclusive
 * and supplier prices as excluding GST; anything without a rate or HSN code is
 * flagged in the file instead of guessed.
 */
export function GstPanel({ coo }: { coo: CooData }) {
  const [range, setRange] = useState(lastMonth);
  const missing = coo.insights.filter((i) => i.active && (i.gstRateBps == null || !i.hsnCode)).length;
  const href = (kind: "sales" | "purchases") => `/api/export/gst?kind=${kind}&from=${range.from}&to=${range.to}`;
  const linkClass = "focus-ring inline-flex min-h-[44px] items-center rounded-[12px] border px-5 text-[15px] font-semibold transition-colors hover:bg-white/[0.06]";

  return (
    <Panel title="Tax records" description="Sales and purchase registers as spreadsheets, for your accountant." icon={<Icons.Shield />} accent="var(--entity-rule)">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="From">
          <input type="date" className={inputClass} style={inputStyle} value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
        </Field>
        <Field label="To">
          <input type="date" className={inputClass} style={inputStyle} value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
        </Field>
      </div>
      <div className="mt-4 flex flex-wrap gap-3">
        <a className={linkClass} style={{ borderColor: "var(--hairline-strong)" }} href={href("sales")} download>
          Download sales register
        </a>
        <a className={linkClass} style={{ borderColor: "var(--hairline-strong)" }} href={href("purchases")} download>
          Download purchase register
        </a>
      </div>
      <p className="mt-4 text-[13px] leading-5" style={{ color: "var(--muted-2)" }}>
        {missing > 0 ? `${missing} product${missing === 1 ? " has" : "s have"} no GST rate or HSN code yet. Add them on the Stock tab; until then those lines are flagged, with no tax worked out. ` : ""}
        Selling prices are treated as including GST, supplier prices as excluding it. This is a working file, not a filed return.
      </p>
    </Panel>
  );
}
