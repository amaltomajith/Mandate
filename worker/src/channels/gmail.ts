import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptJson } from "@/lib/secrets";
import type { ChannelDriver, InboundMessage, OutboundMessage, SendResult } from "./types";

/**
 * Gmail as a channel, over Gmail's REST API with the merchant's own OAuth grant.
 *
 * It can read and send mail from the connected account and nothing else: the
 * scopes requested are gmail.readonly and gmail.send. Which messages become part
 * of the business is decided one layer up (ChannelService): only mail from known
 * suppliers and customers, or inside a thread this system started, is kept.
 * Everything else in the inbox is ignored, not stored.
 */

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface GmailCredentials {
  refresh_token: string;
  email: string;
}

export async function loadGmailCredentials(db: SupabaseClient, merchantId: string): Promise<GmailCredentials | null> {
  const { data, error } = await db.from("connections").select("secret_enc, status").eq("merchant_id", merchantId).eq("kind", "gmail").maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.secret_enc || data.status !== "connected") return null;
  return decryptJson<GmailCredentials>(data.secret_enc);
}

// -------------------------------------------------------------------------
// Pure helpers (unit-tested in scripts/verify-channels.ts)
// -------------------------------------------------------------------------

/** RFC 2047 encoded-word for a header value that may contain non-ASCII text. */
export function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7f]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** Header values must not contain line breaks: that is how headers get injected. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export function buildRawMessage(m: { from: string; to: string; subject?: string; body: string; inReplyTo?: string }): string {
  const lines = [
    `From: ${oneLine(m.from)}`,
    `To: ${oneLine(m.to)}`,
    `Subject: ${encodeHeader(oneLine(m.subject ?? "(no subject)"))}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    ...(m.inReplyTo ? [`In-Reply-To: ${oneLine(m.inReplyTo)}`, `References: ${oneLine(m.inReplyTo)}`] : []),
    "",
    Buffer.from(m.body, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n"),
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

interface Part {
  mimeType?: string;
  body?: { data?: string };
  parts?: Part[];
  headers?: { name: string; value: string }[];
}

const decode = (data: string) => Buffer.from(data, "base64url").toString("utf8");

function findPart(part: Part | undefined, mime: string): Part | undefined {
  if (!part) return undefined;
  if (part.mimeType === mime && part.body?.data) return part;
  for (const p of part.parts ?? []) {
    const hit = findPart(p, mime);
    if (hit) return hit;
  }
  return undefined;
}

/** The plain-text body of a Gmail message payload: text/plain anywhere in the
 *  message wins, and only if there is none is the HTML flattened to text. */
export function extractPlainText(part: Part | undefined): string {
  const plain = findPart(part, "text/plain");
  if (plain?.body?.data) return decode(plain.body.data);
  const html = findPart(part, "text/html");
  if (html?.body?.data) {
    return decode(html.body.data).replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  }
  return "";
}

/** Drops the quoted history a mail client appends, so only the new reply is kept. */
export function stripQuoted(text: string): string {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^>/.test(line)) continue;
    if (/^On .{5,120} wrote:\s*$/i.test(line.trim())) break;
    if (/^-{2,}\s*(original message|forwarded message)/i.test(line.trim())) break;
    out.push(line);
  }
  return out.join("\n").trim();
}

export function parseFrom(header: string): string {
  const m = /<([^>]+)>/.exec(header);
  return (m ? m[1] : header).trim().toLowerCase();
}

// -------------------------------------------------------------------------
// Driver
// -------------------------------------------------------------------------

export class GmailDriver implements ChannelDriver {
  readonly channel = "email" as const;
  readonly live = true;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly creds: GmailCredentials) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    const id = process.env.GOOGLE_CLIENT_ID;
    const secret = process.env.GOOGLE_CLIENT_SECRET;
    if (!id || !secret) throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set.");
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: this.creds.refresh_token, grant_type: "refresh_token" }),
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!res.ok || !j.access_token) throw new Error(`Gmail authorization failed: ${j.error_description ?? res.status}. Reconnect Gmail.`);
    this.token = { value: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${await this.accessToken()}`, "content-type": "application/json", ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(20_000),
    });
    const j = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
    if (!res.ok) throw new Error(`Gmail API error: ${j.error?.message ?? res.status}`);
    return j;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const raw = buildRawMessage({ from: this.creds.email, to: message.to, subject: message.subject, body: message.body });
    const sent = await this.api<{ id: string; threadId: string }>("/messages/send", {
      method: "POST",
      body: JSON.stringify({ raw, ...(message.threadExternalId ? { threadId: message.threadExternalId } : {}) }),
    });
    return { externalId: sent.id, threadExternalId: sent.threadId };
  }

  async poll(): Promise<InboundMessage[]> {
    const list = await this.api<{ messages?: { id: string; threadId: string }[] }>(
      `/messages?q=${encodeURIComponent("in:inbox newer_than:3d")}&maxResults=25`
    );
    const out: InboundMessage[] = [];
    for (const ref of list.messages ?? []) {
      const m = await this.api<{ id: string; threadId: string; internalDate?: string; payload?: Part }>(`/messages/${ref.id}?format=full`);
      const headers = m.payload?.headers ?? [];
      const h = (name: string) => headers.find((x) => x.name.toLowerCase() === name)?.value ?? "";
      const from = parseFrom(h("from"));
      if (!from || from === this.creds.email.toLowerCase()) continue; // our own sent mail
      const body = stripQuoted(extractPlainText(m.payload));
      if (!body) continue;
      out.push({
        from,
        subject: h("subject") || undefined,
        body,
        externalId: m.id,
        threadExternalId: m.threadId,
        at: m.internalDate ? new Date(Number(m.internalDate)) : undefined,
      });
    }
    return out;
  }
}
