"use client";

import { useState, type ReactNode } from "react";
import { Bank, CreditCard, EnvelopeSimple, GlobeSimple, WhatsappLogo, Flask, Lightning } from "@phosphor-icons/react";
import type { ConnectionKind } from "@/types/db";
import type { CooData, SafeConnection } from "@/lib/cooData";
import { connectRazorpay, connectRazorpayX, connectSearch, disconnect, connectServerRazorpayKeys } from "@/lib/actions/connections";
import { saveOwnerChannel, setChannelMode, setPayoutMode, setWhatsAppEnabled } from "@/lib/actions/team";
import { GhostButton, PrimaryButton } from "./ui";
import { ErrorLine, Field, Pill, inputClass, inputStyle, useRunner } from "./kit";
import { ConfirmSheet, Reveal } from "./motion";
import { TimeAgo } from "./TimeAgo";

/** The owner's own WhatsApp: a briefing each morning, and answering a held payout with a code. */
function OwnerPanel({ coo, pending, run }: { coo: CooData; pending: boolean; run: (fn: () => Promise<unknown>) => void }) {
  const s = coo.settings;
  const [phone, setPhone] = useState(s.owner_phone ?? "");
  const [approvals, setApprovals] = useState(s.owner_approvals_enabled);
  const [briefing, setBriefing] = useState(s.owner_briefing_enabled);
  const [max, setMax] = useState(String(Math.round(Number(s.owner_approval_max_paise) / 100)));
  const maxNum = Number(max);
  const valid = Number.isFinite(maxNum) && maxNum >= 1 && (phone.trim() !== "" || (!approvals && !briefing));
  return (
    <div>
      <p className="mb-5 max-w-3xl text-[15px] leading-6" style={{ color: "var(--muted)" }}>
        Get a short briefing each morning, and answer a held payout from your phone by replying with a one-time code. Use your own personal number, not the one your team sends from. Only that number is ever treated as you. A code works once, expires in 10 minutes, and payouts above your ceiling can only be approved here on the dashboard.
      </p>
      <div className="flex flex-wrap items-end gap-5">
        <div className="w-64 max-w-full">
          <Field label="Your WhatsApp number">
            <input className={inputClass} style={inputStyle} inputMode="tel" placeholder="+91 98765 43210" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
        </div>
        <div className="w-56 max-w-full">
          <Field label="Approve by reply up to (Rs)">
            <input className={inputClass} style={inputStyle} inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value.replace(/[^0-9]/g, ""))} />
          </Field>
        </div>
      </div>
      <div className="mt-5 flex flex-wrap gap-x-8 gap-y-3">
        <label className="flex cursor-pointer items-center gap-3 text-[15px]">
          <input type="checkbox" className="h-5 w-5 accent-[#7c5cff]" checked={briefing} onChange={(e) => setBriefing(e.target.checked)} />
          Morning briefing
        </label>
        <label className="flex cursor-pointer items-center gap-3 text-[15px]">
          <input type="checkbox" className="h-5 w-5 accent-[#7c5cff]" checked={approvals} onChange={(e) => setApprovals(e.target.checked)} />
          Approve held payouts by reply
        </label>
      </div>
      <div className="mt-5">
        <PrimaryButton disabled={pending || !valid} className="px-6" onClick={() => run(() => saveOwnerChannel({ phone: phone.trim(), approvals, briefing, maxRupees: maxNum }))}>
          Save
        </PrimaryButton>
      </div>
      {coo.ownerMessages.length > 0 && (
        <div className="mt-7">
          <p className="mb-3 text-[13px] font-medium" style={{ color: "var(--muted)" }}>
            Recent messages to you
          </p>
          <ul className="space-y-2.5">
            {coo.ownerMessages.map((m) => (
              <li key={m.id} className="surface-tile p-4">
                <p className="whitespace-pre-line text-[14px] leading-6">{m.body}</p>
                <p className="mt-1.5 text-[12px]" style={{ color: "var(--muted-2)" }}>
                  {m.delivered ? "Sent to your phone" : "Not sent (sandbox, or WhatsApp not connected)"}, <TimeAgo iso={m.created_at} />
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Tile({ title, icon, connected, children, wide, index }: { title: string; icon: ReactNode; connected: boolean; children: ReactNode; wide?: boolean; index: number }) {
  return (
    <Reveal index={index} className={`h-full ${wide ? "lg:col-span-2" : ""}`}>
      <section className="surface flex h-full flex-col p-7">
        <div className="mb-5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <span className="flex h-12 w-12 items-center justify-center rounded-[14px]" style={{ background: "color-mix(in srgb, var(--brand-violet) 16%, transparent)", color: "var(--brand-pink)" }}>
              {icon}
            </span>
            <h2 className="text-[19px] font-semibold tracking-[-0.01em]">{title}</h2>
          </div>
          <Pill color={connected ? "var(--decision-allow)" : "var(--muted)"}>{connected ? "Connected" : "Not connected"}</Pill>
        </div>
        {children}
      </section>
    </Reveal>
  );
}

const copy = "text-[15px] leading-6";

/**
 * Where the business plugs in. Secrets go in once and are never shown again; this
 * page only ever sees a status and a label.
 */
export function ConnectionsTab({
  coo,
  slug,
  appUrl,
  serverHasRazorpayKeys,
  googleConfigured,
}: {
  coo: CooData;
  slug: string;
  appUrl: string;
  serverHasRazorpayKeys: boolean;
  googleConfigured: boolean;
}) {
  const { error, pending, run } = useRunner();
  const [goLive, setGoLive] = useState(false);
  const by = (k: ConnectionKind): SafeConnection | undefined => coo.connections.find((c) => c.kind === k);
  const on = (k: ConnectionKind) => by(k)?.status === "connected";
  const live = coo.settings.channel_mode === "live";
  const [rz, setRz] = useState({ keyId: "", keySecret: "", webhook: "" });
  const [rx, setRx] = useState("");
  const [search, setSearch] = useState({ provider: "brave" as "brave" | "tavily", key: "" });
  const hook = `${appUrl.replace(/\/$/, "")}/api/webhooks/razorpay/${slug}`;
  const qr = (by("whatsapp")?.meta as { qr_data_url?: string } | null)?.qr_data_url;

  return (
    <div className="flex flex-col gap-8">
      <ErrorLine error={error} />

      <Reveal>
        <section className="surface overflow-hidden p-8" style={{ borderColor: live ? "color-mix(in srgb, var(--decision-escalate) 45%, transparent)" : undefined }}>
          <div className="flex flex-wrap items-start justify-between gap-6">
            <div className="flex max-w-2xl items-start gap-5">
              <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-[16px]" style={{ background: `color-mix(in srgb, ${live ? "var(--decision-escalate)" : "var(--entity-mandate)"} 16%, transparent)`, color: live ? "var(--decision-escalate)" : "var(--entity-mandate)" }}>
                {live ? <Lightning size={30} weight="fill" /> : <Flask size={30} weight="fill" />}
              </span>
              <div>
                <p className="text-[24px] font-semibold leading-[30px] tracking-tight">{live ? "You are live" : "You are in the sandbox"}</p>
                <p className={`mt-2 ${copy}`} style={{ color: "var(--muted)" }}>
                  In the <strong style={{ color: "var(--foreground)" }}>sandbox</strong>, your team rehearses with simulated suppliers and buyers: nothing is sent to a real person and no real money moves. When{" "}
                  <strong style={{ color: "var(--foreground)" }}>live</strong>, it messages real contacts through your connected Gmail and WhatsApp, and uses your Razorpay accounts. Everything still passes the Payment Wall and your guardrails either way.
                </p>
              </div>
            </div>
            <GhostButton disabled={pending} className="px-6" onClick={() => (live ? run(() => setChannelMode("sandbox")) : setGoLive(true))}>
              {live ? "Back to sandbox" : "Go live"}
            </GhostButton>
          </div>
        </section>
      </Reveal>

      <Reveal index={1}>
        <section className="surface p-8">
          <div className="mb-6">
            <p className="text-[19px] font-semibold tracking-[-0.01em]">How suppliers get paid</p>
            <p className={`mt-1.5 max-w-2xl ${copy}`} style={{ color: "var(--muted)" }}>
              Either way the Payment Wall decides first, with the same limits, budget and approvals. The difference is the last step.
            </p>
          </div>
          <div className="grid gap-5 md:grid-cols-2">
            {([
              { mode: "auto" as const, title: "Automatic (RazorpayX)", body: "Approved payouts are sent through RazorpayX. Needs a RazorpayX account below. Without one, payouts run on the labelled sandbox and no money moves.", Icon: Bank },
              { mode: "manual" as const, title: "By hand (your own bank)", body: "An approved payout becomes a task on Today with the supplier's details and a UPI QR. You pay from your bank app and confirm. Needs no RazorpayX account.", Icon: CreditCard },
            ]).map((o) => {
              const selected = coo.settings.payout_mode === o.mode;
              return (
                <button
                  key={o.mode}
                  type="button"
                  disabled={pending}
                  onClick={() => run(() => setPayoutMode(o.mode))}
                  aria-pressed={selected}
                  className="surface-interactive focus-ring rounded-[18px] border p-6 text-left disabled:opacity-50"
                  style={{
                    borderColor: selected ? "var(--brand-violet)" : "var(--hairline-strong)",
                    background: selected ? "color-mix(in srgb, var(--brand-violet) 12%, transparent)" : "rgba(255,255,255,0.02)",
                    boxShadow: selected ? "0 0 0 1px var(--brand-violet), 0 18px 40px -24px rgba(82,39,255,0.9)" : undefined,
                  }}
                >
                  <span className="flex items-center justify-between">
                    <o.Icon size={28} style={{ color: selected ? "var(--brand-pink)" : "var(--muted)" }} />
                    {selected && <Pill color="var(--brand-pink)">Selected</Pill>}
                  </span>
                  <p className="mt-4 text-[17px] font-semibold tracking-[-0.01em]">{o.title}</p>
                  <p className="mt-1.5 text-[14px] leading-6" style={{ color: "var(--muted)" }}>
                    {o.body}
                  </p>
                </button>
              );
            })}
          </div>
          {coo.settings.payout_mode === "manual" && (
            <p className="mt-5 text-[14px] leading-6" style={{ color: "var(--muted-2)" }}>
              Suppliers you add from now on keep their payment details encrypted, for showing to you when you pay. Suppliers added earlier in automatic mode will show only the last digits.
            </p>
          )}
        </section>
      </Reveal>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Tile index={2} title="Razorpay" icon={<CreditCard size={26} />} connected={on("razorpay")} wide>
          <p className={`mb-5 ${copy}`} style={{ color: "var(--muted)" }}>
            For payment links and refunds. {by("razorpay")?.account_label && <>Connected as <strong style={{ color: "var(--foreground)" }}>{by("razorpay")?.account_label}</strong>. </>}Without it, links are labelled sandbox links that no buyer can pay.
          </p>
          {on("razorpay") ? (
            <div>
              <GhostButton disabled={pending} onClick={() => run(() => disconnect("razorpay"))}>
                Disconnect
              </GhostButton>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
                <Field label="Key id">
                  <input className={inputClass} style={inputStyle} autoComplete="off" value={rz.keyId} onChange={(e) => setRz({ ...rz, keyId: e.target.value })} placeholder="rzp_test_..." />
                </Field>
                <Field label="Key secret">
                  <input className={inputClass} style={inputStyle} type="password" autoComplete="off" value={rz.keySecret} onChange={(e) => setRz({ ...rz, keySecret: e.target.value })} />
                </Field>
                <Field label="Webhook secret" hint="Optional now; needed to book payments automatically">
                  <input className={inputClass} style={inputStyle} type="password" autoComplete="off" value={rz.webhook} onChange={(e) => setRz({ ...rz, webhook: e.target.value })} />
                </Field>
              </div>
              <div className="mt-6 flex flex-wrap gap-3">
                <PrimaryButton
                  disabled={pending}
                  className="px-6"
                  onClick={() =>
                    run(async () => {
                      await connectRazorpay({ keyId: rz.keyId.trim(), keySecret: rz.keySecret.trim(), webhookSecret: rz.webhook.trim() || undefined });
                      setRz({ keyId: "", keySecret: "", webhook: "" });
                    })
                  }
                >
                  {pending ? "Checking…" : "Connect"}
                </PrimaryButton>
                {serverHasRazorpayKeys && (
                  <GhostButton disabled={pending} onClick={() => run(() => connectServerRazorpayKeys())}>
                    Use this server&apos;s test keys
                  </GhostButton>
                )}
              </div>
            </>
          )}
          <p className="mt-6 text-[14px] leading-6" style={{ color: "var(--muted-2)" }}>
            Point Razorpay&apos;s webhook (events <code>payment.captured</code>, <code>payment_link.paid</code>, <code>payout.*</code>) at:
          </p>
          <code className="num mt-2 block break-all rounded-[12px] bg-white/[0.04] px-4 py-3 text-[13px]">{hook}</code>
        </Tile>

        <Tile index={3} title="RazorpayX payouts" icon={<Bank size={26} />} connected={on("razorpayx")}>
          <p className={`mb-5 ${copy}`} style={{ color: "var(--muted)" }}>
            How suppliers get paid automatically. Needs a RazorpayX account. Without it, payouts run on the labelled sandbox executor and no money moves.
          </p>
          {on("razorpayx") ? (
            <div className="mt-auto">
              <p className="mb-4 text-[15px]">{by("razorpayx")?.account_label}</p>
              <GhostButton disabled={pending} onClick={() => run(() => disconnect("razorpayx"))}>
                Disconnect
              </GhostButton>
            </div>
          ) : (
            <div className="mt-auto space-y-4">
              <Field label="RazorpayX account number">
                <input className={inputClass} style={inputStyle} inputMode="numeric" autoComplete="off" value={rx} onChange={(e) => setRx(e.target.value)} />
              </Field>
              <div className="flex items-center gap-4">
                <PrimaryButton disabled={pending || !on("razorpay")} className="px-6" onClick={() => run(async () => { await connectRazorpayX({ accountNumber: rx.trim() }); setRx(""); })}>
                  Connect
                </PrimaryButton>
                {!on("razorpay") && (
                  <span className="text-[14px]" style={{ color: "var(--muted-2)" }}>
                    Connect Razorpay first.
                  </span>
                )}
              </div>
            </div>
          )}
        </Tile>

        <Tile index={4} title="Gmail" icon={<EnvelopeSimple size={26} />} connected={on("gmail")}>
          <p className={`mb-5 ${copy}`} style={{ color: "var(--muted)" }}>
            Lets the team email suppliers and read their replies. It can read and send mail from the account you connect, and only talks to approved suppliers and customers who opted in.
          </p>
          <div className="mt-auto">
            {on("gmail") ? (
              <>
                <p className="mb-4 text-[15px]">{by("gmail")?.account_label}</p>
                <GhostButton disabled={pending} onClick={() => run(() => disconnect("gmail"))}>
                  Disconnect
                </GhostButton>
              </>
            ) : googleConfigured ? (
              <a href="/api/connections/gmail/start" className="focus-ring inline-flex min-h-[44px] items-center rounded-[12px] px-6 text-[15px] font-semibold text-white transition-transform active:scale-[0.97]" style={{ background: "linear-gradient(135deg, #7c5cff, #5227ff)" }}>
                Connect Gmail
              </a>
            ) : (
              <p className="text-[14px] leading-6" style={{ color: "var(--decision-escalate)" }}>
                This server has no Google OAuth client yet. Set <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> (redirect URI <code>{appUrl.replace(/\/$/, "")}/api/connections/gmail/callback</code>).
              </p>
            )}
          </div>
        </Tile>

        <Tile index={5} title="WhatsApp" icon={<WhatsappLogo size={26} />} connected={on("whatsapp")}>
          <p className={`mb-5 ${copy}`} style={{ color: "var(--muted)" }}>
            Uses a dedicated number linked like WhatsApp Web (via Baileys, an unofficial client). Use a number you can afford to lose: WhatsApp can restrict numbers that automate messages, so the team only writes to approved suppliers and opted-in customers, at a human pace.
          </p>
          <label className="mb-4 flex cursor-pointer items-center gap-3 text-[15px]">
            <input type="checkbox" className="h-5 w-5 accent-[#7c5cff]" checked={coo.settings.whatsapp_enabled} disabled={pending} onChange={(e) => run(() => setWhatsAppEnabled(e.target.checked))} />
            Enable WhatsApp for this account
          </label>
          {coo.settings.whatsapp_enabled && !on("whatsapp") && (
            <div className="rounded-[14px] bg-white/[0.04] p-5">
              {qr ? (
                <div className="flex flex-wrap items-center gap-5">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={qr} alt="WhatsApp pairing code" width={180} height={180} className="rounded-[14px] bg-white p-2" />
                  <p className="max-w-xs text-[14px] leading-6" style={{ color: "var(--muted)" }}>
                    On the phone: WhatsApp, Settings, Linked devices, Link a device, then scan this code. It refreshes every few seconds while the worker is waiting.
                  </p>
                </div>
              ) : (
                <p className="text-[14px] leading-6" style={{ color: "var(--muted)" }}>
                  Waiting for the worker to produce a pairing code. Make sure it is running: <code>npm run worker</code>.
                </p>
              )}
            </div>
          )}
          {on("whatsapp") && (
            <div className="flex items-center gap-4">
              <span className="text-[15px]">{by("whatsapp")?.account_label}</span>
              <GhostButton disabled={pending} onClick={() => run(() => disconnect("whatsapp"))}>
                Unlink
              </GhostButton>
            </div>
          )}
        </Tile>

        <Tile index={6} title="You, on WhatsApp" icon={<WhatsappLogo size={26} />} connected={!!coo.settings.owner_phone && (coo.settings.owner_approvals_enabled || coo.settings.owner_briefing_enabled)} wide>
          <OwnerPanel coo={coo} pending={pending} run={run} />
        </Tile>

        <Tile index={7} title="Web search" icon={<GlobeSimple size={26} />} connected={on("search")} wide>
          <p className={`mb-5 max-w-3xl ${copy}`} style={{ color: "var(--muted)" }}>
            How the buying agent finds new suppliers. It works without a key using a free search, but a Brave or Tavily key gives better results.
          </p>
          {on("search") ? (
            <div>
              <p className="mb-4 text-[15px]">{by("search")?.account_label}</p>
              <GhostButton disabled={pending} onClick={() => run(() => disconnect("search"))}>
                Disconnect
              </GhostButton>
            </div>
          ) : (
            <div className="flex flex-wrap items-end gap-5">
              <div className="w-44">
                <Field label="Provider">
                  <select className={inputClass} style={inputStyle} value={search.provider} onChange={(e) => setSearch({ ...search, provider: e.target.value as "brave" | "tavily" })}>
                    <option value="brave" style={{ background: "#14141f" }}>Brave</option>
                    <option value="tavily" style={{ background: "#14141f" }}>Tavily</option>
                  </select>
                </Field>
              </div>
              <div className="w-80 max-w-full">
                <Field label="API key">
                  <input className={inputClass} style={inputStyle} type="password" autoComplete="off" value={search.key} onChange={(e) => setSearch({ ...search, key: e.target.value })} />
                </Field>
              </div>
              <PrimaryButton disabled={pending || search.key.length < 8} className="px-6" onClick={() => run(async () => { await connectSearch({ provider: search.provider, key: search.key.trim() }); setSearch({ ...search, key: "" }); })}>
                Save
              </PrimaryButton>
            </div>
          )}
        </Tile>
      </div>

      <ConfirmSheet
        open={goLive}
        title="Go live?"
        body="Your team will message real suppliers and buyers and use your connected Razorpay accounts. Every action still passes the Payment Wall and your guardrails. You can return to the sandbox at any time."
        confirmLabel="Go live"
        onClose={() => setGoLive(false)}
        onConfirm={() => run(() => setChannelMode("live"))}
      />
    </div>
  );
}
