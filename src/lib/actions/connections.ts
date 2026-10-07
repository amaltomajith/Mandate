"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireDashboardUser } from "./authGuard";
import { getCurrentMerchant } from "@/lib/merchant";
import { decryptJson, encryptJson } from "@/lib/secrets";
import type { ConnectionKind } from "@/types/db";

/**
 * The merchant's connections: Razorpay, RazorpayX, web search. (Gmail and
 * WhatsApp connect through their own flows, an OAuth redirect and a QR scan.)
 *
 * Secrets are encrypted before they are stored and never returned: the dashboard
 * reads only a status and a label. A key that has been saved cannot be read back
 * out through any action here, only replaced or disconnected.
 */

async function scope() {
  await requireDashboardUser();
  return { merchant: await getCurrentMerchant(), db: createAdminClient() };
}

async function put(
  merchantId: string,
  kind: ConnectionKind,
  row: { status: "connected" | "pending" | "error" | "disconnected"; account_label: string | null; secret?: unknown; meta?: Record<string, unknown> }
) {
  const { error } = await createAdminClient()
    .from("connections")
    .upsert(
      {
        merchant_id: merchantId,
        kind,
        status: row.status,
        account_label: row.account_label,
        secret_enc: row.secret === undefined ? null : encryptJson(row.secret),
        meta: (row.meta ?? {}) as never,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "merchant_id,kind" }
    );
  if (error) throw new Error(error.message);
}

/** Checks a key pair against Razorpay before keeping it, so a typo is caught now, not mid-sale. */
async function verifyRazorpayKeys(keyId: string, keySecret: string): Promise<void> {
  const res = await fetch("https://api.razorpay.com/v1/payments?count=1", {
    headers: { authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401) throw new Error("Razorpay rejected those keys. Check the key id and secret.");
  if (!res.ok && res.status !== 400) throw new Error(`Razorpay could not check those keys (HTTP ${res.status}). Try again.`);
}

const RazorpayInput = z.object({
  keyId: z.string().regex(/^rzp_(test|live)_[A-Za-z0-9]+$/, "A Razorpay key id looks like rzp_test_xxxxxxxx"),
  keySecret: z.string().min(8),
  webhookSecret: z.string().optional(),
});

export async function connectRazorpay(input: z.infer<typeof RazorpayInput>): Promise<void> {
  const { merchant } = await scope();
  const v = RazorpayInput.parse(input);
  await verifyRazorpayKeys(v.keyId, v.keySecret);
  await put(merchant.id, "razorpay", {
    status: "connected",
    account_label: v.keyId.startsWith("rzp_live_") ? `${v.keyId} (live)` : `${v.keyId} (test)`,
    secret: { key_id: v.keyId, key_secret: v.keySecret, webhook_secret: v.webhookSecret || undefined },
  });
  revalidatePath("/dashboard");
}

/**
 * Borrow the deployment's own Razorpay test keys. Meant for someone running their
 * own instance who wants real test-mode links without pasting keys again. The
 * server's secret is never copied into the database; the connection only says
 * "use the server's".
 */
export async function connectServerRazorpayKeys(): Promise<void> {
  const { merchant } = await scope();
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) throw new Error("This server has no Razorpay keys configured.");
  await put(merchant.id, "razorpay", { status: "connected", account_label: `${process.env.RAZORPAY_KEY_ID} (server keys)`, meta: { source: "env" } });
  revalidatePath("/dashboard");
}

const RazorpayXInput = z.object({ accountNumber: z.string().regex(/^\d{6,20}$/, "A RazorpayX account number is 6 to 20 digits.") });

/** RazorpayX reuses the Razorpay key pair; this adds the account payouts are drawn from. */
export async function connectRazorpayX(input: z.infer<typeof RazorpayXInput>): Promise<void> {
  const { merchant, db } = await scope();
  const v = RazorpayXInput.parse(input);
  const { data: base } = await db.from("connections").select("secret_enc, status, meta").eq("merchant_id", merchant.id).eq("kind", "razorpay").maybeSingle();
  if (!base || base.status !== "connected") throw new Error("Connect Razorpay first; RazorpayX uses the same keys.");
  const keys =
    (base.meta as { source?: string } | null)?.source === "env"
      ? { key_id: process.env.RAZORPAY_KEY_ID!, key_secret: process.env.RAZORPAY_KEY_SECRET! }
      : decryptJson<{ key_id: string; key_secret: string }>(base.secret_enc!);
  await put(merchant.id, "razorpayx", {
    status: "connected",
    account_label: `Account ending ${v.accountNumber.slice(-4)}`,
    secret: { key_id: keys.key_id, key_secret: keys.key_secret, account_number: v.accountNumber },
  });
  revalidatePath("/dashboard");
}

const SearchInput = z.object({ provider: z.enum(["brave", "tavily"]), key: z.string().min(8) });

export async function connectSearch(input: z.infer<typeof SearchInput>): Promise<void> {
  const { merchant } = await scope();
  const v = SearchInput.parse(input);
  await put(merchant.id, "search", { status: "connected", account_label: v.provider, secret: { provider: v.provider, key: v.key } });
  revalidatePath("/dashboard");
}

export async function disconnect(kind: ConnectionKind): Promise<void> {
  const { merchant, db } = await scope();
  const { error } = await db.from("connections").delete().eq("merchant_id", merchant.id).eq("kind", kind);
  if (error) throw new Error(error.message);
  revalidatePath("/dashboard");
}
