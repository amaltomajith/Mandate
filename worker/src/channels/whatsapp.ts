import type { SupabaseClient } from "@supabase/supabase-js";
import QRCode from "qrcode";
import pino from "pino";
import type {
  AuthenticationCreds,
  AuthenticationState,
  SignalDataTypeMap,
  WASocket,
} from "@whiskeysockets/baileys";
import { decryptSecret, encryptSecret } from "@/lib/secrets";
import type { ChannelDriver, InboundMessage, OutboundMessage, SendResult } from "./types";
import { fromJid, normalizePhone, toJid } from "./phone";

/**
 * WhatsApp through Baileys: the same linked-device protocol as WhatsApp Web.
 *
 * Be clear about what this is. Baileys is an unofficial client. WhatsApp can
 * restrict a number that behaves like a bot, and protocol changes can break it
 * without notice. So this is built to behave like a person and to fail quietly:
 *
 *  - it is a DEDICATED number, linked by the merchant scanning a QR code;
 *  - it only writes to people the rest of the system has already cleared
 *    (approved suppliers, opted-in customers), never to a list;
 *  - every message is preceded by a typing indicator and a delay in proportion to
 *    its length, and there is a minimum gap between messages to the same person
 *    and between any two messages overall;
 *  - the whole session (keys included) lives encrypted in the database, so
 *    restarting the worker does not need a new scan.
 *
 * The session is held by the worker process, which is why the worker cannot run
 * on a serverless host.
 */

const logger = pino({ level: "silent" });

/**
 * Baileys is loaded on first use, with a native dynamic import. Its dependency
 * declares its entry point in a way the CommonJS loader the worker runs under
 * cannot resolve, while native ESM resolution handles it; and a worker that never
 * uses WhatsApp should not pay to load it.
 */
const loadBaileys = () => import("@whiskeysockets/baileys");

/** Minimum gap between two messages to the same person, and between any two. */
const MIN_GAP_SAME_PEER_MS = 20_000;
const MIN_GAP_ANY_MS = 3_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (base: number) => base + Math.floor(Math.random() * base * 0.5);

type KeyStore = Record<string, Record<string, unknown>>;

async function setConnection(
  db: SupabaseClient,
  merchantId: string,
  patch: { status?: "pending" | "connected" | "error" | "disconnected"; account_label?: string | null; meta?: Record<string, unknown>; secret_enc?: string | null }
) {
  const { data } = await db.from("connections").select("id, meta").eq("merchant_id", merchantId).eq("kind", "whatsapp").maybeSingle();
  const row = { ...patch, updated_at: new Date().toISOString(), ...(patch.meta ? { meta: patch.meta as never } : {}) };
  if (data) await db.from("connections").update(row).eq("id", data.id);
  else await db.from("connections").insert({ merchant_id: merchantId, kind: "whatsapp", status: "pending", ...row, meta: (patch.meta ?? {}) as never });
}

/** Baileys' auth state, kept encrypted in the connections table instead of a folder of files. */
async function dbAuthState(db: SupabaseClient, merchantId: string): Promise<{ state: AuthenticationState; save: () => void }> {
  const { BufferJSON, initAuthCreds, proto } = await loadBaileys();
  const { data } = await db.from("connections").select("secret_enc").eq("merchant_id", merchantId).eq("kind", "whatsapp").maybeSingle();
  let creds: AuthenticationCreds = initAuthCreds();
  let keys: KeyStore = {};
  if (data?.secret_enc) {
    const parsed = JSON.parse(decryptSecret(data.secret_enc), BufferJSON.reviver) as { creds: AuthenticationCreds; keys: KeyStore };
    creds = parsed.creds;
    keys = parsed.keys;
  }

  // Keys change on every message; write them out at most every couple of seconds.
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = async () => {
    timer = null;
    const blob = JSON.stringify({ creds, keys }, BufferJSON.replacer);
    await setConnection(db, merchantId, { secret_enc: encryptSecret(blob) });
  };
  const save = () => {
    if (!timer) timer = setTimeout(() => void flush().catch((e) => console.warn("[whatsapp] could not save session:", e instanceof Error ? e.message : e)), 2_000);
  };

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        const out: { [id: string]: SignalDataTypeMap[T] } = {};
        for (const id of ids) {
          let value = keys[type]?.[id] as unknown;
          if (type === "app-state-sync-key" && value) value = proto.Message.AppStateSyncKeyData.fromObject(value as object);
          if (value) out[id] = value as SignalDataTypeMap[T];
        }
        return out;
      },
      set: async (incoming) => {
        for (const category of Object.keys(incoming) as (keyof SignalDataTypeMap)[]) {
          const entries = incoming[category] ?? {};
          for (const id of Object.keys(entries)) {
            const value = (entries as Record<string, unknown>)[id];
            if (value === null || value === undefined) delete keys[category]?.[id];
            else (keys[category] ??= {})[id] = value;
          }
        }
        save();
      },
    },
  };
  return { state, save };
}

