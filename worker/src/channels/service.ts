import type { SupabaseClient } from "@supabase/supabase-js";
import type { Channel, Thread } from "@/types/db";
import type { ChannelDriver, InboundMessage, SandboxContext } from "./types";
import { normalizePhone } from "./phone";

const MAX_BODY = 20_000;

/** Lets the worker route the owner's own messages elsewhere. */
export interface OwnerRoute {
  isOwner(from: string): boolean;
  handle(text: string): Promise<unknown>;
}

export interface SendOptions {
  kind: "vendor" | "buyer";
  vendorId?: string;
  customerId?: string;
  subject?: string;
  body: string;
  /** Structured context kept on the thread, e.g. { rfq: { sku, qty } }. */
  meta?: Record<string, unknown>;
  /** What the sandbox needs to answer believably. `round` and `counterparty` are filled in here. */
  sandbox?: DistributiveOmit<SandboxContext, "round" | "counterparty">;
  runId?: string;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * Sends and records conversations, whatever the channel.
 *
 * Two rules live here because they are about people, not agents:
 *  - In sandbox mode nothing reaches a real vendor or customer, whatever an agent
 *    asks for. Simulated contacts are answered by the sandbox driver.
 *  - Agents only start conversations with contacts they may contact: approved
 *    vendors, and customers who opted in.
 */
export class ChannelService {
  constructor(
    readonly db: SupabaseClient,
    readonly merchantId: string,
    readonly mode: "sandbox" | "live",
    private readonly drivers: Map<Channel, ChannelDriver>
  ) {}

  private driverFor(channel: Channel, simulated: boolean): ChannelDriver {
    if (simulated || channel === "sandbox") {
      const d = this.drivers.get("sandbox");
      if (!d) throw new Error("The sandbox channel is not available.");
      return d;
    }
    if (this.mode === "sandbox") {
      throw new Error("The merchant is in sandbox mode, so real contacts are not messaged. Switch to live mode in Connections.");
    }
    const d = this.drivers.get(channel);
    if (!d) throw new Error(`The ${channel} channel is not connected.`);
    return d;
  }

