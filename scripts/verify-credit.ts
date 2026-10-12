/**
 * Khata: selling on credit, collecting it, and the guarantees around both. The
 * limits live in the database, so these hammer them in parallel: a per-customer
 * limit, an overall cap, stock, exactly-once on a retry, and credit that is not
 * money (not wallet, not revenue) until it is paid. Database only.
 *
 *   npx tsx --tsconfig worker/tsconfig.json scripts/verify-credit.ts
 */
import "./lib/loadEnv";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "../src/lib/supabase/admin";
import { ensureWorkspace } from "../src/lib/workspace";
import { getCooData } from "../src/lib/cooData";
import { getReceivables, receivePayment, sellOnCredit, writeOff } from "../src/lib/credit";

const db = createAdminClient() as unknown as SupabaseClient;
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
const rupees = (n: number) => n * 100;

async function main() {
  const rnd = Math.random().toString(36).slice(2, 8);
  const { data: m } = await db.from("merchants").insert({ name: "khata", slug: `verify-khata-${rnd}` }).select("*").single();
  const { data: other } = await db.from("merchants").insert({ name: "khata other", slug: `verify-khata-o-${rnd}` }).select("*").single();
  await ensureWorkspace(db, m.id);
  await ensureWorkspace(db, other.id);
  try {
    const { data: product } = await db.from("products").select("id, sku").eq("merchant_id", m.id).limit(1).single();
    const sku = product!.sku as string;
    await db.from("products").update({ price_paise: rupees(1000), stock_qty: 50, active: true }).eq("id", product!.id);
    const mkCustomer = async (name: string, limit: number, extra: Record<string, unknown> = {}) =>
      (await db.from("customers").insert({ merchant_id: m.id, name, email: `${name}-${rnd}@x.test`, credit_limit_paise: rupees(limit), ...extra }).select("*").single()).data!;
    const stock = async () => Number((await db.from("products").select("stock_qty").eq("id", product!.id).single()).data!.stock_qty);
    const walletTotal = async () => ((await db.from("wallet_entries").select("direction, amount_paise, kind").eq("merchant_id", m.id).eq("kind", "sale")).data ?? []).reduce((n, r) => n + (r.direction === "credit" ? 1 : -1) * Number(r.amount_paise), 0);
    const owed = async (id: string) => Number((await db.rpc("credit_balance", { p_merchant: m.id, p_customer: id })).data);

    const ravi = await mkCustomer("ravi", 5000);
    const none = await mkCustomer("nocredit", 0);

    console.log("who may buy on credit");
    {
      const r = await sellOnCredit(db, m.id, none.id, [{ sku, qty: 1 }], "t");
      check("a customer with no limit is refused", !r.ok && r.reason === "no_credit");
      const x = await sellOnCredit(db, other.id, ravi.id, [{ sku, qty: 1 }], "t").catch((e) => e);
      check("another merchant cannot use this customer", (x instanceof Error) || (!x.ok && x.reason === "unknown_customer"), JSON.stringify(x));
      check("an unknown product is refused", await sellOnCredit(db, m.id, ravi.id, [{ sku: "no-such-sku", qty: 1 }], "t").then(() => false, () => true));
      check("nothing was recorded by those refusals", (await owed(ravi.id)) === 0 && (await stock()) === 50);
    }

    console.log("a credit sale is not money");
    const wallet0 = await walletTotal();
    const earned0 = (await getCooData(db as never, m.id)).kpis.earned7dPaise;
    {
      const r = await sellOnCredit(db, m.id, ravi.id, [{ sku, qty: 3 }], "owner");
      check("selling 3 at a thousand each, within the limit, works", r.ok && r.owedPaise === rupees(3000), JSON.stringify(r));
      check("the price came from the catalogue", (await owed(ravi.id)) === rupees(3000));
      check("stock came off the shelf", (await stock()) === 47);
      check("the wallet was not credited", (await walletTotal()) === wallet0);
      check("it is not revenue for the payout budget", (await getCooData(db as never, m.id)).kpis.earned7dPaise === earned0);
      const { data: due } = await db.from("credit_entries").select("due_at").eq("customer_id", ravi.id).eq("kind", "sale").single();
      check("it falls due after the customer's terms", Math.abs(new Date(due!.due_at).getTime() - (Date.now() + 15 * 86_400_000)) < 120_000);
    }

    console.log("the limit holds");
    {
      const over = await sellOnCredit(db, m.id, ravi.id, [{ sku, qty: 3 }], "owner");
      check("going over the limit is refused", !over.ok && over.reason === "over_limit", JSON.stringify(over));
      check("and nothing moved", (await owed(ravi.id)) === rupees(3000) && (await stock()) === 47);
      // 2,000 of headroom: of six simultaneous sales of one unit, exactly two may succeed.
      const racers = await Promise.all(Array.from({ length: 6 }, () => sellOnCredit(db, m.id, ravi.id, [{ sku, qty: 1 }], "owner")));
      const ok = racers.filter((r) => r.ok).length;
      check("six at once against two units of headroom: exactly two go through", ok === 2, `${ok} (${racers.map((r) => (r.ok ? "ok" : r.reason)).join(",")})`);
      check("the customer never owes more than the limit", (await owed(ravi.id)) === rupees(5000), String((await owed(ravi.id)) / 100));
      check("and stock fell by exactly what was sold", (await stock()) === 45, String(await stock()));
    }

    console.log("a retry is the same sale");
    {
      const priya = await mkCustomer("priya", 10000);
      const ref = `retry-${rnd}`;
      const [a, b, c] = await Promise.all([1, 2, 3].map(() => sellOnCredit(db, m.id, priya.id, [{ sku, qty: 1 }], "owner", ref)));
      check("the same ref three times books once", [a, b, c].every((r) => r.ok) && (await owed(priya.id)) === rupees(1000), String((await owed(priya.id)) / 100));
      const entries = ((await db.from("credit_entries").select("id").eq("customer_id", priya.id)).data ?? []).length;
      check("one entry, one set of sales rows", entries === 1 && ((await db.from("sales").select("id").eq("merchant_id", m.id).like("razorpay_payment_id", "credit_%")).data ?? []).length >= 1);
    }

    console.log("the overall cap holds");
    {
      await db.from("merchant_settings").update({ credit_exposure_cap_paise: rupees(7000) }).eq("merchant_id", m.id);
      const lal = await mkCustomer("lal", 20000);
      // Owed now: ravi 5,000 + priya 1,000 = 6,000. Room for 1,000 more.
      const big = await sellOnCredit(db, m.id, lal.id, [{ sku, qty: 2 }], "owner");
      check("a sale that would exceed the overall cap is refused", !big.ok && big.reason === "over_exposure", JSON.stringify(big));
      const racers = await Promise.all(Array.from({ length: 4 }, () => sellOnCredit(db, m.id, lal.id, [{ sku, qty: 1 }], "owner")));
      check("four at once against room for one: exactly one goes through", racers.filter((r) => r.ok).length === 1, racers.map((r) => (r.ok ? "ok" : r.reason)).join(","));
      await db.from("merchant_settings").update({ credit_exposure_cap_paise: rupees(50000) }).eq("merchant_id", m.id);
    }

    console.log("stock");
    {
      const sam = await mkCustomer("sam", 100000);
      await db.from("products").update({ stock_qty: 1 }).eq("id", product!.id);
      const r = await sellOnCredit(db, m.id, sam.id, [{ sku, qty: 2 }], "owner");
      check("selling more than is on the shelf is refused", !r.ok && r.reason === "out_of_stock", JSON.stringify(r));
      check("and the stock is untouched", (await stock()) === 1);
      await db.from("products").update({ stock_qty: 40 }).eq("id", product!.id);
    }

    console.log("collecting");
    {
      const before = await walletTotal();
      const earnedBefore = (await getCooData(db as never, m.id)).kpis.earned7dPaise;
      const r = await receivePayment(db, m.id, ravi.id, rupees(2000), "owner", { ref: `pay-${rnd}-1` });
      check("a part payment is accepted", r.ok && r.owedPaise === rupees(3000), JSON.stringify(r));
      check("the wallet is credited with exactly what was paid", (await walletTotal()) === before + rupees(2000));
      check("and now it is revenue", (await getCooData(db as never, m.id)).kpis.earned7dPaise === earnedBefore + rupees(2000));
      const w = (await db.from("wallet_entries").select("simulated").eq("merchant_id", m.id).eq("ref_type", "khata")).data ?? [];
      check("a real-looking customer's payment is not marked simulated", w.length === 1 && w[0].simulated === false);

      const more = await receivePayment(db, m.id, ravi.id, rupees(9999), "owner");
      check("paying more than is owed is refused", !more.ok && more.reason === "more_than_owed");

      const dup = await Promise.all(Array.from({ length: 5 }, () => receivePayment(db, m.id, ravi.id, rupees(500), "owner", { ref: `pay-${rnd}-2` })));
      check("the same payment delivered five times is booked once", dup.every((x) => x.ok) && (await owed(ravi.id)) === rupees(2500), String((await owed(ravi.id)) / 100));
      check("and credited once", (await walletTotal()) === before + rupees(2500));

      const racers = await Promise.all(Array.from({ length: 5 }, (_, i) => receivePayment(db, m.id, ravi.id, rupees(1000), "owner", { ref: `pay-${rnd}-r${i}` })));
      check("five different payments of 1,000 against 2,500 owed: exactly two go through", racers.filter((x) => x.ok).length === 2, racers.map((x) => (x.ok ? "ok" : x.reason)).join(","));
      check("the balance never goes below zero", (await owed(ravi.id)) === rupees(500), String((await owed(ravi.id)) / 100));
      check("the wallet matches what was actually collected", (await walletTotal()) === before + rupees(4500), String(((await walletTotal()) - before) / 100));
    }

    console.log("a sandbox customer's payment is marked simulated");
    {
      const sb = await mkCustomer("sbx", 5000, { email: `sbx-${rnd}@buyer.sandbox.test` });
      await sellOnCredit(db, m.id, sb.id, [{ sku, qty: 1 }], "owner");
      await receivePayment(db, m.id, sb.id, rupees(1000), "owner");
      const w = (await db.from("wallet_entries").select("simulated, amount_paise").eq("merchant_id", m.id).eq("ref_type", "khata").order("created_at", { ascending: false }).limit(1)).data ?? [];
      check("its wallet credit is simulated", w[0]?.simulated === true);
    }

    console.log("writing off");
    {
      const before = await walletTotal();
      const r = await writeOff(db, m.id, ravi.id, rupees(500), "owner");
      check("what is owed can be written off", r.ok && r.owedPaise === 0, JSON.stringify(r));
      check("no money arrives", (await walletTotal()) === before);
      check("writing off more than is owed is refused", !(await writeOff(db, m.id, ravi.id, rupees(1), "owner")).ok);
    }

    console.log("who owes what");
    {
      const tina = await mkCustomer("tina", 10000, { credit_terms_days: 10 });
      await sellOnCredit(db, m.id, tina.id, [{ sku, qty: 2 }], "owner");
      await sellOnCredit(db, m.id, tina.id, [{ sku, qty: 1 }], "owner");
      const entries = ((await db.from("credit_entries").select("id, created_at").eq("customer_id", tina.id).eq("kind", "sale").order("created_at")).data ?? []);
      // The first sale fell due yesterday, the second is not due for a week.
      await db.from("credit_entries").update({ due_at: new Date(Date.now() - 86_400_000).toISOString() }).eq("id", entries[0].id);
      let t = (await getReceivables(db, m.id)).find((x) => x.customerId === tina.id)!;
      check("it totals what is owed and what is past due", t.owedPaise === rupees(3000) && t.overduePaise === rupees(2000), JSON.stringify(t));
      await receivePayment(db, m.id, tina.id, rupees(1500), "owner");
      t = (await getReceivables(db, m.id)).find((x) => x.customerId === tina.id)!;
      check("a part payment settles the oldest sale first", t.owedPaise === rupees(1500) && t.overduePaise === rupees(500), JSON.stringify(t));
      await receivePayment(db, m.id, tina.id, rupees(500), "owner");
      t = (await getReceivables(db, m.id)).find((x) => x.customerId === tina.id)!;
      check("once the overdue sale is paid nothing is overdue", t.owedPaise === rupees(1000) && t.overduePaise === 0 && !!t.lastPaymentAt, JSON.stringify(t));
      check("a customer with no limit and no history is not listed", !(await getReceivables(db, m.id)).some((x) => x.customerId === none.id));
    }
  } finally {
    await db.from("merchants").delete().eq("id", m.id);
    await db.from("merchants").delete().eq("id", other.id);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
