"use server";

import { revalidatePath } from "next/cache";
import { requireDashboardUser } from "./authGuard";
import { getCurrentMerchant } from "@/lib/merchant";
import { ensureSomeActiveMandates, runSimulation, type SimulationSummary } from "@/lib/demo/simulation";

/** Drives the simulated agent. Real, signed MCP calls through the same
 *  policy engine every other caller uses — the only thing "simulated" is that
 *  a timer decides when the agent acts, not a customer. Gated behind Clerk
 *  like every other privileged dashboard action. */
export async function stepSimulation(count?: number): Promise<SimulationSummary> {
  await requireDashboardUser();
  const merchant = await getCurrentMerchant();
  // Tops the mandate book back up to a few active ones if it has been
  // emptied — revoking is a normal thing to do here, and an empty Mandates
  // tab afterwards makes the feature look broken rather than exercised.
  await ensureSomeActiveMandates(merchant.id);
  const summary = await runSimulation(merchant, count);
  revalidatePath("/dashboard");
  return summary;
}