  async send(opts: SendOptions): Promise<{ threadId: string; messageId: string | null; replies: number }> {
    const db = this.db;
    let counterparty: string;
    let address: string;
    let channel: Channel;
    let simulated: boolean;
    let notes: string | null = null;
    let vendorId: string | null = null;
    let customerId: string | null = null;

    if (opts.kind === "vendor") {
      if (!opts.vendorId) throw new Error("A vendor message needs a vendor.");
      const { data: v, error } = await db.from("vendors").select("*").eq("id", opts.vendorId).eq("merchant_id", this.merchantId).maybeSingle();
      if (error) throw new Error(error.message);
      if (!v) throw new Error("Unknown vendor.");
      if (v.status !== "approved") throw new Error(`${v.name} is ${v.status}, and agents only contact approved vendors.`);
      counterparty = v.name;
      channel = v.channel;
      simulated = v.simulated;
      notes = v.notes;
      vendorId = v.id;
      const a = channel === "whatsapp" ? v.phone : v.email;
      if (!a) throw new Error(`${v.name} has no ${channel === "whatsapp" ? "phone number" : "email address"} on file.`);
      address = a;
    } else {
      if (!opts.customerId) throw new Error("A buyer message needs a customer.");
      const { data: c, error } = await db.from("customers").select("*").eq("id", opts.customerId).eq("merchant_id", this.merchantId).maybeSingle();
      if (error) throw new Error(error.message);
      if (!c) throw new Error("Unknown customer.");
      // Replying to someone who wrote to us is fine; starting a conversation is not.
      const { count } = await db
        .from("threads")
        .select("id", { count: "exact", head: true })
        .eq("merchant_id", this.merchantId)
        .eq("customer_id", c.id);
      if (!c.marketing_opt_in && (count ?? 0) === 0) throw new Error(`${c.name} has not opted in to messages.`);
      counterparty = c.name;
      customerId = c.id;
      simulated = (c.email ?? "").endsWith(".sandbox.test");
      channel = simulated ? "sandbox" : c.phone && this.drivers.has("whatsapp") ? "whatsapp" : "email";
      const a = channel === "whatsapp" ? c.phone : c.email;
      if (!a) throw new Error(`${c.name} has no contact on file for ${channel}.`);
      address = a;
    }

    const driver = this.driverFor(channel, simulated);

    // One open thread per party (and per quote request), so a reply lands in the
    // conversation it belongs to.
    const rfqSku = (opts.meta?.rfq as { sku?: string } | undefined)?.sku;
    const offerSku = (opts.meta?.offer as { sku?: string } | undefined)?.sku;
    let q = db.from("threads").select("*").eq("merchant_id", this.merchantId).eq("kind", opts.kind).eq("status", "open");
    q = vendorId ? q.eq("vendor_id", vendorId) : q.eq("customer_id", customerId!);
    if (rfqSku) q = q.eq("meta->rfq->>sku", rfqSku);
    if (offerSku) q = q.eq("meta->offer->>sku", offerSku);
    const { data: existing } = await q.order("created_at", { ascending: false }).limit(1).maybeSingle();
    let thread = existing as Thread | null;
    if (!thread) {
      const { data: created, error } = await db
        .from("threads")
        .insert({
          merchant_id: this.merchantId,
          channel: driver.channel === "sandbox" ? "sandbox" : channel,
          kind: opts.kind,
          counterparty: address,
          vendor_id: vendorId,
          customer_id: customerId,
          subject: opts.subject ?? null,
          meta: (opts.meta ?? {}) as never,
        })
        .select("*")
        .single();
      if (error) throw new Error(error.message);
      thread = created as Thread;
    }

    if (thread && opts.meta && Object.keys(opts.meta).length > 0) {
      const merged = { ...((thread.meta as Record<string, unknown>) ?? {}), ...opts.meta };
      await db.from("threads").update({ meta: merged as never }).eq("id", thread.id);
      thread = { ...thread, meta: merged as never };
    }

    const { count: inboundCount } = await db
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("thread_id", thread.id)
      .eq("direction", "in");
    const round = inboundCount ?? 0;

    const result = await driver.send({
      to: address,
      subject: opts.subject,
      body: opts.body.slice(0, MAX_BODY),
      threadExternalId: thread.external_thread_id ?? undefined,
      context: opts.sandbox ? ({ ...opts.sandbox, counterparty, notes, round } as SandboxContext) : undefined,
    });

    // The message has now left. Recording it is bookkeeping, and a failure here
    // must not make the call look as if it failed: the caller would send it again,
    // and a supplier would get the same email twice. So the record is retried a few
    // times, and if it still cannot be written the send is reported as done (with
    // no message id) and the gap is logged loudly.
    let out: { id: string } | null = null;
    let lastError = "";
    for (let attempt = 0; attempt < 3 && !out; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 200 * 4 ** (attempt - 1)));
      const { data, error: msgError } = await db
        .from("messages")
        .insert({
          merchant_id: this.merchantId,
          thread_id: thread.id,
          direction: "out",
          body: opts.body.slice(0, MAX_BODY),
          external_id: result.externalId,
          untrusted: false,
          handled: true,
          agent_run_id: opts.runId ?? null,
          simulated: !driver.live,
        })
        .select("id")
        .single();
      if (msgError) lastError = msgError.message;
      else out = data;
    }
    if (!out) {
      console.error(`[channels] a message to ${counterparty} WAS SENT (external id ${result.externalId ?? "none"}) but could not be recorded: ${lastError}`);
    }

    await db
      .from("threads")
      .update({ last_message_at: new Date().toISOString(), ...(result.threadExternalId && !thread.external_thread_id ? { external_thread_id: result.threadExternalId } : {}) })
      .eq("id", thread.id);

