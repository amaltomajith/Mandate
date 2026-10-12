import type { SupabaseClient } from "@supabase/supabase-js";
import type { Json } from "@/types/db";
import { getSettings } from "@/lib/settings";
import { openSession, type AgentKind, type Session } from "./session";

/** A run beats this often while it works, and is presumed dead once it has been silent for the stale window. */
const HEARTBEAT_MS = 30_000;
const STALE_HEARTBEAT_MS = 3 * 60_000;
/** Runs from before heartbeats existed have none; fall back to their start time. */
const STALE_LEGACY_MS = 10 * 60_000;

export type RunResult =
  | { status: "ok"; summary: string; runId: string }
  | { status: "skipped"; reason: string }
  | { status: "error"; error: string; runId: string };

/**
 * One run of one agent, with its lifecycle recorded.
 *
 * The `agent_runs` table doubles as the lock: a partial unique index allows only
 * one 'running' row per merchant and agent, so two workers (or a slow run and the
 * next tick) cannot act at once. A running agent beats (`heartbeat_at`) while it
 * works; a run silent for {@link STALE_HEARTBEAT_MS} has died and is reaped so it
 * cannot block the agent forever. A slow run that is still beating is left alone.
 */
export async function runAgent(
  db: SupabaseClient,
  merchant: { id: string; slug: string },
  kind: AgentKind,
  work: (s: Session) => Promise<string>,
  options: { heartbeatMs?: number } = {}
): Promise<RunResult> {
  const settings = await getSettings(db, merchant.id);
  if (!settings.agents_enabled) return { status: "skipped", reason: "The merchant has switched the team off." };

  const { data: agent } = await db.from("agents").select("id, status").eq("merchant_id", merchant.id).eq("kind", kind).eq("retired", false).maybeSingle();
  if (!agent) return { status: "skipped", reason: `No ${kind} agent.` };
  if (agent.status === "paused") return { status: "skipped", reason: `The ${kind} agent is paused.` };

  const now = Date.now();
  await db
    .from("agent_runs")
    .update({ status: "error", error: "Stopped responding (no heartbeat).", finished_at: new Date().toISOString() })
    .eq("merchant_id", merchant.id)
    .eq("kind", kind)
    .eq("status", "running")
    .or(`heartbeat_at.lt.${new Date(now - STALE_HEARTBEAT_MS).toISOString()},and(heartbeat_at.is.null,started_at.lt.${new Date(now - STALE_LEGACY_MS).toISOString()})`);

  const { data: run, error } = await db
    .from("agent_runs")
    .insert({ merchant_id: merchant.id, agent_id: agent.id, kind, dry_run: settings.dry_run, heartbeat_at: new Date().toISOString() })
    .select("id")
    .single();
  if (error) {
    // 23505: the unique index says this agent is already running.
    if (error.code === "23505") return { status: "skipped", reason: "Already running." };
    throw new Error(error.message);
  }

  // Beat while working. A failed beat is not fatal: the next one, or the finish, will land.
  const beat = setInterval(() => {
    // A Supabase query only runs once it is awaited or .then'd; a bare `void` would never send it.
    db.from("agent_runs")
      .update({ heartbeat_at: new Date().toISOString() })
      .eq("id", run.id)
      .eq("status", "running")
      .then(
        () => undefined,
        () => undefined
      );
  }, options.heartbeatMs ?? HEARTBEAT_MS);

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
    clearInterval(beat);
    await session?.close();
  }
}
