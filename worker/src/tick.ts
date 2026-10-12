import type { SupabaseClient } from "@supabase/supabase-js";
import { getSettings } from "@/lib/settings";
import { ChannelService } from "./channels/service";
import { buildDrivers } from "./channels/drivers";
import { runAgent, type RunResult } from "./runner";
import { backoffMs } from "./lifecycle";
import { log } from "./log";
import { ensureWhatsApp, stopWhatsApp } from "./channels/whatsapp";
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
  // The WhatsApp session is kept alive whenever the merchant has enabled it, even
  // in sandbox mode, so that pairing (the QR code) works before going live.
  if (settings.whatsapp_enabled) ensureWhatsApp(db, merchant.id);
  else await stopWhatsApp(merchant.id);
  const channels = new ChannelService(db, merchant.id, settings.channel_mode, await buildDrivers(db, merchant.id, settings));
  const ingested = await channels.ingest();

  // Buying first: it frees up the replies that the selling side may be waiting on
  // and it is the more time-sensitive of the two (stock-outs lose sales).
  const buying = await runAgent(db, merchant, "buying", runBuyingAgent);
  const selling = await runAgent(db, merchant, "selling", runSellingAgent);
  return { merchant: merchant.slug, ingested, buying, selling };
}

/** Merchants whose passes keep failing wait longer before the next try, so one broken account cannot burn every pass. */
const failing = new Map<string, { failures: number; until: number }>();

/** Every merchant whose team is switched on. */
export async function tick(db: SupabaseClient, only?: string, passMs = 60_000): Promise<TickReport[]> {
  const { data: enabled, error } = await db.from("merchant_settings").select("merchant_id").eq("agents_enabled", true);
  if (error) throw new Error(error.message);
  if (!enabled?.length) return [];
  let q = db.from("merchants").select("id, slug").in("id", enabled.map((e) => e.merchant_id));
  if (only) q = q.eq("slug", only);
  const { data: merchants, error: mError } = await q;
  if (mError) throw new Error(mError.message);

  const reports: TickReport[] = [];
  for (const m of merchants ?? []) {
    const state = failing.get(m.slug);
    if (state && Date.now() < state.until) continue;
    const began = Date.now();
    try {
      const report = await tickMerchant(db, m);
      reports.push(report);
      if (report.buying.status === "error" && report.selling.status === "error") {
        const failures = (state?.failures ?? 0) + 1;
        failing.set(m.slug, { failures, until: Date.now() + backoffMs(failures, passMs) });
      } else {
        failing.delete(m.slug);
      }
      log.info("merchant pass", { merchant: m.slug, ms: Date.now() - began, ingested: report.ingested, buying: describe(report.buying), selling: describe(report.selling) });
    } catch (err) {
      // One merchant's failure must not stop the others.
      const failures = (state?.failures ?? 0) + 1;
      failing.set(m.slug, { failures, until: Date.now() + backoffMs(failures, passMs) });
      log.error("merchant pass failed", { merchant: m.slug, failures, retry_in_s: Math.round(backoffMs(failures, passMs) / 1000), ms: Date.now() - began, err: err instanceof Error ? err.message : String(err) });
    }
  }
  return reports;
}
