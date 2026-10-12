import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { deadStockValue, getInventoryInsights, type ProductInsight } from "@/lib/inventory";
import { getSettings } from "@/lib/settings";
import { walletBalancePaise } from "@/lib/ledger";
import type {
  AgentRun,
  Connection,
  MerchantSettings,
  Message,
  Payee,
  Payout,
  PoLine,
  PurchaseOrder,
  Quote,
  Sale,
  Thread,
  Vendor,
  WalletEntry,
} from "@/types/db";

/**
 * Everything the COO side of the dashboard shows, in one read.
 *
 * Connections are returned WITHOUT their secret: `secret_enc` is never selected,
 * so there is no path from a database row to a browser that carries one.
 */

export type SafeConnection = Pick<Connection, "id" | "kind" | "status" | "account_label" | "meta" | "updated_at">;

export interface Kpis {
  walletPaise: number;
  earned7dPaise: number;
  paidOut7dPaise: number;
  restockBudgetRemainingPaise: number;
  deadStockPaise: number;
  needsRestock: number;
  runningLow: number;
  openApprovals: number;
}

export interface ConfigEventRow {
  id: string;
  actor: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  created_at: string;
}

export interface CooData {
  settings: MerchantSettings;
  insights: ProductInsight[];
  vendors: Vendor[];
  payees: Payee[];
  quotes: Quote[];
  purchaseOrders: PurchaseOrder[];
  poLines: PoLine[];
  payouts: Payout[];
  sales: Sale[];
  wallet: WalletEntry[];
  threads: Thread[];
  messages: Message[];
  runs: AgentRun[];
  connections: SafeConnection[];
  /** Who changed which setting, newest first. */
  configEvents: ConfigEventRow[];
  kpis: Kpis;
  /** When an agent last ran, as a heartbeat for the worker. Null if never. */
  lastRunAt: string | null;
  /** True when no agent has run for a while. Computed here, on the server, so the page never reads the clock during render. */
  workerIdle: boolean;
}

const DAY = 86_400_000;

export async function getCooData(db: SupabaseClient, merchantId: string): Promise<CooData> {
  const settings = await getSettings(db, merchantId);
  const since7 = new Date(Date.now() - 7 * DAY).toISOString();

  const [insights, vendors, payees, quotes, pos, lines, payouts, sales, wallet, threads, runs, connections, balance] = await Promise.all([
    getInventoryInsights(db, merchantId, settings.min_margin_bps),
    db.from("vendors").select("*").eq("merchant_id", merchantId).order("created_at", { ascending: false }),
    db.from("payees").select("id, merchant_id, vendor_id, kind, display_name, masked_identifier, razorpay_contact_id, razorpay_fund_account_id, status, approved_by, approved_at, simulated, created_at").eq("merchant_id", merchantId).order("created_at", { ascending: false }),
    db.from("quotes").select("*").eq("merchant_id", merchantId).order("created_at", { ascending: false }).limit(60),
    db.from("purchase_orders").select("*").eq("merchant_id", merchantId).order("created_at", { ascending: false }).limit(40),
    db.from("po_lines").select("*").eq("merchant_id", merchantId).limit(200),
    db.from("payouts").select("*").eq("merchant_id", merchantId).order("created_at", { ascending: false }).limit(40),
    db.from("sales").select("*").eq("merchant_id", merchantId).order("captured_at", { ascending: false }).limit(80),
    db.from("wallet_entries").select("*").eq("merchant_id", merchantId).order("created_at", { ascending: false }).limit(60),
    db.from("threads").select("*").eq("merchant_id", merchantId).order("last_message_at", { ascending: false }).limit(40),
    db.from("agent_runs").select("*").eq("merchant_id", merchantId).order("started_at", { ascending: false }).limit(40),
    db.from("connections").select("id, kind, status, account_label, meta, updated_at").eq("merchant_id", merchantId),
    walletBalancePaise(merchantId),
  ]);

  for (const r of [vendors, payees, quotes, pos, lines, payouts, sales, wallet, threads, runs, connections]) {
    if (r.error) throw new Error(r.error.message);
  }

  const threadIds = (threads.data ?? []).map((t) => t.id);
  const messages = threadIds.length
    ? await db.from("messages").select("*").eq("merchant_id", merchantId).in("thread_id", threadIds).order("created_at").limit(300)
    : { data: [], error: null };
  if (messages.error) throw new Error(messages.error.message);

  // The changes log is untyped in the generated database types, so read it untyped.
  const configEvents = await (db as unknown as SupabaseClient)
    .from("config_events")
    .select("id, actor, field, old_value, new_value, created_at")
    .eq("merchant_id", merchantId)
    .order("created_at", { ascending: false })
    .limit(60);
  if (configEvents.error) throw new Error(configEvents.error.message);

  // Real sales only: sample sales never fund anything, so they are not "earned".
  const real = (sales.data ?? []).filter((s) => !(s.razorpay_payment_id ?? "").startsWith("sample_"));
  const earned7d = real.filter((s) => s.captured_at >= since7).reduce((n, s) => n + Number(s.amount_paise), 0);
  const paid7d = (payouts.data ?? [])
    .filter((p) => p.created_at >= since7 && ["queued", "processing", "processed"].includes(p.status))
    .reduce((n, p) => n + Number(p.amount_paise), 0);
  const allowance = Math.min(
    Number(settings.weekly_payout_budget_paise),
    Number(settings.starting_float_paise) + Math.floor((earned7d * settings.payout_budget_pct) / 100)
  );

  return {
    settings,
    insights,
    vendors: vendors.data ?? [],
    // `details_enc` (a manual-payout payee's encrypted account details) is never
    // selected: this object goes to client components, and the one place those
    // details are read is getPayoutInstructions, for one payout at a time.
    payees: (payees.data ?? []).map((p) => ({ ...p, details_enc: null })),
    quotes: quotes.data ?? [],
    purchaseOrders: pos.data ?? [],
    poLines: lines.data ?? [],
    payouts: payouts.data ?? [],
    sales: sales.data ?? [],
    wallet: wallet.data ?? [],
    threads: threads.data ?? [],
    messages: messages.data ?? [],
    runs: runs.data ?? [],
    connections: (connections.data ?? []) as SafeConnection[],
    lastRunAt: runs.data?.[0]?.started_at ?? null,
    workerIdle: !runs.data?.[0] || Date.now() - new Date(runs.data[0].started_at).getTime() > 15 * 60_000,
    configEvents: (configEvents.data ?? []) as ConfigEventRow[],
    kpis: {
      walletPaise: balance,
      earned7dPaise: earned7d,
      paidOut7dPaise: paid7d,
      restockBudgetRemainingPaise: Math.max(0, allowance - paid7d),
      deadStockPaise: deadStockValue(insights),
      needsRestock: insights.filter((i) => i.needsRestock).length,
      runningLow: insights.filter((i) => i.status === "low" || i.status === "stockout").length,
      openApprovals: 0, // filled by the page, which already holds the escalations
    },
  };
}
