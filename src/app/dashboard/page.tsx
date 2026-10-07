import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getDashboardData } from "@/lib/dashboardData";
import { getCooData } from "@/lib/cooData";
import { createAdminClient } from "@/lib/supabase/admin";
import { auditPolicySet } from "@/lib/policy/audit";
import { LiveRefresher } from "@/components/dashboard/LiveRefresher";
import { AlertToasts } from "@/components/dashboard/AlertToasts";
import { AlertsBell } from "@/components/dashboard/AlertsBell";
import { SignOutButton } from "@/components/dashboard/SignOutButton";
import { DashboardTabs } from "@/components/dashboard/DashboardTabs";
import { MandateMark } from "@/components/brand/MandateMark";
import { OperationsMap } from "@/components/graph/OperationsMap";
import GradientWaves from "@/components/landing/GradientWaves";
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

  const { agents, allAgents, rules, traces, escalations, alerts, customers, merchant, loadError } = await getDashboardData();
  const coo = await getCooData(createAdminClient(), merchant.id);
  const tracesById: Record<string, Trace> = Object.fromEntries(traces.map((t) => [t.id, t]));

  const pendingEscalations = escalations.filter((e) => e.status === "pending").length;
  // `agents` is live-only now, so this counts what it says it counts. It used
  // to read the unfiltered list and reported six while the roster below it
  // showed four -- the same page disagreeing with itself about how many agents
  // exist.
  const deterministicIssues = auditPolicySet(rules);

  return (
    <div className="relative flex min-h-screen flex-col bg-[var(--background-2)]">
      <LiveRefresher />
      <AlertToasts alerts={alerts} />

      {/* The same shader as the landing hero, so arriving here reads as the same
          product rather than a different app behind a login.
          ---------------------------------------------------------------------
          Deliberately cheap. This page already runs a full three.js scene, and a
          second WebGL context competing for the GPU during a live demo is a real
          cost, not a theoretical one -- so: `detail="low"` (40 raymarch steps
          instead of 70), dpr pinned to 1, and a 168px band rather than a
          full-bleed hero. That is roughly a seventh of the fragment work the
          landing page does. It also sits BEHIND a sticky header rather than
          inside it, so it scrolls out of view and the component's own
          intersection observer stops rendering it entirely. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[168px] overflow-hidden">
        <GradientWaves
          horizonColor="#5227ff"
          waveColor="#ff9ffc"
          crestColor="#ffffff"
          speed={0.16}
          amplitude={2.2}
          waveScale={0.8}
          swell={22}
          turbulence={12}
          tilt={1.2}
          height={5}
          fogDepth={22}
          detail="low"
          brightness={0.8}
          opacity={0.5}
          mouseInteraction={false}
          grainIntensity={0.03}
          dprCap={1}
        />
        <div
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(to bottom, rgba(8,8,12,0.62) 0%, rgba(8,8,12,0.5) 45%, var(--background-2) 100%)",
          }}
        />
      </div>

      <header className="panel-glass sticky top-0 z-20 flex items-center justify-between px-6 py-3.5" style={{ borderTop: "none", borderLeft: "none", borderRight: "none" }}>
        <div className="flex items-center gap-3">
          <MandateMark size={28} />
          <div>
            <h1 className="text-[15px] font-semibold tracking-tight">Mandate</h1>
            <p className="text-[11px] leading-none" style={{ color: "var(--muted-2)" }}>
              autonomous store manager
            </p>
          </div>

          <div className="ml-6 hidden items-center gap-4 border-l pl-6 sm:flex" style={{ borderColor: "var(--panel-border)" }}>
            <StatChip label="needs you" value={pendingEscalations} tone={pendingEscalations > 0 ? "var(--decision-escalate)" : undefined} />
            <StatChip label="running low" value={coo.kpis.runningLow} tone={coo.kpis.runningLow > 0 ? "var(--decision-block)" : undefined} />
            <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider" style={{ background: coo.settings.channel_mode === "live" ? "color-mix(in srgb, var(--decision-escalate) 18%, transparent)" : "color-mix(in srgb, var(--entity-mandate) 18%, transparent)", color: coo.settings.channel_mode === "live" ? "var(--decision-escalate)" : "var(--entity-mandate)" }}>
              {coo.settings.channel_mode}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--muted)" }}>
            <span className="live-dot h-1.5 w-1.5 rounded-full" style={{ background: "var(--decision-allow)" }} />
            live
          </div>
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
          allAgents={allAgents}
          rules={rules}
          traces={traces}
          escalations={escalations}
          tracesById={tracesById}
          alerts={alerts}
          deterministicIssues={deterministicIssues}
          customers={customers}
          coo={coo}
          slug={merchant.slug}
          appUrl={process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}
          serverHasRazorpayKeys={Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET)}
          googleConfigured={Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)}
          map={<OperationsMap key="map" coo={coo} agents={agents} rules={rules} traces={traces} escalations={escalations} />}
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