/** One merchant's WhatsApp session, held for the life of the worker. */
export class WhatsAppSession {
  private sock: WASocket | null = null;
  private inbound: InboundMessage[] = [];
  private connected = false;
  private stopped = false;
  private starting = false;
  private attempt = 0;
  private lastAny = 0;
  private lastByPeer = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: SupabaseClient,
    private readonly merchantId: string
  ) {}

  get isConnected() {
    return this.connected;
  }

  async start(): Promise<void> {
    if (this.sock || this.starting || this.stopped) return;
    this.starting = true;
    try {
      const baileys = await loadBaileys();
      const makeWASocket = baileys.default;
      const { makeCacheableSignalKeyStore, fetchLatestBaileysVersion } = baileys;
      const { state, save } = await dbAuthState(this.db, this.merchantId);
      const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
      const sock = makeWASocket({
        version,
        logger,
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
        browser: ["Mandate", "Chrome", "1.0"],
        markOnlineOnConnect: false,
        syncFullHistory: false,
      });
      this.sock = sock;

      sock.ev.on("creds.update", save);
      sock.ev.on("connection.update", (u) => void this.onConnection(u).catch((e) => console.warn("[whatsapp]", e instanceof Error ? e.message : e)));
      sock.ev.on("messages.upsert", ({ messages, type }) => {
        if (type !== "notify") return;
        for (const m of messages) {
          if (m.key.fromMe) continue;
          // WhatsApp now sometimes addresses a person by an opaque id and puts the
          // phone-number id in an alternate field; prefer the phone number.
          const key = m.key as { remoteJid?: string | null; remoteJidAlt?: string | null; id?: string | null };
          const phone = fromJid(key.remoteJidAlt) ?? fromJid(key.remoteJid);
          const text = m.message?.conversation ?? m.message?.extendedTextMessage?.text;
          if (!phone || !text || !key.id) continue; // groups, broadcasts, media-only
          this.inbound.push({
            from: `+${phone}`,
            body: text,
            externalId: key.id,
            at: m.messageTimestamp ? new Date(Number(m.messageTimestamp) * 1000) : undefined,
          });
        }
      });
    } finally {
      this.starting = false;
    }
  }

  private async onConnection(u: { connection?: string; qr?: string; lastDisconnect?: { error?: unknown } }) {
    if (u.qr) {
      const dataUrl = await QRCode.toDataURL(u.qr, { margin: 1, width: 240 });
      await setConnection(this.db, this.merchantId, { status: "pending", meta: { qr_data_url: dataUrl, qr_at: new Date().toISOString() } });
    }
    if (u.connection === "open") {
      this.connected = true;
      this.attempt = 0;
      const id = this.sock?.user?.id ?? "";
      await setConnection(this.db, this.merchantId, { status: "connected", account_label: `+${fromJid(id.replace(/:\d+@/, "@")) ?? id}`, meta: {} });
      console.log(`[whatsapp] ${this.merchantId.slice(0, 8)} connected`);
    }
    if (u.connection === "close") {
      this.connected = false;
      this.sock = null;
      const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      const { DisconnectReason } = await loadBaileys();
      if (code === DisconnectReason.loggedOut) {
        // The merchant unlinked the device from their phone. The session is
        // useless now: forget it, and let them pair again.
        this.stopped = true;
        await setConnection(this.db, this.merchantId, { status: "disconnected", secret_enc: null, meta: {}, account_label: null });
        console.log(`[whatsapp] ${this.merchantId.slice(0, 8)} logged out`);
        return;
      }
      this.attempt++;
      const delay = Math.min(60_000, 2_000 * 2 ** Math.min(this.attempt, 5));
      setTimeout(() => void this.start().catch(() => undefined), delay);
    }
  }

  drain(): InboundMessage[] {
    const out = this.inbound;
    this.inbound = [];
    return out;
  }

  /** Serialised, paced, human-shaped sending. */
  send(to: string, body: string): Promise<string> {
    const run = async (): Promise<string> => {
      const sock = this.sock;
      if (!sock || !this.connected) throw new Error("WhatsApp is not connected.");
      const jid = toJid(to);
      const peer = normalizePhone(to);

      const waitPeer = (this.lastByPeer.get(peer) ?? 0) + MIN_GAP_SAME_PEER_MS - Date.now();
      const waitAny = this.lastAny + MIN_GAP_ANY_MS - Date.now();
      const wait = Math.max(waitPeer, waitAny, 0);
      if (wait > 0) await sleep(wait);

      await sock.presenceSubscribe(jid).catch(() => undefined);
      await sleep(jitter(600));
      await sock.sendPresenceUpdate("composing", jid).catch(() => undefined);
      await sleep(jitter(Math.min(5_000, 250 + body.length * 35)));
      await sock.sendPresenceUpdate("paused", jid).catch(() => undefined);

      const sent = await sock.sendMessage(jid, { text: body });
      this.lastAny = Date.now();
      this.lastByPeer.set(peer, this.lastAny);
      return sent?.key.id ?? `wa_${Date.now()}`;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async stop() {
    this.stopped = true;
    this.sock?.end(undefined);
    this.sock = null;
    this.connected = false;
  }
}

const sessions = new Map<string, WhatsAppSession>();

/** The merchant's session, started if it is not already running. */
export function ensureWhatsApp(db: SupabaseClient, merchantId: string): WhatsAppSession {
  let s = sessions.get(merchantId);
  if (!s) {
    s = new WhatsAppSession(db, merchantId);
    sessions.set(merchantId, s);
  }
  void s.start().catch((e) => console.warn("[whatsapp] start failed:", e instanceof Error ? e.message : e));
  return s;
}

export async function stopWhatsApp(merchantId: string) {
  const s = sessions.get(merchantId);
  if (s) await s.stop();
  sessions.delete(merchantId);
}

/** Closes every WhatsApp session, for a clean shutdown. */
export async function stopAllWhatsApp() {
  await Promise.allSettled([...sessions.keys()].map((id) => stopWhatsApp(id)));
}

export class WhatsAppDriver implements ChannelDriver {
  readonly channel = "whatsapp" as const;
  readonly live = true;

  constructor(private readonly session: WhatsAppSession) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    const id = await this.session.send(message.to, message.body);
    return { externalId: id };
  }

  async poll(): Promise<InboundMessage[]> {
    return this.session.drain();
  }
}
