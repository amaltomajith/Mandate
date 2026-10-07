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
import { OperationsMap } from "@/components/graph/OperationsMap";
import { currentUser } from "@clerk/nextjs/server";
import { isOperator } from "@/lib/operator";
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
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[220px] overflow-hidden">
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

      <div className="relative z-10 flex flex-1 flex-col">
        {loadError && (
          <div
            className="mx-8 mt-6 rounded-2xl border px-5 py-4 text-[14px] lg:ml-[calc(76px+2rem)] xl:ml-[calc(248px+2rem)]"
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
          serverHasRazorpayKeys={Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) && isOperator((await currentUser())?.emailAddresses[0]?.emailAddress)}
          googleConfigured={Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)}
          map={<OperationsMap key="map" coo={coo} agents={agents} rules={rules} traces={traces} escalations={escalations} />}
          topRight={<AlertsBell key="bell" alerts={alerts} />}
          railFooter={<SignOutButton key="signout" />}
        />
      </div>
    </div>
  );
}
