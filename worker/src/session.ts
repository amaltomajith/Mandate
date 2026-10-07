import type { SupabaseClient } from "@supabase/supabase-js";
import type { Client } from "@modelcontextprotocol/client";
import type { MerchantSettings } from "@/types/db";
import { getSettings } from "@/lib/settings";
import { loadAgentIdentity } from "@/lib/agents/inhouse";
import { ToolHub } from "./lib/hub";
import { connectWall, parseWallResult, type WallOutcome } from "./lib/wall";
import { ChannelService } from "./channels/service";
import { buildDrivers } from "./channels/drivers";
import { createStoreServer } from "./mcp/store";
import { createPurchasingServer } from "./mcp/purchasing";
import { createChannelsServer } from "./mcp/channels";
import { createResearchServer } from "./mcp/research";

export type AgentKind = "buying" | "selling";

/**
 * What each agent may touch, by tool name. Enforced on every call (see
 * {@link Session.call}) and also used to decide which tools a model is shown.
 * The Buying agent can reach suppliers and the web but not customers; the
 * Selling agent can reach customers but not suppliers or the web. Both reach the
 * Payment Wall, which applies its own, stricter per-agent permissions.
 */
const ALLOW: Record<AgentKind, (tool: string) => boolean> = {
  buying: (t) =>
    t === "store_get_inventory" ||
    t === "store_get_cash_position" ||
    t.startsWith("purchasing_") ||
    t === "channels_send_message_to_vendor" ||
    t === "channels_read_thread" ||
    t === "channels_list_unhandled_messages" ||
    t === "channels_mark_handled" ||
    t.startsWith("research_") ||
    t === "wall_simulate_action" ||
    t === "wall_enforce_action",
  selling: (t) =>
    t.startsWith("store_") ||
    t === "channels_send_message_to_customer" ||
    t === "channels_read_thread" ||
    t === "channels_list_unhandled_messages" ||
    t === "channels_mark_handled" ||
    t === "wall_simulate_action" ||
    t === "wall_enforce_action",
};

export interface SessionStep {
  at: string;
  type: string;
  detail?: unknown;
}

export class Session {
  readonly steps: SessionStep[] = [];

  constructor(
    readonly db: SupabaseClient,
    readonly merchant: { id: string; slug: string },
    readonly settings: MerchantSettings,
    readonly kind: AgentKind,
    readonly agentId: string,
    readonly hub: ToolHub,
    readonly channels: ChannelService,
    private readonly wallClient: Client
  ) {}

  get allow() {
    return ALLOW[this.kind];
  }

  log(type: string, detail?: unknown) {
    if (this.steps.length < 300) this.steps.push({ at: new Date().toISOString(), type, detail });
  }

  /** A tool call from workflow code. Held to the same allow-list as a model's. */
  async call<T = unknown>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!this.allow(tool)) throw new Error(`The ${this.kind} agent may not use ${tool}.`);
    const res = await this.hub.call(tool, args);
    if (res.isError) throw new Error(`${tool}: ${res.text}`);
    this.log("tool", { tool, args });
    try {
      return JSON.parse(res.text) as T;
    } catch {
      return res.text as unknown as T;
    }
  }

  /** Propose an action to the Payment Wall. The wall's answer is final. */
  async wall(mode: "simulate" | "enforce", action: Record<string, unknown>): Promise<WallOutcome> {
    const tool = mode === "simulate" ? "wall_simulate_action" : "wall_enforce_action";
    if (!this.allow(tool)) throw new Error(`The ${this.kind} agent may not use ${tool}.`);
    const raw = await this.wallClient.callTool({ name: `${mode}_action`, arguments: action });
    const outcome = parseWallResult(raw);
    this.log("wall", { mode, actionType: action.actionType, decision: outcome.decision, rule: outcome.ruleFired?.type, reasoning: outcome.reasoning });
    return outcome;
  }

  async close() {
    await this.hub.close();
    await this.wallClient.close().catch(() => undefined);
  }
}

export async function openSession(
  db: SupabaseClient,
  merchant: { id: string; slug: string },
  kind: AgentKind
): Promise<Session> {
  const settings = await getSettings(db, merchant.id);
  const identity = await loadAgentIdentity(db, merchant.id, kind);
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const wallClient = await connectWall({ baseUrl, slug: merchant.slug, agentId: identity.agentId, secretKey: identity.secretKey });

  const ctx = { db, merchantId: merchant.id };
  const channels = new ChannelService(db, merchant.id, settings.channel_mode, await buildDrivers(db, merchant.id, settings));
  const hub = new ToolHub();
  await hub.mountServer("store", createStoreServer(ctx));
  await hub.mountServer("purchasing", createPurchasingServer(ctx));
  await hub.mountServer("channels", createChannelsServer(ctx, channels));
  await hub.mountServer("research", createResearchServer(ctx));
  await hub.mountClient("wall", wallClient);

  return new Session(db, merchant, settings, kind, identity.agentId, hub, channels, wallClient);
}
