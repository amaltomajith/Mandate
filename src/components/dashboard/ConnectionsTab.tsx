"use client";

import { useState, type ReactNode } from "react";
import type { ConnectionKind } from "@/types/db";
import type { CooData, SafeConnection } from "@/lib/cooData";
import { connectRazorpay, connectRazorpayX, connectSearch, disconnect, connectServerRazorpayKeys } from "@/lib/actions/connections";
import { setChannelMode, setWhatsAppEnabled } from "@/lib/actions/team";
import { GhostButton, Icons, Panel, PrimaryButton } from "./ui";
import { ErrorLine, Field, Pill, inputClass, inputStyle, useRunner } from "./kit";

function Card({ title, children, right, accent }: { title: string; children: ReactNode; right?: ReactNode; accent?: string }) {
  return (
    <Panel title={title} icon={<Icons.Shield />} accent={accent ?? "var(--entity-agent)"} action={right}>
      {children}
    </Panel>
  );
}

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
  const by = (k: ConnectionKind): SafeConnection | undefined => coo.connections.find((c) => c.kind === k);
  const live = coo.settings.channel_mode === "live";
  const [rz, setRz] = useState({ keyId: "", keySecret: "", webhook: "" });
  const [rx, setRx] = useState("");
  const [search, setSearch] = useState({ provider: "brave" as "brave" | "tavily", key: "" });
  const hook = `${appUrl.replace(/\/$/, "")}/api/webhooks/razorpay/${slug}`;

  const status = (c?: SafeConnection) =>
    c?.status === "connected" ? <Pill color="var(--decision-allow)">connected</Pill> : <Pill color="var(--muted)">not connected</Pill>;

  const qr = (by("whatsapp")?.meta as { qr_data_url?: string } | null)?.qr_data_url;

  return (
    <div className="flex flex-col gap-5">
      <ErrorLine error={error} />

      <Card
        title="Sandbox or live"
        accent={live ? "var(--decision-escalate)" : "var(--entity-mandate)"}
        right={<Pill color={live ? "var(--decision-escalate)" : "var(--entity-mandate)"}>{live ? "live" : "sandbox"}</Pill>}
      >
        <p className="max-w-2xl text-[13px] leading-relaxed" style={{ color: "var(--muted)" }}>
          In <strong>sandbox</strong>, your team rehearses with simulated suppliers and buyers: nothing is sent to a real person and no real money moves. In <strong>live</strong>, it
          messages real contacts through your connected Gmail and WhatsApp, and uses your Razorpay accounts. Everything still passes the Payment Wall and your guardrails either way.
        </p>
        <div className="mt-4">
          <GhostButton
            disabled={pending}
            className="px-4"
            onClick={() => {
              if (!live && !confirm("Go live? Your team will message real suppliers and buyers and use your connected Razorpay accounts.")) return;
              run(() => setChannelMode(live ? "sandbox" : "live"));
            }}
          >
            {live ? "Back to sandbox" : "Go live"}
          </GhostButton>
        </div>
      </Card>

      <Card title="Razorpay" right={status(by("razorpay"))}>
        <p className="mb-3 text-[12.5px]" style={{ color: "var(--muted)" }}>
          For payment links and refunds. {by("razorpay")?.account_label && <>Connected as <strong>{by("razorpay")?.account_label}</strong>. </>}Without it, links are labelled sandbox links that no buyer can pay.
        </p>
        {by("razorpay")?.status === "connected" ? (
          <GhostButton disabled={pending} className="px-4" onClick={() => run(() => disconnect("razorpay"))}>Disconnect</GhostButton>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <Field label="Key id"><input className={inputClass} style={inputStyle} autoComplete="off" value={rz.keyId} onChange={(e) => setRz({ ...rz, keyId: e.target.value })} placeholder="rzp_test_…" /></Field>
              <Field label="Key secret"><input className={inputClass} style={inputStyle} type="password" autoComplete="off" value={rz.keySecret} onChange={(e) => setRz({ ...rz, keySecret: e.target.value })} /></Field>
              <Field label="Webhook secret" hint="Optional now; needed to book payments automatically">
                <input className={inputClass} style={inputStyle} type="password" autoComplete="off" value={rz.webhook} onChange={(e) => setRz({ ...rz, webhook: e.target.value })} />
              </Field>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <PrimaryButton disabled={pending} className="px-5" onClick={() => run(async () => { await connectRazorpay({ keyId: rz.keyId.trim(), keySecret: rz.keySecret.trim(), webhookSecret: rz.webhook.trim() || undefined }); setRz({ keyId: "", keySecret: "", webhook: "" }); })}>
                {pending ? "Checking…" : "Connect"}
              </PrimaryButton>
              {serverHasRazorpayKeys && (
                <GhostButton disabled={pending} className="px-4" onClick={() => run(() => connectServerRazorpayKeys())}>
                  Use this server&apos;s test keys
                </GhostButton>
              )}
            </div>
          </>
        )}
        <p className="mt-4 text-[11.5px]" style={{ color: "var(--muted-2)" }}>
          Point Razorpay&apos;s webhook (events <code>payment.captured</code>, <code>payment_link.paid</code>, <code>payout.*</code>) at:
        </p>
        <code className="mt-1 block break-all rounded-lg px-3 py-2 text-[11.5px]" style={{ background: "var(--panel-2)" }}>{hook}</code>
      </Card>

      <Card title="RazorpayX payouts" right={status(by("razorpayx"))}>
        <p className="mb-3 text-[12.5px]" style={{ color: "var(--muted)" }}>
          How suppliers get paid. Needs a RazorpayX account. Without it, payouts run on the labelled sandbox executor and no money moves.
        </p>
        {by("razorpayx")?.status === "connected" ? (
          <>
            <p className="mb-3 text-[12.5px]">{by("razorpayx")?.account_label}</p>
            <GhostButton disabled={pending} className="px-4" onClick={() => run(() => disconnect("razorpayx"))}>Disconnect</GhostButton>
          </>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-64">
              <Field label="RazorpayX account number"><input className={inputClass} style={inputStyle} inputMode="numeric" autoComplete="off" value={rx} onChange={(e) => setRx(e.target.value)} /></Field>
            </div>
            <PrimaryButton disabled={pending || by("razorpay")?.status !== "connected"} className="px-5" onClick={() => run(async () => { await connectRazorpayX({ accountNumber: rx.trim() }); setRx(""); })}>
              Connect
            </PrimaryButton>
            {by("razorpay")?.status !== "connected" && <span className="text-[11.5px]" style={{ color: "var(--muted-2)" }}>Connect Razorpay first.</span>}
          </div>
        )}
      </Card>

      <Card title="Gmail" right={status(by("gmail"))}>
        <p className="mb-3 text-[12.5px]" style={{ color: "var(--muted)" }}>
          Lets the team email suppliers and read their replies. It can read and send mail from the account you connect, and only talks to approved suppliers and customers who opted in.
        </p>
        {by("gmail")?.status === "connected" ? (
          <>
            <p className="mb-3 text-[12.5px]">{by("gmail")?.account_label}</p>
            <GhostButton disabled={pending} className="px-4" onClick={() => run(() => disconnect("gmail"))}>Disconnect</GhostButton>
          </>
        ) : googleConfigured ? (
          <a href="/api/connections/gmail/start" className="inline-block rounded-lg px-5 py-2 text-xs font-semibold text-white" style={{ background: "linear-gradient(135deg, #7c5cff, #5227ff)" }}>
            Connect Gmail
          </a>
        ) : (
          <p className="text-[12px]" style={{ color: "var(--decision-escalate)" }}>
            This server has no Google OAuth client yet. Set <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> (redirect URI <code>{appUrl.replace(/\/$/, "")}/api/connections/gmail/callback</code>).
          </p>
        )}
      </Card>

      <Card title="WhatsApp" right={status(by("whatsapp"))}>
        <p className="mb-3 text-[12.5px]" style={{ color: "var(--muted)" }}>
          Uses a dedicated WhatsApp number linked like WhatsApp Web (via Baileys, an unofficial client). Use a number you can afford to lose: WhatsApp can restrict numbers that
          automate messages, so the team only writes to approved suppliers and opted-in customers, at a human pace. The worker holds the connection.
        </p>
        <label className="mb-3 flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={coo.settings.whatsapp_enabled} disabled={pending} onChange={(e) => run(() => setWhatsAppEnabled(e.target.checked))} />
          Enable WhatsApp for this account
        </label>
        {coo.settings.whatsapp_enabled && by("whatsapp")?.status !== "connected" && (
          <div className="rounded-xl p-4" style={{ background: "var(--panel-2)" }}>
            {qr ? (
              <div className="flex flex-wrap items-center gap-5">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={qr} alt="WhatsApp pairing code" width={180} height={180} className="rounded-lg bg-white p-2" />
                <p className="max-w-sm text-[12.5px]" style={{ color: "var(--muted)" }}>
                  On the phone: WhatsApp, Settings, Linked devices, Link a device, then scan this code. It refreshes every few seconds while the worker is waiting.
                </p>
              </div>
            ) : (
              <p className="text-[12.5px]" style={{ color: "var(--muted)" }}>
                Waiting for the worker to produce a pairing code. Make sure it is running: <code>npm run worker</code>.
              </p>
            )}
          </div>
        )}
        {by("whatsapp")?.status === "connected" && (
          <div className="flex items-center gap-3">
            <span className="text-[12.5px]">{by("whatsapp")?.account_label}</span>
            <GhostButton disabled={pending} className="px-4" onClick={() => run(() => disconnect("whatsapp"))}>Unlink</GhostButton>
          </div>
        )}
      </Card>

      <Card title="Web search" right={status(by("search"))}>
        <p className="mb-3 text-[12.5px]" style={{ color: "var(--muted)" }}>
          How the buying agent finds new suppliers. It works without a key using a free search, but a Brave or Tavily key gives better results.
        </p>
        {by("search")?.status === "connected" ? (
          <>
            <p className="mb-3 text-[12.5px]">{by("search")?.account_label}</p>
            <GhostButton disabled={pending} className="px-4" onClick={() => run(() => disconnect("search"))}>Disconnect</GhostButton>
          </>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-40">
              <Field label="Provider">
                <select className={inputClass} style={inputStyle} value={search.provider} onChange={(e) => setSearch({ ...search, provider: e.target.value as "brave" | "tavily" })}>
                  <option value="brave" style={{ background: "#14141f" }}>Brave</option>
                  <option value="tavily" style={{ background: "#14141f" }}>Tavily</option>
                </select>
              </Field>
            </div>
            <div className="w-72">
              <Field label="API key"><input className={inputClass} style={inputStyle} type="password" autoComplete="off" value={search.key} onChange={(e) => setSearch({ ...search, key: e.target.value })} /></Field>
            </div>
            <PrimaryButton disabled={pending || search.key.length < 8} className="px-5" onClick={() => run(async () => { await connectSearch({ provider: search.provider, key: search.key.trim() }); setSearch({ ...search, key: "" }); })}>
              Save
            </PrimaryButton>
          </div>
        )}
      </Card>
    </div>
  );
}
