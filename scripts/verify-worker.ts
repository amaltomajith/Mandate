/**
 * Worker lifecycle: a run that is still alive is never reaped and one that died
 * is, the loop stops promptly and never hangs on a sleep, a failing merchant is
 * backed off instead of retried at full speed, and the worker reports that it
 * is alive. Database only (the agent work here is a stub).
 *
 *   npx tsx --tsconfig worker/tsconfig.json scripts/verify-worker.ts
 */
import "./lib/loadEnv";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "../src/lib/supabase/admin";
import { ensureWorkspace } from "../src/lib/workspace";
import { runAgent } from "../worker/src/runner";
import { backoffMs, createStopSignal, reportAlive } from "../worker/src/lifecycle";

const db = createAdminClient() as unknown as SupabaseClient;
let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const rnd = Math.random().toString(36).slice(2, 8);
  const { data: m } = await db.from("merchants").insert({ name: "worker", slug: `verify-worker-${rnd}` }).select("*").single();
  await ensureWorkspace(db, m.id);
  try {
    const { data: agent } = await db.from("agents").select("id").eq("merchant_id", m.id).eq("kind", "buying").single();

    console.log("a run that is alive is not reaped; one that died is");
    {
      // Started 40 minutes ago, but its heartbeat is a few seconds old: a slow run, not a dead one.
      const { data: slow } = await db.from("agent_runs").insert({ merchant_id: m.id, agent_id: agent!.id, kind: "buying", started_at: ago(40 * 60_000), heartbeat_at: ago(5_000) }).select("id").single();
      const blocked = await runAgent(db, m, "buying", async () => "should not run");
      check("a long run with a fresh heartbeat blocks the next one", blocked.status === "skipped" && /Already running/.test((blocked as { reason: string }).reason), JSON.stringify(blocked));
      const { data: still } = await db.from("agent_runs").select("status").eq("id", slow!.id).single();
      check("and is left running", still?.status === "running", still?.status);

      // The holder died: its heartbeat stopped five minutes ago.
      await db.from("agent_runs").update({ heartbeat_at: ago(5 * 60_000) }).eq("id", slow!.id);
      const next = await runAgent(db, m, "buying", async () => "recovered");
      check("a run whose heartbeat stopped is reaped and the next one goes ahead", next.status === "ok", JSON.stringify(next));
      const { data: reaped } = await db.from("agent_runs").select("status, error").eq("id", slow!.id).single();
      check("the dead run is marked as failed, not left running", reaped?.status === "error", JSON.stringify(reaped));
    }

    console.log("a running agent keeps beating");
    {
      let beatBefore: string | null = null;
      let beatDuring: string | null = null;
      const result = await runAgent(
        db,
        m,
        "buying",
        async () => {
          const read = async () => (await db.from("agent_runs").select("heartbeat_at").eq("merchant_id", m.id).eq("kind", "buying").eq("status", "running").single()).data?.heartbeat_at as string | null;
          beatBefore = await read();
          await sleep(900);
          beatDuring = await read();
          return "slow but alive";
        },
        { heartbeatMs: 200 }
      );
      check("the run completes", result.status === "ok", JSON.stringify(result));
      check("its heartbeat moved forward while it worked", !!beatBefore && !!beatDuring && new Date(beatDuring).getTime() > new Date(beatBefore).getTime(), `${beatBefore} -> ${beatDuring}`);
    }

    console.log("stopping");
    {
      const stop = createStopSignal();
      const started = Date.now();
      const sleeping = stop.sleep(30_000);
      setTimeout(() => stop.stop(), 100);
      await sleeping;
      check("a sleeping loop wakes the moment it is told to stop", Date.now() - started < 2_000, `${Date.now() - started}ms`);
      check("and reports that it is stopping", stop.stopping);
      const again = Date.now();
      await stop.sleep(30_000);
      check("sleeping after a stop returns at once", Date.now() - again < 200);
    }

    console.log("a failing merchant backs off");
    {
      check("no failures means no delay", backoffMs(0, 60_000) === 0);
      check("the first failure waits one pass", backoffMs(1, 60_000) === 60_000);
      check("it doubles each time", backoffMs(2, 60_000) === 120_000 && backoffMs(3, 60_000) === 240_000);
      check("and is capped at fifteen minutes", backoffMs(20, 60_000) === 15 * 60_000);
    }

    console.log("the worker says it is alive");
    {
      await reportAlive(db, { merchants: 3 });
      const { data: row } = await db.from("worker_status").select("*").eq("id", "main").single();
      check("a heartbeat row is written", !!row && Date.now() - new Date(row.beat_at).getTime() < 30_000, JSON.stringify(row));
      await reportAlive(db, { merchants: 4 });
      const { data: rows } = await db.from("worker_status").select("id");
      check("and updated in place, never duplicated", (rows ?? []).length === 1);
    }
  } finally {
    await db.from("merchants").delete().eq("id", m.id);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
