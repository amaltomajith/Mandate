import "server-only";

/**
 * RazorpayX (Payouts, Contacts, Fund Accounts) isn't wrapped by the `razorpay` npm
 * SDK — it only covers Orders/Payments/Refunds/Subscriptions. RazorpayX shares the
 * same base URL and Basic Auth scheme, so this is a small REST client instead of a
 * second SDK dependency. Verified against Razorpay's own API docs (docs.razorpay.com,
 * /docs/api/x/*) rather than assumed.
 *
 * Operational note (real, not hypothetical): RazorpayX requires allowlisting the
 * calling server's IP in the RazorpayX dashboard before `/payouts` will accept
 * requests, even in test mode. If payouts 403 with an IP-related error, that's why —
 * see HANDOVER.md.
 */

const RAZORPAYX_BASE = "https://api.razorpay.com/v1";

export class RazorpayXError extends Error {
  constructor(message: string, public status: number, public raw: unknown) {
    super(message);
    this.name = "RazorpayXError";
  }
}

function authHeader(): string {
  const id = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!id || !secret) throw new Error("RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set.");
  return "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");
}

async function rpxFetch<T>(
  path: string,
  options: { method?: string; body?: unknown; idempotencyKey?: string } = {}
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: authHeader(),
    "Content-Type": "application/json",
  };
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

  const res = await fetch(`${RAZORPAYX_BASE}${path}`, {
    method: options.method ?? "POST",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      (json && typeof json === "object" && "error" in json
        ? (json as { error?: { description?: string } }).error?.description
        : null) ?? `RazorpayX request to ${path} failed with ${res.status}`;
    throw new RazorpayXError(message, res.status, json);
  }
  return json as T;
}

export interface RazorpayXContact {
  id: string;
  name: string;
  [key: string]: unknown;
}

export async function createContact(input: {
  name: string;
  type?: string;
  email?: string;
  referenceId?: string;
}): Promise<RazorpayXContact> {
  return rpxFetch<RazorpayXContact>("/contacts", {
    body: {
      name: input.name,
      type: input.type ?? "vendor",
      email: input.email,
      reference_id: input.referenceId,
    },
  });
}

export interface RazorpayXFundAccount {
  id: string;
  [key: string]: unknown;
}

export async function createVpaFundAccount(
  contactId: string,
  vpaAddress: string
): Promise<RazorpayXFundAccount> {
  return rpxFetch<RazorpayXFundAccount>("/fund_accounts", {
    body: {
      contact_id: contactId,
      account_type: "vpa",
      vpa: { address: vpaAddress },
    },
  });
}

export interface RazorpayXPayout {
  id: string;
  status: string;
  [key: string]: unknown;
}

export async function createPayout(input: {
  fundAccountId: string;
  amount: number; // paise
  currency?: string;
  mode?: "UPI" | "IMPS" | "NEFT" | "RTGS";
  purpose?: string;
  referenceId?: string;
  narration?: string;
}): Promise<RazorpayXPayout> {
  const accountNumber = process.env.RAZORPAYX_ACCOUNT_NUMBER;
  if (!accountNumber) throw new Error("RAZORPAYX_ACCOUNT_NUMBER is not set.");

  return rpxFetch<RazorpayXPayout>("/payouts", {
    idempotencyKey: crypto.randomUUID(),
    body: {
      account_number: accountNumber,
      fund_account_id: input.fundAccountId,
      amount: input.amount,
      currency: input.currency ?? "INR",
      mode: input.mode ?? "UPI",
      purpose: input.purpose ?? "payout",
      queue_if_low_balance: true,
      reference_id: input.referenceId,
      narration: input.narration,
    },
  });
}
