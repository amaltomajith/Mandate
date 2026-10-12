"use client";

import { useRef, useState } from "react";
import type { CooData } from "@/lib/cooData";
import type { ReconcileSummary } from "@/lib/reconcile";
import { uploadBankStatement } from "@/lib/actions/manualPayouts";
import { EmptyState, Icons, Panel, PrimaryButton } from "./ui";
import { ErrorLine, Pill, Table, rupees, useRunner } from "./kit";

const day = (iso: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" }).format(new Date(iso));

/**
 * Check what you paid against what your bank shows. A payout you confirmed is only
 * your word until a bank statement line backs it; this turns it into a fact, and
 * points out anything that does not add up. It never moves money or confirms a
 * payment for you.
 */
export function BankStatementPanel({ coo }: { coo: CooData }) {
  const { error, pending, run } = useRunner();
  const input = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<ReconcileSummary | null>(null);

  const paid = coo.payouts.filter((p) => p.manual && p.status === "processed");
  const name = (id: string | null) => coo.payees.find((x) => x.id === id)?.display_name ?? "Supplier";

  const choose = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 900_000) {
      run(async () => {
        throw new Error("That file is too large. Export a shorter date range from your bank.");
      });
      return;
    }
    const text = await file.text();
    run(async () => setResult(await uploadBankStatement(text)));
    if (input.current) input.current.value = "";
  };

  return (
    <Panel
      title="Bank statement check"
      description="Upload the CSV your bank gives you. Payments you confirmed are marked once the bank shows them."
      icon={<Icons.Shield />}
      accent="var(--entity-transaction)"
      action={
        <>
          <input ref={input} type="file" accept=".csv,text/csv" className="sr-only" aria-label="Bank statement CSV" onChange={(e) => choose(e.target.files?.[0])} />
          <PrimaryButton disabled={pending} onClick={() => input.current?.click()}>
            {pending ? "Checking…" : "Upload statement"}
          </PrimaryButton>
        </>
      }
    >
      <ErrorLine error={error} />
      {result && (
        <div className="surface-tile mb-5 p-5" role="status">
          <p className="text-[15px] font-medium">
            {result.added === 0 ? "Nothing new in that file." : `${result.added} new line${result.added === 1 ? "" : "s"} read.`}
            {result.duplicates > 0 && <span style={{ color: "var(--muted)" }}> {result.duplicates} already seen.</span>}
          </p>
          <ul className="mt-2 space-y-1 text-[14px]" style={{ color: "var(--muted)" }}>
            <li>{result.verified} payment{result.verified === 1 ? "" : "s"} you made confirmed by the bank.</li>
            {result.matchedCredits > 0 && <li>{result.matchedCredits} customer payment{result.matchedCredits === 1 ? "" : "s"} matched.</li>}
            {result.claimedNotSeen.length > 0 && <li style={{ color: "var(--decision-block)" }}>{result.claimedNotSeen.length} payment{result.claimedNotSeen.length === 1 ? "" : "s"} you marked paid {result.claimedNotSeen.length === 1 ? "is" : "are"} not on this statement. Check {result.claimedNotSeen.length === 1 ? "it" : "them"}.</li>}
            {result.queuedButPaid.length > 0 && <li>{result.queuedButPaid.length} payment{result.queuedButPaid.length === 1 ? "" : "s"} still waiting for you {result.queuedButPaid.length === 1 ? "looks" : "look"} already paid. Confirm {result.queuedButPaid.length === 1 ? "it" : "them"} above.</li>}
            {result.ambiguous > 0 && <li>{result.ambiguous} line{result.ambiguous === 1 ? "" : "s"} could be more than one payment, so none was guessed. Add the reference when you confirm.</li>}
            {result.problems.length > 0 && <li>{result.problems.length} line{result.problems.length === 1 ? "" : "s"} could not be read: {result.problems[0]}</li>}
          </ul>
        </div>
      )}
      {paid.length === 0 ? (
        <EmptyState text="No payments to check yet." hint="Payments you confirm by hand appear here." />
      ) : (
        <Table head={["Supplier", "Amount", "Paid", "Bank"]}>
          {paid.slice(0, 12).map((p) => (
            <tr key={p.id}>
              <td className="text-[15px] font-medium">{name(p.payee_id)}</td>
              <td className="num">{rupees(Number(p.amount_paise))}</td>
              <td>{p.paid_at ? day(p.paid_at) : "—"}</td>
              <td>{p.bank_verified_at ? <Pill color="var(--decision-allow)">Seen in bank</Pill> : <Pill>Not checked</Pill>}</td>
            </tr>
          ))}
        </Table>
      )}
    </Panel>
  );
}
