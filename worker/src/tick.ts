import type { SupabaseClient } from "@supabase/supabase-js";
import { getSettings } from "@/lib/settings";
import { ChannelService } from "./channels/service";
import { buildDrivers } from "./channels/drivers";
import { runAgent, type RunResult } from "./runner";
import { runBuyingAgent } from "./agents/buying";
import { runSellingAgent } from "./agents/selling";

export interface TickReport {
  merchant: string;
  ingested: number;
  buying: RunResult;
  selling: RunResult;
}

function describe(r: RunResult): string {
  return r.status === "ok" ? r.summary : r.status === "skipped" ? `skipped (${r.reason})` : `ERROR ${r.error}`;
}

/** One pass over one merchant: pull new messages, then let each agent act. */
export async function tickMerchant(db: SupabaseClient, merchant: { id: string; slug: string }): Promise<TickReport> {
  const settings = await getSettings(db, merchant.id);
  const channels = new ChannelService(db, merchant.id, settings.channel_mode, await buildDrivers(db, merchant.id, settings));
  const ingested = await channels.ingest();

  // Buying first: it frees up the replies that the selling side may be waiting on
  // and it is the more time-sensitive of the two (stock-outs lose sales).
  const buying = await runAgent(db, merchant, "buying", runBuyingAgent);
  const selling = await runAgent(db, merchant, "selling", runSellingAgent);
  return { merchant: merchant.slug, ingested, buying, selling };
}

/** Every merchant whose team is switched on. */
export async function tick(db: SupabaseClient, only?: string): Promise<TickReport[]> {
  const { data: enabled, error } = await db.from("merchant_settings").select("merchant_id").eq("agents_enabled", true);
  if (error) throw new Error(error.message);
  if (!enabled?.length) return [];
  let q = db.from("merchants").select("id, slug").in("id", enabled.map((e) => e.merchant_id));
  if (only) q = q.eq("slug", only);
  const { data: merchants, error: mError } = await q;
  if (mError) throw new Error(mError.message);

  const reports: TickReport[] = [];
  for (const m of merchants ?? []) {
    try {
      const report = await tickMerchant(db, m);
      reports.push(report);
      console.log(`[worker] ${m.slug}\n  buying : ${describe(report.buying)}\n  selling: ${describe(report.selling)}`);
    } catch (err) {
      // One merchant's failure must not stop the others.
      console.error(`[worker] ${m.slug} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return reports;
}