    let replies = 0;
    for (const r of result.replies ?? []) {
      await this.recordInbound(driver, r, thread);
      replies++;
    }
    return { threadId: thread.id, messageId: out?.id ?? null, replies };
  }

  /** Stores an inbound message. Always untrusted, always unhandled until an agent acts on it. */
  private async recordInbound(driver: ChannelDriver, msg: InboundMessage, thread: Thread): Promise<void> {
    const { error } = await this.db.from("messages").upsert(
      {
        merchant_id: this.merchantId,
        thread_id: thread.id,
        direction: "in",
        body: msg.body.slice(0, MAX_BODY),
        external_id: msg.externalId,
        untrusted: true,
        handled: false,
        simulated: !driver.live,
        created_at: (msg.at ?? new Date()).toISOString(),
      },
      { onConflict: "merchant_id,thread_id,external_id", ignoreDuplicates: true }
    );
    if (error) throw new Error(error.message);
    await this.db.from("threads").update({ last_message_at: new Date().toISOString() }).eq("id", thread.id);
  }

  /** Pulls new messages from every live driver and files them. Returns how many were new. */
  async ingest(owner?: OwnerRoute): Promise<number> {
    let n = 0;
    for (const driver of this.drivers.values()) {
      if (!driver.live) continue;
      let inbound: InboundMessage[] = [];
      try {
        inbound = await driver.poll();
      } catch (err) {
        console.warn(`[channels] ${driver.channel} poll failed:`, err instanceof Error ? err.message : err);
        continue;
      }
      for (const msg of inbound) {
        // The owner's own number is never a supplier or a buyer: it goes to the owner handler and is not filed.
        if (owner && driver.channel === "whatsapp" && owner.isOwner(msg.from)) {
          await owner.handle(msg.body);
          driver.ack?.(msg.externalId);
          continue;
        }
        const thread = await this.threadFor(driver, msg);
        if (!thread) {
          driver.ack?.(msg.externalId); // a stranger: deliberately ignored, not worth fetching again
          continue;
        }
        await this.recordInbound(driver, msg, thread);
        driver.ack?.(msg.externalId); // only after it is safely filed
        n++;
      }
    }
    return n;
  }

  /** Which conversation an inbound message belongs to. Unknown senders are
   *  ignored on email (spam) and treated as prospective buyers on WhatsApp. */
  private async threadFor(driver: ChannelDriver, msg: InboundMessage): Promise<Thread | null> {
    const db = this.db;
    if (msg.threadExternalId) {
      const { data } = await db
        .from("threads")
        .select("*")
        .eq("merchant_id", this.merchantId)
        .eq("channel", driver.channel)
        .eq("external_thread_id", msg.threadExternalId)
        .maybeSingle();
      if (data) return data as Thread;
    }
    let vendorId: string | null = null;
    let customerId: string | null = null;
    if (driver.channel === "whatsapp") {
      // Phone numbers are written many ways; compare them in one canonical form.
      const want = normalizePhone(msg.from);
      const [vendors, customers] = await Promise.all([
        db.from("vendors").select("id, phone").eq("merchant_id", this.merchantId).not("phone", "is", null),
        db.from("customers").select("id, phone").eq("merchant_id", this.merchantId).not("phone", "is", null),
      ]);
      vendorId = (vendors.data ?? []).find((v) => normalizePhone(v.phone ?? "") === want)?.id ?? null;
      customerId = (customers.data ?? []).find((c) => normalizePhone(c.phone ?? "") === want)?.id ?? null;
    } else {
      const from = msg.from.toLowerCase();
      vendorId = (await db.from("vendors").select("id").eq("merchant_id", this.merchantId).ilike("email", from).maybeSingle()).data?.id ?? null;
      customerId = (await db.from("customers").select("id").eq("merchant_id", this.merchantId).ilike("email", from).maybeSingle()).data?.id ?? null;
    }
    if (vendorId) return this.openThread(driver.channel, "vendor", { vendorId }, msg);
    if (customerId) return this.openThread(driver.channel, "buyer", { customerId }, msg);
    if (driver.channel === "whatsapp") return this.openThread(driver.channel, "buyer", {}, msg);
    return null;
  }

  private async openThread(
    channel: Channel,
    kind: "vendor" | "buyer",
    who: { vendorId?: string; customerId?: string },
    msg: InboundMessage
  ): Promise<Thread> {
    let q = this.db.from("threads").select("*").eq("merchant_id", this.merchantId).eq("kind", kind).eq("channel", channel).eq("status", "open");
    if (who.vendorId) q = q.eq("vendor_id", who.vendorId);
    else if (who.customerId) q = q.eq("customer_id", who.customerId);
    else q = q.eq("counterparty", msg.from);
    const { data: existing } = await q.order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (existing) return existing as Thread;
    const { data, error } = await this.db
      .from("threads")
      .insert({
        merchant_id: this.merchantId,
        channel,
        kind,
        counterparty: msg.from,
        vendor_id: who.vendorId ?? null,
        customer_id: who.customerId ?? null,
        external_thread_id: msg.threadExternalId ?? null,
        subject: msg.subject ?? null,
      })
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return data as Thread;
  }
}
