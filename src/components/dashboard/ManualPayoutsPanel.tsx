"use client";

import { useState } from "react";
import type { CooData } from "@/lib/cooData";
import type { PayoutInstructions } from "@/lib/manualPayouts";
import { cancelPayout, confirmPayoutPaid, loadPayoutInstructions } from "@/lib/actions/manualPayouts";
import { GhostButton, Icons, Panel, SuccessButton } from "./ui";
import { ErrorLine, Field, inputClass, inputStyle, rupees, useRunner } from "./kit";
import { TimeAgo } from "./TimeAgo";
import { ConfirmSheet } from "./motion";

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
  const [cancelId, setCancelId] = useState<string | null>(null);

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
    <Panel title="Payments for you to make" description="Cleared by the Payment Wall, waiting for you to pay." icon={<Icons.Escalation />} accent="var(--decision-escalate)" count={queued.length}>
      <p className="mb-5 max-w-2xl text-[14px] leading-6" style={{ color: "var(--muted)" }}>
        Pay each one from your own bank, then confirm. Until you do, the money still counts as yours and the supplier has not been told it was paid.
      </p>
      <ErrorLine error={error} />
      <ul className="space-y-4">
        {queued.map((p) => {
          const ins = open[p.id];
          const loaded = ins && ins !== "loading" ? ins : null;
          const who = payee(p.payee_id);
          return (
            <li key={p.id} className="surface-tile p-6" style={{ borderColor: "color-mix(in srgb, var(--decision-escalate) 35%, var(--hairline))" }}>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="num text-[32px] font-semibold leading-[36px]" style={{ color: "var(--decision-escalate)" }}>
                    {rupees(Number(p.amount_paise))}
                  </p>
                  <p className="mt-2 text-[16px] font-medium">to {who?.display_name ?? "a supplier"}</p>
                  <p className="mt-1 text-[14px] leading-6" style={{ color: "var(--muted)" }}>
                    {forWhat(p.po_id) && <>For {forWhat(p.po_id)}. </>}
                    {who && <>Account {who.masked_identifier}. </>}
                    Cleared <TimeAgo iso={p.created_at} />.
                  </p>
                </div>
                {!loaded && (
                  <GhostButton disabled={ins === "loading" || pending} onClick={() => void show(p.id)}>
                    {ins === "loading" ? "Loading…" : "Show payment details"}
                  </GhostButton>
                )}
              </div>

              {loaded && (
                <div className="mt-5 grid gap-6 md:grid-cols-[1fr_auto]">
                  <div className="space-y-2.5">
                    {loaded.details?.vpa && <Row k="UPI id" v={loaded.details.vpa} copied={copied === `${p.id}v`} onCopy={() => copy(`${p.id}v`, loaded.details!.vpa!)} />}
                    {loaded.details?.accountNumber && <Row k="Account number" v={loaded.details.accountNumber} copied={copied === `${p.id}a`} onCopy={() => copy(`${p.id}a`, loaded.details!.accountNumber!)} />}
                    {loaded.details?.ifsc && <Row k="IFSC" v={loaded.details.ifsc} copied={copied === `${p.id}i`} onCopy={() => copy(`${p.id}i`, loaded.details!.ifsc!)} />}
                    <Row k="Amount" v={rupees(loaded.amountPaise)} copied={copied === `${p.id}m`} onCopy={() => copy(`${p.id}m`, (loaded.amountPaise / 100).toFixed(2))} />
                    <Row k="Note to add" v={loaded.note} copied={copied === `${p.id}n`} onCopy={() => copy(`${p.id}n`, loaded.note)} />
                    {!loaded.details && (
                      <p className="text-[14px] leading-6" style={{ color: "var(--decision-escalate)" }}>
                        The full details were not stored for this payee (only {loaded.masked}). Find them in your own records.
                      </p>
                    )}
                    {loaded.upiLink && (
                      <a href={loaded.upiLink} className="inline-block text-[14px] underline underline-offset-4" style={{ color: "var(--brand-pink)" }}>
                        Open in a UPI app on this device
                      </a>
                    )}
                  </div>
                  {loaded.qrDataUrl && (
                    <div className="text-center">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={loaded.qrDataUrl} alt="UPI payment code" width={168} height={168} className="rounded-[14px] bg-white p-2" />
                      <p className="mt-2 text-[13px]" style={{ color: "var(--muted-2)" }}>
                        Scan with any UPI app
                      </p>
                    </div>
                  )}
                </div>
              )}

              <div className="mt-6 flex flex-wrap items-end gap-3 border-t pt-6" style={{ borderColor: "var(--hairline)" }}>
                <div className="min-w-[240px] flex-1">
                  <Field label="Payment reference (UTR), optional" hint="For your own records; it is not verified.">
                    <input className={inputClass} style={inputStyle} value={refs[p.id] ?? ""} onChange={(e) => setRefs({ ...refs, [p.id]: e.target.value })} placeholder="e.g. 4281 9921 0033" autoComplete="off" />
                  </Field>
                </div>
                <SuccessButton disabled={pending} className="px-6" onClick={() => run(() => confirmPayoutPaid(p.id, refs[p.id]))}>
                  I&apos;ve paid this
                </SuccessButton>
                <GhostButton disabled={pending} onClick={() => setCancelId(p.id)}>
                  Cancel
                </GhostButton>
              </div>
            </li>
          );
        })}
      </ul>
      <ConfirmSheet
        open={cancelId !== null}
        danger
        title="Cancel this payment?"
        body="Nothing has been paid. The order goes back to draft and the weekly budget it was holding is released."
        confirmLabel="Cancel the payment"
        onClose={() => setCancelId(null)}
        onConfirm={() => {
          const id = cancelId;
          if (id) run(() => cancelPayout(id));
        }}
      />
    </Panel>
  );
}

function Row({ k, v, onCopy, copied }: { k: string; v: string; onCopy: () => void; copied: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-[12px] bg-white/[0.04] px-4 py-3">
      <span className="text-[14px]" style={{ color: "var(--muted)" }}>
        {k}
      </span>
      <span className="flex items-center gap-4">
        <span className="num text-[15px]">{v}</span>
        <button type="button" onClick={onCopy} className="focus-ring rounded-md px-2 py-1 text-[13px] font-medium transition-colors hover:bg-white/10" style={{ color: copied ? "var(--decision-allow)" : "var(--muted)" }}>
          {copied ? "Copied" : "Copy"}
        </button>
      </span>
    </div>
  );
}
