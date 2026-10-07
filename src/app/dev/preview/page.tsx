import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { getMerchantBySlug } from "@/lib/merchant";
import { loadDashboardData } from "@/lib/dashboardData";
import { getCooData } from "@/lib/cooData";
import { auditPolicySet } from "@/lib/policy/audit";
import { DashboardTabs } from "@/components/dashboard/DashboardTabs";
import { OperationsMap } from "@/components/graph/OperationsMap";
import type { Trace } from "@/types/db";

export const dynamic = "force-dynamic";

/**
 * A development-only way to look at the dashboard without signing in, so the UI
 * can be inspected and screenshotted. It is a 404 unless BOTH the app is not
 * running in production AND MANDATE_DEV_PREVIEW=1 is set explicitly. Read-only in
 * effect: every action on the page still needs a real signed-in session and
 * will fail here.
 */
export default async function Preview({ searchParams }: { searchParams: Promise<{ slug?: string }> }) {
  if (process.env.NODE_ENV === "production" || process.env.MANDATE_DEV_PREVIEW !== "1") notFound();
  const { slug } = await searchParams;
  if (!slug) notFound();
  const db = createAdminClient();
  const merchant = await getMerchantBySlug(db, slug);
  if (!merchant) notFound();

  const { agents, allAgents, rules, traces, escalations, alerts, customers } = await loadDashboardData(merchant);
  const coo = await getCooData(db, merchant.id);
  const tracesById: Record<string, Trace> = Object.fromEntries(traces.map((t) => [t.id, t]));

  return (
    <div className="relative flex min-h-screen flex-col bg-[var(--background-2)]">
      <div className="flex flex-1 flex-col">
        <DashboardTabs
          agents={agents}
          allAgents={allAgents}
          rules={rules}
          traces={traces}
          escalations={escalations}
          tracesById={tracesById}
          alerts={alerts}
          deterministicIssues={auditPolicySet(rules)}
          customers={customers}
          coo={coo}
          slug={merchant.slug}
          appUrl={process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}
          serverHasRazorpayKeys={false}
          googleConfigured={Boolean(process.env.GOOGLE_CLIENT_ID)}
          map={<OperationsMap key="map" coo={coo} agents={agents} rules={rules} traces={traces} escalations={escalations} />}
        />
      </div>
    </div>
  );
}
