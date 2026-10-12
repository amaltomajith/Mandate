import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentMerchant } from "@/lib/merchant";
import { allow } from "@/lib/rateLimit";

/**
 * The merchant's audit trail as a CSV: every action an agent proposed, what the
 * wall decided, which rule decided it, and why. Behind Clerk like the rest of
 * the dashboard and scoped to the signed-in merchant.
 */

/** A spreadsheet will run a cell that starts with = + - or @ as a formula, and
 *  the reasoning column contains text derived from outside parties. Prefixing
 *  the cell makes it inert. */
function cell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export async function GET() {
  const merchant = await getCurrentMerchant();
  // The export reads up to 5000 rows and several tables: cap how often it can be asked for.
  if (!allow(`export:${merchant.id}`, 10, 60_000)) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": "30" } });
  const db = createAdminClient();
  const [{ data: traces, error }, { data: agents }, { data: rules }, { data: escalations }] = await Promise.all([
    db.from("traces").select("*").eq("merchant_id", merchant.id).order("created_at", { ascending: false }).limit(5000),
    db.from("agents").select("id, name").eq("merchant_id", merchant.id),
    db.from("policy_rules").select("id, name").eq("merchant_id", merchant.id),
    db.from("escalations").select("trace_id, status, resolved_by, resolved_at").eq("merchant_id", merchant.id),
  ]);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const agentName = new Map((agents ?? []).map((a) => [a.id, a.name]));
  const ruleName = new Map((rules ?? []).map((r) => [r.id, r.name]));
  const esc = new Map((escalations ?? []).map((e) => [e.trace_id, e]));

  const head = ["time", "mode", "action", "amount_inr", "agent", "decision", "rule", "reasoning", "approval", "approved_by", "approved_at", "trace_id"];
  const rows = (traces ?? []).map((t) => {
    const p = t.params as { amount?: number } | null;
    const e = esc.get(t.id);
    return [
      t.created_at,
      t.mode,
      t.action_type,
      typeof p?.amount === "number" ? (p.amount / 100).toFixed(2) : "",
      t.agent_id ? (agentName.get(t.agent_id) ?? t.agent_id) : "",
      t.decision,
      t.rule_fired_id ? (ruleName.get(t.rule_fired_id) ?? "") : "",
      t.reasoning ?? "",
      e?.status ?? "",
      e?.resolved_by ?? "",
      e?.resolved_at ?? "",
      t.id,
    ].map(cell).join(",");
  });

  return new NextResponse([head.map(cell).join(","), ...rows].join("\r\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="mandate-audit-${merchant.slug}.csv"`,
      "cache-control": "no-store",
      // The export holds the newest 5000 decisions. Say so rather than truncate silently.
      "x-rows-truncated": String((traces ?? []).length >= 5000),
    },
  });
}
