import type { SupabaseClient } from "@supabase/supabase-js";
import type { Json } from "@/types/db";
import { getSettings } from "@/lib/settings";
import { openSession, type AgentKind, type Session } from "./session";

const STALE_RUN_MINUTES = 10;

export type RunResult =
  | { status: "ok"; summary: string; runId: string }
  | { status: "skipped"; reason: string }
  | { status: "error"; error: string; runId: string };

/**
 * One run of one agent, with its lifecycle recorded.
 *
 * The `agent_runs` table doubles as the lock: a partial unique index allows only
 * one 'running' row per merchant and agent, so two workers (or a slow run and the
 * next tick) cannot act at once. A run that dies without finishing is reaped
 * after {@link STALE_RUN_MINUTES} so it cannot block the agent forever.
 */
export async function runAgent(
  db: SupabaseClient,
  merchant: { id: string; slug: string },
  kind: AgentKind,
  work: (s: Session) => Promise<string>
): Promise<RunResult> {
  const settings = await getSettings(db, merchant.id);
  if (!settings.agents_enabled) return { status: "skipped", reason: "The merchant has switched the team off." };

  const { data: agent } = await db.from("agents").select("id, status").eq("merchant_id", merchant.id).eq("kind", kind).eq("retired", false).maybeSingle();
  if (!agent) return { status: "skipped", reason: `No ${kind} agent.` };
  if (agent.status === "paused") return { status: "skipped", reason: `The ${kind} agent is paused.` };

  await db
    .from("agent_runs")
    .update({ status: "error", error: "Timed out without finishing.", finished_at: new Date().toISOString() })
    .eq("merchant_id", merchant.id)
    .eq("kind", kind)
    .eq("status", "running")
    .lt("started_at", new Date(Date.now() - STALE_RUN_MINUTES * 60_000).toISOString());

  const { data: run, error } = await db
    .from("agent_runs")
    .insert({ merchant_id: merchant.id, agent_id: agent.id, kind, dry_run: settings.dry_run })
    .select("id")
    .single();
  if (error) {
    // 23505: the unique index says this agent is already running.
    if (error.code === "23505") return { status: "skipped", reason: "Already running." };
    throw new Error(error.message);
  }

  let session: Session | null = null;
  try {
    session = await openSession(db, merchant, kind);
    const summary = await work(session);
    await db
      .from("agent_runs")
      .update({ status: "ok", summary, steps: session.steps as unknown as Json, finished_at: new Date().toISOString() })
      .eq("id", run.id);
    return { status: "ok", summary, runId: run.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .from("agent_runs")
      .update({ status: "error", error: message.slice(0, 1000), steps: (session?.steps ?? []) as unknown as Json, finished_at: new Date().toISOString() })
      .eq("id", run.id);
    return { status: "error", error: message, runId: run.id };
  } finally {
    await session?.close();
  }
}
