"use client";

import { useState } from "react";
import type { CooData } from "@/lib/cooData";
import type { PayoutInstructions } from "@/lib/manualPayouts";
import { cancelPayout, confirmPayoutPaid, loadPayoutInstructions } from "@/lib/actions/manualPayouts";
import { GhostButton, Icons, Panel, SuccessButton } from "./ui";
import { ErrorLine, Field, inputClass, inputStyle, rupees, useRunner } from "./kit";
import { TimeAgo } from "./TimeAgo";

/**
 * Payments waiting for you to make by hand.
 *
 * In manual payout mode the wall clears a payout but does not send it: it becomes
 * a card here. You pay from your own bank app (the details are shown on request,
 * with a UPI QR where it applies), then press "I've paid". Only then does the
 * wallet move and the supplier hear that they were paid. Mandate cannot see your
 * bank, so the reference you type is for your own reconciliation.
 */
export function ManualPayoutsPanel({ coo }: { coo: CooData }) {
  const { error, pending, run } = useRunner();
  const [open, setOpen] = useState<Record<string, PayoutInstructions | "loading">>({});
  const [refs, setRefs] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);

  const queued = coo.payouts.filter((p) => p.manual && p.status === "queued");
  if (queued.length === 0) return null;

  const payee = (id: string | null) => coo.payees.find((x) => x.id === id);
  const forWhat = (poId: string | null) => {
    if (!poId) return "";
    return coo.poLines
      .filter((l) => l.po_id === poId)
      .map((l) => `${l.qty} x ${coo.insights.find((i) => i.productId === l.product_id)?.name ?? "item"}`)
      .join(", ");
  };

  async function show(id: string) {
    setOpen((o) => ({ ...o, [id]: "loading" }));
    try {
      const ins = await loadPayoutInstructions(id);
      setOpen((o) => ({ ...o, [id]: ins }));
    } catch (err) {
      setOpen((o) => {
        const { [id]: _drop, ...rest } = o;
        void _drop;
        return rest;
      });
      run(async () => {
        throw err;
      });
    }
  }

  function copy(key: string, value: string) {
    void navigator.clipboard?.writeText(value);
    setCopied(key);
    setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
  }

  return (
    <Panel title="Payments for you to make" icon={<Icons.Escalation />} accent="var(--decision-escalate)" count={queued.length}>
      <p className="mb-4 max-w-2xl text-[12.5px] leading-relaxed" style={{ color: "var(--muted)" }}>
        These are cleared by the Payment Wall but not sent. Pay each one from your own bank, then confirm. Until you do, the money still counts as
        yours and the supplier has not been told it was paid.
      </p>
      <ErrorLine error={error} />
      <ul className="space-y-4">
        {queued.map((p) => {
          const ins = open[p.id];
          const loaded = ins && ins !== "loading" ? ins : null;
          const who = payee(p.payee_id);
          return (
            <li key={p.id} className="rounded-xl border p-4" style={{ borderColor: "color-mix(in srgb, var(--decision-escalate) 30%, var(--panel-border))", background: "var(--panel-2)" }}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-[22px] font-semibold leading-none tabular-nums" style={{ color: "var(--decision-escalate)" }}>
                    {rupees(Number(p.amount_paise))}
                  </p>
                  <p className="mt-1.5 text-[13px] font-medium">to {who?.display_name ?? "a supplier"}</p>
                  <p className="mt-0.5 text-[11.5px]" style={{ color: "var(--muted)" }}>
                    {forWhat(p.po_id) && <>For {forWhat(p.po_id)} · </>}
                    {who && <>Account {who.masked_identifier} · </>}
                    cleared <TimeAgo iso={p.created_at} />
                  </p>
                </div>
                {!loaded && (
                  <GhostButton disabled={ins === "loading" || pending} className="px-4" onClick={() => void show(p.id)}>
                    {ins === "loading" ? "Loading…" : "Show payment details"}
                  </GhostButton>
                )}
              </div>

              {loaded && (
                <div className="mt-4 grid gap-5 md:grid-cols-[1fr_auto]">
                  <div className="space-y-2.5 text-[13px]">
                    {loaded.details?.vpa && <Row k="UPI id" v={loaded.details.vpa} copied={copied === `${p.id}v`} onCopy={() => copy(`${p.id}v`, loaded.details!.vpa!)} />}
                    {loaded.details?.accountNumber && <Row k="Account number" v={loaded.details.accountNumber} copied={copied === `${p.id}a`} onCopy={() => copy(`${p.id}a`, loaded.details!.accountNumber!)} />}
                    {loaded.details?.ifsc && <Row k="IFSC" v={loaded.details.ifsc} copied={copied === `${p.id}i`} onCopy={() => copy(`${p.id}i`, loaded.details!.ifsc!)} />}
                    <Row k="Amount" v={rupees(loaded.amountPaise)} copied={copied === `${p.id}m`} onCopy={() => copy(`${p.id}m`, (loaded.amountPaise / 100).toFixed(2))} />
                    <Row k="Note to add" v={loaded.note} copied={copied === `${p.id}n`} onCopy={() => copy(`${p.id}n`, loaded.note)} />
                    {!loaded.details && (
                      <p className="text-[12px]" style={{ color: "var(--decision-escalate)" }}>
                        The full details were not stored for this payee (only {loaded.masked}). Find them in your own records.
                      </p>
                    )}
                    {loaded.upiLink && (
                      <a href={loaded.upiLink} className="inline-block text-[12px] underline underline-offset-2" style={{ color: "var(--brand-pink)" }}>
                        Open in a UPI app on this device
                      </a>
                    )}
                  </div>
                  {loaded.qrDataUrl && (
                    <div className="text-center">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={loaded.qrDataUrl} alt="UPI payment code" width={150} height={150} className="rounded-lg bg-white p-1.5" />
                      <p className="mt-1.5 text-[10.5px]" style={{ color: "var(--muted-2)" }}>
                        Scan with any UPI app
                      </p>
                    </div>
                  )}
                </div>
              )}

              <div className="mt-4 flex flex-wrap items-end gap-3 border-t pt-4" style={{ borderColor: "var(--panel-border)" }}>
                <div className="w-64">
                  <Field label="Payment reference (UTR), optional" hint="For your own records; it is not verified.">
                    <input className={inputClass} style={inputStyle} value={refs[p.id] ?? ""} onChange={(e) => setRefs({ ...refs, [p.id]: e.target.value })} placeholder="e.g. 4281 9921 0033" autoComplete="off" />
                  </Field>
                </div>
                <SuccessButton disabled={pending} className="px-5" onClick={() => run(() => confirmPayoutPaid(p.id, refs[p.id]))}>
                  I&apos;ve paid this
                </SuccessButton>
                <GhostButton
                  disabled={pending}
                  className="px-4"
                  onClick={() => {
                    if (confirm("Cancel this payment? Nothing has been paid, and the order goes back to draft.")) run(() => cancelPayout(p.id));
                  }}
                >
                  Cancel
                </GhostButton>
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function Row({ k, v, onCopy, copied }: { k: string; v: string; onCopy: () => void; copied: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg px-3 py-2" style={{ background: "var(--panel)" }}>
      <span className="text-[11.5px]" style={{ color: "var(--muted)" }}>
        {k}
      </span>
      <span className="flex items-center gap-3">
        <span className="font-mono text-[13px]">{v}</span>
        <button type="button" onClick={onCopy} className="text-[11px] underline underline-offset-2" style={{ color: "var(--muted)" }}>
          {copied ? "copied" : "copy"}
        </button>
      </span>
    </div>
  );
}
