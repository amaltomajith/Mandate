"use server";

import { revalidatePath } from "next/cache";
import { requireDashboardUser } from "./authGuard";
import { runBackgroundTraffic, type BackgroundTrafficSummary } from "@/lib/demo/backgroundTraffic";

/** Fires a burst of real, signed MCP calls to generate ordinary transaction
 *  volume — same real path as the demo script, just noise instead of a
 *  narrative. Gated behind Clerk like every other privileged dashboard
 *  action. */
export async function generateBackgroundTraffic(count?: number): Promise<BackgroundTrafficSummary> {
  await requireDashboardUser();
  const summary = await runBackgroundTraffic(count);
  revalidatePath("/dashboard");
  return summary;
}
