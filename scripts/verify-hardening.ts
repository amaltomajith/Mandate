/**
 * Fixes that came out of the independent security review, each pinned by a test.
 * Pure logic only: no database, no server.
 *
 *   npx tsx --tsconfig worker/tsconfig.json scripts/verify-hardening.ts
 */
import { withLock } from "../src/lib/mutex";
import { isOperator } from "../src/lib/operator";
import { allow, allowDashboardAction, clientIp } from "../src/lib/rateLimit";
import { senderAuthenticated } from "../worker/src/channels/gmail";
import { AgentStatusSchema, ChannelModeSchema, IdSchema, PayeeNameSchema, PayoutModeSchema, VendorInputSchema, VendorStatusSchema } from "../src/lib/actions/schemas";
import { assertPublicUrl } from "../worker/src/mcp/research";
import { groundedIn } from "../worker/src/agents/quotes";
import { ActionInput } from "../src/lib/mcp/schemas";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

async function main() {
  console.log("per-merchant serialisation");
  {
    const order: string[] = [];
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await Promise.all([
      withLock("m1", async () => { order.push("a-start"); await sleep(40); order.push("a-end"); }),
      withLock("m1", async () => { order.push("b-start"); await sleep(5); order.push("b-end"); }),
      withLock("m2", async () => { order.push("c-start"); await sleep(5); order.push("c-end"); }),
    ]);
    check("calls for one merchant do not overlap", order.indexOf("a-end") < order.indexOf("b-start"), order.join(","));
    check("a different merchant is not held up by it", order.indexOf("c-end") < order.indexOf("a-end"), order.join(","));
    let after = false;
    await withLock("m3", async () => { throw new Error("boom"); }).catch(() => undefined);
    await withLock("m3", async () => { after = true; });
    check("a failure does not wedge the lock", after);
  }

  console.log("operator gate");
  {
    const prev = process.env.MANDATE_OPERATOR_EMAILS;
    delete process.env.MANDATE_OPERATOR_EMAILS;
    check("with no operators configured, nobody may borrow server keys", !isOperator("anyone@x.test"));
    process.env.MANDATE_OPERATOR_EMAILS = "Boss@Shop.test, other@shop.test";
    check("a listed email is the operator, case-insensitively", isOperator("boss@shop.test") && isOperator("OTHER@shop.test"));
    check("an unlisted one is not", !isOperator("stranger@x.test") && !isOperator(null) && !isOperator(""));
    if (prev === undefined) delete process.env.MANDATE_OPERATOR_EMAILS;
    else process.env.MANDATE_OPERATOR_EMAILS = prev;
  }

  console.log("rate limiting");
  {
    const key = `t:${Math.random()}`;
    const results = Array.from({ length: 5 }, () => allow(key, 3, 60_000));
    check("the first calls are allowed and the rest refused", results.join() === "true,true,true,false,false", results.join());
    check("another key is unaffected", allow(`other:${Math.random()}`, 3, 60_000));
    const spoof = new Headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" });
    check("a client-chosen first hop is not trusted", clientIp(spoof) === "203.0.113.9", clientIp(spoof));
    check("the platform's own header is preferred", clientIp(new Headers({ "x-vercel-forwarded-for": "198.51.100.7", "x-forwarded-for": "1.1.1.1" })) === "198.51.100.7");
  }

  console.log("mail sender authentication");
  {
    check("DKIM pass is accepted when it aligns with the From domain", senderAuthenticated("mx.google.com; dkim=pass header.i=@acme.in; spf=pass", "sales@acme.in"));
    check("DKIM pass for a subdomain of the From domain aligns", senderAuthenticated("mx.google.com; dkim=pass header.d=mail.acme.in", "sales@acme.in"));
    check("DKIM pass from ANOTHER domain is not enough (spoofed From)", !senderAuthenticated("mx.google.com; dkim=pass header.i=@attacker.example; spf=pass", "sales@acme.in"));
    check("DKIM pass with no From to align against is not enough", !senderAuthenticated("mx.google.com; dkim=pass header.i=@acme.in"));
    check("a lookalike domain does not align", !senderAuthenticated("mx.google.com; dkim=pass header.d=notacme.in", "sales@acme.in"));
    check("a bare top-level domain does not align", !senderAuthenticated("mx.google.com; dkim=pass header.d=in", "sales@acme.in"));
    check("DMARC pass is accepted", senderAuthenticated("mx.google.com; spf=fail; dmarc=pass (p=REJECT)"));
    check("an SPF-only pass is not enough", !senderAuthenticated("mx.google.com; spf=pass smtp.mailfrom=acme.in"));
    check("a failure is rejected", !senderAuthenticated("mx.google.com; dkim=fail; dmarc=fail"));
    check("a missing header is rejected", !senderAuthenticated(""));
  }

  console.log("a price is only grounded as a whole number");
  {
    check("a real price is found", groundedIn("We can do ₹2,600 per unit.", 2600));
    check("also unformatted", groundedIn("price 2600 each", 2600));
    check("a digit inside a bigger number is not a price", !groundedIn("The order is for ₹2,500 total", 5));
    check("nor inside a lakh figure", !groundedIn("Pay ₹5,00,000 now", 500));
    check("nor after a decimal point", !groundedIn("a 12.5% discount", 5));
    check("a number not present at all is not found", !groundedIn("We can do ₹2,600 per unit.", 2800));
    check("after a currency symbol and dot-style prefix", groundedIn("Rs.2600/-", 2600));
  }

  console.log("the research fetch refuses more than the obvious");
  {
    for (const bad of ["http://198.18.0.1/", "http://100.64.0.1/", "http://192.0.0.5/", "http://203.0.113.5/", "http://[fec0::1]/", "http://[64:ff9b::7f00:1]/", "http://[::ffff:127.0.0.1]/", "http://foo.localhost/"]) {
      let refused = false;
      try {
        await assertPublicUrl(bad);
      } catch {
        refused = true;
      }
      check(`refuses ${bad}`, refused);
    }
  }

  console.log("the wall's input contract");
  {
    const base = { actionType: "payout.create", amount: 100, params: { payeeId: "11111111-1111-4111-8111-111111111111", poId: "22222222-2222-4222-8222-222222222222" } };
    check("INR is accepted", ActionInput.safeParse({ ...base, currency: "INR" }).success);
    check("INR is the default", ActionInput.safeParse(base).success);
    check("any other currency is rejected", !ActionInput.safeParse({ ...base, currency: "USD" }).success);
    check("a payout without an order is rejected", !ActionInput.safeParse({ ...base, params: { payeeId: base.params.payeeId } }).success);
    check("a refund's payment id must be a plain token", !ActionInput.safeParse({ actionType: "refund.create", amount: 1, params: { paymentId: "a,b.eq.c" } }).success);
    check("a normal payment id is accepted", ActionInput.safeParse({ actionType: "refund.create", amount: 1, params: { paymentId: "pay_Abc123" } }).success);
  }

  console.log("dashboard action inputs");
  {
    const long = (n: number) => "x".repeat(n);
    const uuid = "6f1c2f3e-3b0a-4f0e-9a52-0d6a2b1c7e11";
    check("an id must be a uuid", IdSchema.safeParse(uuid).success && !IdSchema.safeParse("1; drop table").success && !IdSchema.safeParse("").success);
    check("an agent status is active or paused only", AgentStatusSchema.safeParse("paused").success && !AgentStatusSchema.safeParse("retired").success && !AgentStatusSchema.safeParse(undefined).success);
    check("a channel mode is sandbox or live only", ChannelModeSchema.safeParse("live").success && !ChannelModeSchema.safeParse("production").success);
    check("a payout mode is auto or manual only", PayoutModeSchema.safeParse("manual").success && !PayoutModeSchema.safeParse("both").success);
    check("a vendor status is approved, blocked or candidate only", VendorStatusSchema.safeParse("blocked").success && !VendorStatusSchema.safeParse("active").success);
    const vendor = { name: "Kumar Traders", channel: "email", email: "sales@kumar.in", categories: ["electronics"] };
    check("a normal supplier is accepted", VendorInputSchema.safeParse(vendor).success);
    check("a supplier name over 120 characters is refused", !VendorInputSchema.safeParse({ ...vendor, name: long(121) }).success);
    check("an email that is not an email is refused", !VendorInputSchema.safeParse({ ...vendor, email: "not-an-email" }).success);
    check("an oversized email is refused", !VendorInputSchema.safeParse({ ...vendor, email: `${long(250)}@a.in` }).success);
    check("a phone number must look like one", VendorInputSchema.safeParse({ ...vendor, channel: "whatsapp", email: undefined, phone: "+919876543210" }).success && !VendorInputSchema.safeParse({ ...vendor, phone: "call me maybe" }).success);
    check("a website must be an http(s) address", VendorInputSchema.safeParse({ ...vendor, website: "https://kumar.in" }).success && !VendorInputSchema.safeParse({ ...vendor, website: "javascript:alert(1)" }).success);
    check("notes are capped", !VendorInputSchema.safeParse({ ...vendor, notes: long(1001) }).success);
    check("categories are capped in number and length", !VendorInputSchema.safeParse({ ...vendor, categories: Array.from({ length: 11 }, () => "a") }).success && !VendorInputSchema.safeParse({ ...vendor, categories: [long(41)] }).success);
    check("a payee's display name is bounded", PayeeNameSchema.safeParse("Kumar Traders").success && !PayeeNameSchema.safeParse(long(121)).success && !PayeeNameSchema.safeParse("").success);
  }

  console.log("dashboard action rate limit");
  {
    const user = `user_${Math.random()}`;
    const first = Array.from({ length: 240 }, () => allowDashboardAction(user)).every(Boolean);
    check("a person's normal use (240 actions a minute) is never refused", first);
    check("past that, further actions are refused", !allowDashboardAction(user));
    check("another person is unaffected", allowDashboardAction(`user_${Math.random()}`));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
