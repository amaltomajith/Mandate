"use server";

import { revalidatePath } from "next/cache";
import { requireDashboardUser } from "./authGuard";
import { runDemoScript, type DemoStep } from "@/lib/demo/runDemo";

/** Runs the full demo scenario (HANDOVER.md "Demo script") from a dashboard
 *  button click instead of the terminal — same real MCP calls, same real
 *  Web Bot Auth signing, just triggered by someone who'd rather not open a
 *  shell. Gated behind Clerk like every other privileged dashboard action. */
export async function runDemo(): Promise<DemoStep[]> {
  await requireDashboardUser();
  const steps = await runDemoScript();
  revalidatePath("/dashboard");
  return steps;
}
