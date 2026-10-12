/**
 * Bank-statement reconciliation. Parsing (pure), matching (pure), then the real
 * thing against the database: a payout the merchant confirmed is verified only
 * when the bank shows it, a re-upload adds nothing, ambiguity is never guessed,
 * a payout claimed paid that the statement never shows is flagged, and one
 * merchant's statement never touches another's payouts.
 *
 *   npx tsx --tsconfig worker/tsconfig.json scripts/verify-reconcile.ts
 */
import "./lib/loadEnv";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "../src/lib/supabase/admin";
import { ensureWorkspace } from "../src/lib/workspace";
import { parseStatement, matchStatement, reconcileStatement } from "../src/lib/reconcile";

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
const iso = (d: Date) => d.toISOString().slice(0, 10);
const ddmmyyyy = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;

async function main() {
  console.log("parsing");
  {
    const csv = [
      "Account Statement,,,,",
      "Date,Narration,Chq/Ref No,Withdrawal Amt,Deposit Amt,Balance",
      '05/03/2026,"NEFT-ACME TRADERS, PUNE",UTR12345678,"1,20,000.00",,"5,00,000.00"',
      "06-03-26,UPI/RAVI STORES/998877,998877,,3960.50,503960.50",
    ].join("\n");
    const p = parseStatement(csv);
    check("finds the header below a title line", p.rows.length === 2, JSON.stringify(p));
    check("reads Indian number grouping into paise", p.rows[0]?.debitPaise === 12_000_000 && p.rows[1]?.creditPaise === 396_050, JSON.stringify(p.rows));
    check("reads dd/mm/yyyy and dd-mm-yy", p.rows[0]?.postedOn === "2026-03-05" && p.rows[1]?.postedOn === "2026-03-06", JSON.stringify(p.rows));
    check("keeps a quoted comma inside the narration", /ACME TRADERS, PUNE/.test(p.rows[0]?.description ?? ""));
    check("takes the reference column", p.rows[0]?.ref === "UTR12345678");
    const odd = parseStatement("Date,Description,Debit,Credit\n2026-03-01,x,abc,\n,y,10,\n2026-03-02,z,50,");
    check("a bad line is reported, the rest still read", odd.rows.length === 1 && odd.problems.length === 2, JSON.stringify(odd));
    check("a file with no recognisable header says so", parseStatement("a,b,c\n1,2,3").problems.length > 0 && parseStatement("a,b,c\n1,2,3").rows.length === 0);
    check("a formula-looking narration is kept as plain text", !/^[=+@-]/.test(parseStatement("Date,Narration,Debit,Credit\n2026-03-01,=HYPERLINK(\"x\"),10,").rows[0]?.description ?? "="));
  }

  console.log("matching");
  {
    const d = (s: string) => new Date(`${s}T00:00:00Z`);
    const payouts = [
      { id: "p1", amountPaise: rupees(5000), paidRef: "UTR 111", paidAt: d("2026-03-01"), createdAt: d("2026-03-01"), status: "processed" as const },
      { id: "p2", amountPaise: rupees(700), paidRef: null, paidAt: d("2026-03-02"), createdAt: d("2026-03-02"), status: "processed" as const },
      { id: "p3", amountPaise: rupees(900), paidRef: null, paidAt: d("2026-03-02"), createdAt: d("2026-03-02"), status: "processed" as const },
      { id: "p4", amountPaise: rupees(900), paidRef: null, paidAt: d("2026-03-02"), createdAt: d("2026-03-02"), status: "processed" as const },
      { id: "p5", amountPaise: rupees(300), paidRef: null, paidAt: null, createdAt: d("2026-03-03"), status: "queued" as const },
    ];
    const row = (o: Partial<{ postedOn: string; description: string; debitPaise: number; creditPaise: number; ref: string | null }>) => ({ postedOn: "2026-03-02", description: "", debitPaise: 0, creditPaise: 0, ref: null, ...o });
    const r = matchStatement(
      [
        row({ debitPaise: rupees(5000), ref: "UTR111", description: "NEFT" }),
        row({ debitPaise: rupees(700), description: "IMPS to supplier" }),
        row({ debitPaise: rupees(900), description: "IMPS" }),
        row({ debitPaise: rupees(123), description: "other" }),
        row({ debitPaise: rupees(300), postedOn: "2026-03-04", description: "UPI" }),
      ],
      payouts,
      []
    );
    check("a reference that appears in the line verifies by reference (spacing ignored)", r.rows[0].matchedId === "p1" && r.rows[0].strength === "reference");
    check("an equal amount in the window with one candidate verifies by amount", r.rows[1].matchedId === "p2" && r.rows[1].strength === "amount");
    check("two payouts of the same amount and no reference are never guessed", r.rows[2].matchedId === null && r.ambiguous.length === 1, JSON.stringify(r.ambiguous));
    check("a debit that matches nothing is left unmatched", r.rows[3].matchedId === null);
    check("a payout still queued that the bank shows paid is reported, not auto-confirmed", r.queuedButPaid.includes("p5") && r.rows[4].matchedId === null);
    check("a payout confirmed paid that no line shows is flagged", r.claimedNotSeen.includes("p3") && r.claimedNotSeen.includes("p4") && !r.claimedNotSeen.includes("p1"));
    const wrongAmount = matchStatement([row({ debitPaise: rupees(5001), ref: "UTR111" })], payouts, []);
    check("the right reference with the wrong amount does not verify", wrongAmount.rows[0].matchedId === null);
    const far = matchStatement([row({ debitPaise: rupees(700), postedOn: "2026-06-01" })], payouts, []);
    check("an equal amount months away does not verify", far.rows[0].matchedId === null);
    const once = matchStatement([row({ debitPaise: rupees(700) }), row({ debitPaise: rupees(700) })], payouts, []);
    check("one payout is claimed by one line only", once.rows.filter((x) => x.matchedId === "p2").length === 1);
  }

  const rnd = Math.random().toString(36).slice(2, 8);
  const { data: A } = await db.from("merchants").insert({ name: "reconA", slug: `verify-recon-a-${rnd}` }).select("*").single();
  const { data: B } = await db.from("merchants").insert({ name: "reconB", slug: `verify-recon-b-${rnd}` }).select("*").single();
  await ensureWorkspace(db, A.id);
  await ensureWorkspace(db, B.id);
  try {
    const mkPayout = async (merchantId: string, amount: number, status: "queued" | "processed", ref: string | null, daysAgo = 1) => {
      const at = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
      const { data, error } = await db.from("payouts").insert({ merchant_id: merchantId, amount_paise: amount, status, manual: true, simulated: false, paid_ref: ref, paid_at: status === "processed" ? at : null, created_at: at }).select("id").single();
      if (error) throw new Error(error.message);
      return data!.id as string;
    };
    const today = new Date();
    const stmt = (lines: string[]) => ["Date,Narration,Ref,Debit,Credit", ...lines].join("\n");

    const a1 = await mkPayout(A.id, rupees(5000), "processed", "UTR9001");
    const a2 = await mkPayout(A.id, rupees(1234), "processed", null);
    const a3 = await mkPayout(A.id, rupees(777), "processed", null, 0); // never appears
    const a4 = await mkPayout(A.id, rupees(250), "queued", null);
    const b1 = await mkPayout(B.id, rupees(5000), "processed", "UTR9001");

    console.log("the database round trip");
    const csv = stmt([
      `${ddmmyyyy(today)},NEFT supplier,UTR9001,5000.00,`,
      `${ddmmyyyy(today)},IMPS supplier,,1234.00,`,
      `${ddmmyyyy(today)},UPI small,,250.00,`,
      `${ddmmyyyy(today)},SALARY,,99999.00,`,
    ]);
    const s1 = await reconcileStatement(db, A.id, csv, "verify");
    const get = async (id: string) => (await db.from("payouts").select("bank_verified_at, bank_row_id").eq("id", id).single()).data!;
    check("lines were stored", s1.added === 4, JSON.stringify(s1));
    check("a payout whose reference and amount appear is verified", !!(await get(a1)).bank_verified_at);
    check("a payout matched by amount alone is verified", !!(await get(a2)).bank_verified_at);
    check("a payout the bank never showed stays unverified", !(await get(a3)).bank_verified_at && s1.claimedNotSeen.length === 1);
    check("a queued payout the bank shows paid is reported and left queued", s1.queuedButPaid.length === 1 && (await db.from("payouts").select("status").eq("id", a4).single()).data?.status === "queued");
    check("the unmatched debit is counted", s1.unmatchedDebits === 1, JSON.stringify(s1));
    const { data: alerts } = await db.from("alerts").select("message").eq("merchant_id", A.id);
    check("a payout claimed paid but not on the statement raises an alert", (alerts ?? []).some((x) => /777/.test(x.message) && /statement/i.test(x.message)), JSON.stringify(alerts));
    check("the other merchant's payout with the same reference is untouched", !(await get(b1)).bank_verified_at);

    console.log("uploading again");
    const s2 = await reconcileStatement(db, A.id, csv, "verify");
    check("the same statement again adds nothing", s2.added === 0 && s2.duplicates === 4, JSON.stringify(s2));
    const { data: alerts2 } = await db.from("alerts").select("message").eq("merchant_id", A.id);
    check("and does not repeat the alert", (alerts2 ?? []).length === (alerts ?? []).length, String((alerts2 ?? []).length));
    const dup = stmt([`${ddmmyyyy(today)},IMPS twin,,10.00,`, `${ddmmyyyy(today)},IMPS twin,,10.00,`]);
    const s3 = await reconcileStatement(db, A.id, dup, "verify");
    check("two genuinely identical lines on one day stay two rows", s3.added === 2, JSON.stringify(s3));

    console.log("credit payments");
    const { data: cust } = await db.from("customers").insert({ merchant_id: A.id, name: "Ravi Stores", credit_limit_paise: rupees(9000), credit_terms_days: 10 }).select("id").single();
    await db.from("credit_entries").insert({ merchant_id: A.id, customer_id: cust!.id, kind: "sale", amount_paise: rupees(3000) });
    const { data: pay } = await db.from("credit_entries").insert({ merchant_id: A.id, customer_id: cust!.id, kind: "payment", amount_paise: rupees(1500), ref: "khatapay_test" }).select("id").single();
    const s4 = await reconcileStatement(db, A.id, stmt([`${ddmmyyyy(today)},UPI/RAVI STORES/55,,,1500.00`]), "verify");
    const row = (await db.from("bank_statement_rows").select("matched_kind, matched_id").eq("merchant_id", A.id).eq("credit_paise", rupees(1500))).data?.[0];
    check("a customer's payment is matched to the khata entry", row?.matched_kind === "credit_payment" && row?.matched_id === pay!.id, JSON.stringify({ s4, row }));
    const noClaim = await reconcileStatement(db, B.id, stmt([`${ddmmyyyy(today)},UPI/RAVI STORES/55,,,1500.00`]), "verify");
    check("another merchant's statement cannot match it", noClaim.matchedCredits === 0, JSON.stringify(noClaim));

    console.log("bad input");
    const bad = await reconcileStatement(db, A.id, "nothing useful", "verify").then(() => "ok", (e) => String(e.message));
    check("a file that is not a statement is refused in words", /statement/i.test(bad), bad);
    const big = await reconcileStatement(db, A.id, stmt(Array.from({ length: 5001 }, (_, i) => `${ddmmyyyy(today)},x${i},,1.00,`)), "verify").then(() => "ok", (e) => String(e.message));
    check("an enormous file is refused", /too many|5,?000/i.test(big), big);
    void iso;
  } finally {
    await db.from("merchants").delete().in("id", [A.id, B.id]);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
