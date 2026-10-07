import "server-only";

/**
 * Registering a supplier's bank or UPI account with RazorpayX.
 *
 * The account number or UPI id is sent here, to Razorpay, and nowhere else: the
 * database keeps only a masked form and Razorpay's ids. So even the dashboard's
 * own tables never hold the full details, and an agent (which never sees any of
 * this) has nothing to leak.
 */

const API = "https://api.razorpay.com/v1";

type Creds = { key_id: string; key_secret: string };

async function call<T>(creds: Creds, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Basic ${Buffer.from(`${creds.key_id}:${creds.key_secret}`).toString("base64")}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: { description?: string } };
  if (!res.ok) throw new Error(`RazorpayX refused this: ${json.error?.description ?? `HTTP ${res.status}`}`);
  return json;
}

export type PayeeDetails =
  | { kind: "bank"; accountNumber: string; ifsc: string }
  | { kind: "upi"; vpa: string };

export function validatePayeeDetails(d: PayeeDetails): void {
  if (d.kind === "bank") {
    if (!/^\d{6,18}$/.test(d.accountNumber)) throw new Error("A bank account number is 6 to 18 digits.");
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(d.ifsc)) throw new Error("An IFSC code looks like HDFC0001234.");
  } else if (!/^[\w.-]{2,}@[A-Za-z]{2,}$/.test(d.vpa)) {
    throw new Error("A UPI id looks like name@bank.");
  }
}

/** What is safe to keep and show: enough to recognise the account, not enough to use it. */
export function maskPayee(d: PayeeDetails): string {
  if (d.kind === "bank") return `••••${d.accountNumber.slice(-4)}`;
  const [name, handle] = d.vpa.split("@");
  return `${name.slice(0, 2)}••@${handle}`;
}

export async function createFundAccount(
  creds: Creds,
  name: string,
  details: PayeeDetails
): Promise<{ contactId: string; fundAccountId: string }> {
  const contact = await call<{ id: string }>(creds, "/contacts", { name, type: "vendor" });
  const fund = await call<{ id: string }>(
    creds,
    "/fund_accounts",
    details.kind === "bank"
      ? { contact_id: contact.id, account_type: "bank_account", bank_account: { name, ifsc: details.ifsc, account_number: details.accountNumber } }
      : { contact_id: contact.id, account_type: "vpa", vpa: { address: details.vpa } }
  );
  return { contactId: contact.id, fundAccountId: fund.id };
}
