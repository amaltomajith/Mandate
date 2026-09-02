import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getDashboardData } from "@/lib/dashboardData";
import { auditPolicySet } from "@/lib/policy/audit";
import { LiveRefresher } from "@/components/dashboard/LiveRefresher";
import { AlertToasts } from "@/components/dashboard/AlertToasts";
import { AlertsBell } from "@/components/dashboard/AlertsBell";
import { SignOutButton } from "@/components/dashboard/SignOutButton";
import { DashboardTabs } from "@/components/dashboard/DashboardTabs";
import { MandateMark } from "@/components/brand/MandateMark";
import type { Trace } from "@/types/db";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  // A second gate, not the first one: proxy.ts already protects this route, so
  // in normal operation a signed-out visitor never gets here. It earns its
  // place as the backstop for the failure the allowlist has had before -- a
  // route slipping out of the matcher. Without it that mistake surfaces as an
  // error page from getCurrentMerchant, which throws for a signed-out user,
  // rather than as a sign-in prompt.
  const { userId } = await auth();
  if (!userId) redirect("/login");

  const { agents, rules, traces, escalations, alerts, mandates, customers, products, merchant, loadError } = await getDashboardData();
  const tracesById: Record<string, Trace> = Object.fromEntries(traces.map((t) => [t.id, t]));

  const pendingEscalations = escalations.filter((e) => e.status === "pending").length;
  const activeAgents = agents.length;
  const activeRules = rules.filter((r) => r.status === "active").length;
  const deterministicIssues = auditPolicySet(rules);

  return (
    <div className="relative flex min-h-screen flex-col bg-[var(--background-2)]">
      <LiveRefresher />
      <AlertToasts alerts={alerts} />

      <header className="panel-glass sticky top-0 z-20 flex items-center justify-between px-6 py-3.5" style={{ borderTop: "none", borderLeft: "none", borderRight: "none" }}>
        <div className="flex items-center gap-3">
          <MandateMark size={28} />
          <div>
            <h1 className="text-[15px] font-semibold tracking-tight">Mandate</h1>
            <p className="text-[11px] leading-none" style={{ color: "var(--muted-2)" }}>
              control plane
            </p>
          </div>

          <div className="ml-6 hidden items-center gap-4 border-l pl-6 sm:flex" style={{ borderColor: "var(--panel-border)" }}>
            <StatChip label="agents" value={activeAgents} />
            <StatChip label="active rules" value={activeRules} />
            <StatChip
              label="pending"
              value={pendingEscalations}
              tone={pendingEscalations > 0 ? "var(--decision-escalate)" : undefined}
            />
            {deterministicIssues.length > 0 && (
              <StatChip label="policy issues" value={deterministicIssues.length} tone="var(--decision-block)" />
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--muted)" }}>
            <span className="live-dot h-1.5 w-1.5 rounded-full" style={{ background: "var(--decision-allow)" }} />
            live
          </div>
          {/* The architecture walkthrough (public/architecture.html) — a plain
              static page, deliberately reachable without signing in, so it can
              be linked from a README or handed to someone evaluating this
              without giving them dashboard access. */}
          <a
            href="/architecture.html"
            target="_blank"
            rel="noopener"
            className="rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition-colors hover:bg-[var(--panel-2)]"
            style={{ color: "var(--muted)" }}
          >
            How it works
          </a>
          <AlertsBell alerts={alerts} />
          <SignOutButton />
        </div>
      </header>

      <div className="relative z-10 flex flex-1 flex-col gap-5 p-5">
        {loadError && (
          <div
            className="rounded-2xl border px-4 py-3 text-sm"
            style={{ borderColor: "var(--decision-block)", color: "var(--decision-block)", background: "color-mix(in srgb, var(--decision-block) 10%, transparent)" }}
          >
            <strong>Couldn&apos;t load live data from Supabase:</strong> {loadError}. The panels below
            may be showing stale or empty data. This is usually a network/TLS issue between this
            server and Supabase, not an app bug — check the terminal running <code>npm run dev</code>{" "}
            for the full error.
          </div>
        )}

        <DashboardTabs
          agents={agents}
          rules={rules}
          traces={traces}
          escalations={escalations}
          tracesById={tracesById}
          deterministicIssues={deterministicIssues}
          pendingCount={pendingEscalations}
          mandates={mandates}
          customers={customers}
          products={products}
          merchant={merchant}

        />
      </div>
    </div>
  );
}

/** Pluralises by count. Done here rather than at each call site so a new chip
 *  cannot reintroduce "1 agents" by forgetting. */
function StatChip({ label, value, tone }: { label: string; value: number; tone?: string }) {
  const shown = value === 1 && label.endsWith("s") ? label.slice(0, -1) : label;
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-sm font-semibold tabular-nums" style={{ color: tone ?? "var(--foreground)" }}>
        {value}
      </span>
      <span className="text-[11px]" style={{ color: "var(--muted-2)" }}>
        {shown}
      </span>
    </div>
  );
}
