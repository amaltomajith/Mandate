"use client";

import { useCallback, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { previewReset, resetTransactions, resetEverything, type ResetPreview } from "@/lib/actions/settings";
import { SignOutButton } from "./SignOutButton";
import { DangerButton, GhostButton, Icons, Panel, Spinner } from "./ui";

/**
 * Account controls, which on this page means "things that delete data".
 *
 * The visual weight here is inverted relative to the rest of the dashboard. On
 * Mandates, Revoke is played DOWN so the irreversible option is not the one
 * the eye lands on first. Here every action is destructive, so playing them
 * down would leave nothing to distinguish "clears last night's traffic" from
 * "puts the account back to the day it was created" — the danger zone is
 * therefore the heaviest thing on the page, and the full reset is heavier
 * again than the partial one.
 */

function CountRow({ label, value, dim }: { label: string; value: number; dim?: boolean }) {
  return (
    <div className="flex items-baseline justify-between py-1">
      <span className="text-[12px]" style={{ color: "var(--muted-2)" }}>
        {label}
      </span>
      <span
        className="text-[13px] font-semibold tabular-nums"
        style={{ color: dim || value === 0 ? "var(--muted-2)" : "var(--foreground)" }}
      >
        {value.toLocaleString()}
      </span>
    </div>
  );
}

/**
 * `initial` is read on the server by the page and handed down, rather than
 * fetched here on mount. That removes a render pass and a spinner, and it
 * keeps the data-fetching where the rest of this dashboard does it — a client
 * effect whose only job is to call setState on mount is the shape React now
 * warns about, and it was the wrong shape here regardless.
 */
export function SettingsPanel({ initial, initialError }: { initial: ResetPreview | null; initialError: string | null }) {
  const router = useRouter();
  const [preview, setPreview] = useState<ResetPreview | null>(initial);
  const [loadError, setLoadError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState<null | "transactions" | "everything">(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [typedSlug, setTypedSlug] = useState("");
  const [, startTransition] = useTransition();

  const load = useCallback(async () => {
    try {
      setPreview(await previewReset());
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not read the account.");
    }
  }, []);

  /**
   * Counts are re-read immediately before the confirm rather than reused from
   * page load. The simulation writes continuously, so a number fetched when
   * the tab was opened can be minutes stale by the time someone clicks — and
   * the whole point of showing a figure is that it is the figure that goes.
   */
  async function confirmAndRun(
    kind: "transactions" | "everything",
    run: () => Promise<unknown>,
    message: (p: ResetPreview) => string
  ) {
    setError(null);
    setDone(null);
    let fresh: ResetPreview;
    try {
      fresh = await previewReset();
      setPreview(fresh);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read the account.");
      return;
    }

    if (!window.confirm(message(fresh))) return;

    setBusy(kind);
    try {
      await run();
      setDone(
        kind === "transactions"
          ? `Cleared ${fresh.transactionsTotal.toLocaleString()} rows. Agents, rules, catalog and mandates are untouched.`
          : "Account reset. Default rules and catalog restored."
      );
      setTypedSlug("");
      await load();
      // Straight back to Overview so the result is visible immediately rather
      // than leaving someone looking at a settings page that says nothing
      // about the dashboard they just emptied.
      startTransition(() => {
        router.push("/dashboard");
        router.refresh();
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "The reset failed.");
    } finally {
      setBusy(null);
    }
  }

  const slugMatches = preview !== null && typedSlug.trim().toLowerCase() === preview.merchantSlug.toLowerCase();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <Panel title="Account" icon={<Icons.Shield />} accent="var(--entity-agent)">
        {loadError ? (
          <p className="text-[12px]" style={{ color: "var(--decision-block)" }}>
            {loadError}
          </p>
        ) : !preview ? (
          <div className="flex items-center gap-2 text-[12px]" style={{ color: "var(--muted-2)" }}>
            <Spinner /> Reading the account…
          </div>
        ) : (
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="text-[15px] font-semibold tracking-tight">{preview.merchantName}</p>
              <p className="mt-0.5 font-mono text-[11.5px]" style={{ color: "var(--muted-2)" }}>
                {preview.merchantSlug}
              </p>
              <p className="mt-2 text-[11.5px]" style={{ color: "var(--muted-2)" }}>
                Every action on this page applies to this account only, resolved from your session.
              </p>
            </div>
            <div className="shrink-0 rounded-lg border px-3 py-1.5" style={{ borderColor: "var(--panel-border-strong)" }}>
              <SignOutButton />
            </div>
          </div>
        )}
      </Panel>

      {/* The danger zone: bordered and warning-coloured, deliberately the
          heaviest block on the page. */}
      <section
        className="relative flex flex-col overflow-hidden rounded-2xl border-2 p-5"
        style={{
          borderColor: "color-mix(in srgb, var(--decision-block) 55%, transparent)",
          background: "color-mix(in srgb, var(--decision-block) 5%, var(--panel))",
        }}
      >
        <div className="mb-1 flex items-center gap-2.5">
          <span
            className="flex h-7 w-7 items-center justify-center rounded-lg"
            style={{ background: "color-mix(in srgb, var(--decision-block) 18%, transparent)", color: "var(--decision-block)" }}
          >
            <Icons.AlertTriangle />
          </span>
          <h2 className="text-[13px] font-semibold tracking-tight" style={{ color: "var(--decision-block)" }}>
            Danger zone
          </h2>
        </div>
        <p className="mb-4 text-[11.5px]" style={{ color: "var(--muted-2)" }}>
          Both actions are immediate and cannot be undone. Neither touches any other account.
        </p>

        {error && (
          <p
            className="mb-3 rounded-lg border px-3 py-2 text-[12px]"
            style={{
              borderColor: "var(--decision-block)",
              color: "var(--decision-block)",
              background: "color-mix(in srgb, var(--decision-block) 12%, transparent)",
            }}
          >
            {error}
          </p>
        )}
        {done && (
          <p
            className="mb-3 rounded-lg border px-3 py-2 text-[12px]"
            style={{
              borderColor: "var(--decision-allow)",
              color: "var(--decision-allow)",
              background: "color-mix(in srgb, var(--decision-allow) 12%, transparent)",
            }}
          >
            {done}
          </p>
        )}

        {/* ---- Reset transactions ---- */}
        <div className="rounded-xl border p-4" style={{ borderColor: "var(--panel-border-strong)", background: "var(--panel)" }}>
          <h3 className="text-[13px] font-semibold">Reset transactions</h3>
          <p className="mt-1 text-[11.5px]" style={{ color: "var(--muted-2)" }}>
            Clears this account&apos;s history. Registered agents keep their keys, so nothing has to be
            re-registered afterwards.
          </p>

          <div className="mt-3 grid gap-x-8 gap-y-0 sm:grid-cols-2">
            <div>
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--decision-block)" }}>
                Will be deleted
              </p>
              {preview
                ? Object.entries(preview.transactions).map(([t, n]) => <CountRow key={t} label={t} value={n} />)
                : <p className="py-1 text-[12px]" style={{ color: "var(--muted-2)" }}>…</p>}
            </div>
            <div>
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--decision-allow)" }}>
                Kept
              </p>
              {preview
                ? Object.entries(preview.preserved).map(([t, n]) => <CountRow key={t} label={t} value={n} dim />)
                : <p className="py-1 text-[12px]" style={{ color: "var(--muted-2)" }}>…</p>}
            </div>
          </div>

          <DangerButton
            className="mt-4 w-full sm:w-auto sm:px-4"
            disabled={busy !== null || !preview}
            onClick={() =>
              confirmAndRun(
                "transactions",
                () => resetTransactions(),
                (p) =>
                  `Reset transactions for ${p.merchantName} (${p.merchantSlug})?\n\n` +
                  `This deletes ${p.transactionsTotal.toLocaleString()} rows:\n` +
                  Object.entries(p.transactions)
                    .map(([t, n]) => `  ${t}: ${n.toLocaleString()}`)
                    .join("\n") +
                  `\n\nKept: ${Object.entries(p.preserved)
                    .map(([t, n]) => `${t} ${n}`)
                    .join(", ")}.\n\nThis cannot be undone.`
              )
            }
          >
            {busy === "transactions" ? "Resetting…" : "Reset transactions"}
          </DangerButton>
        </div>

        {/* ---- Reset everything ---- */}
        <div
          className="mt-4 rounded-xl border-2 p-4"
          style={{
            borderColor: "color-mix(in srgb, var(--decision-block) 45%, transparent)",
            background: "var(--panel)",
          }}
        >
          <h3 className="text-[13px] font-semibold" style={{ color: "var(--decision-block)" }}>
            Reset everything
          </h3>
          <p className="mt-1 text-[11.5px]" style={{ color: "var(--muted-2)" }}>
            Everything above, plus mandates and every registered agent — their keypairs included, so each
            external buyer has to be registered again. The default catalog and the five starting policy
            rules are restored, exactly as a new sign-up gets them. The built-in simulation identity is
            kept so its history survives.
          </p>

          <label className="mt-3 block text-[11.5px]" style={{ color: "var(--muted-2)" }}>
            Type <span className="font-mono" style={{ color: "var(--foreground)" }}>{preview?.merchantSlug ?? "…"}</span> to
            confirm:
          </label>
          <input
            value={typedSlug}
            onChange={(e) => setTypedSlug(e.target.value)}
            placeholder={preview?.merchantSlug ?? ""}
            spellCheck={false}
            autoComplete="off"
            className="mt-1.5 w-full rounded-lg border px-3 py-2 font-mono text-[12px] outline-none transition-colors focus:border-[var(--decision-block)]"
            style={{ borderColor: "var(--panel-border-strong)", background: "var(--panel-2)", color: "var(--foreground)" }}
          />

          <DangerButton
            className="mt-3 w-full sm:w-auto sm:px-4"
            disabled={busy !== null || !slugMatches}
            onClick={() =>
              confirmAndRun(
                "everything",
                () => resetEverything(typedSlug),
                (p) =>
                  `RESET EVERYTHING for ${p.merchantName} (${p.merchantSlug})?\n\n` +
                  `Deletes all ${p.transactionsTotal.toLocaleString()} history rows, plus ` +
                  `${p.preserved.mandates} mandate(s) and every registered agent except the built-in ` +
                  `simulation identity.\n\n` +
                  `Agent keypairs are destroyed — every external buyer will need registering again.\n\n` +
                  `The default catalog and five starting rules are restored. This cannot be undone.`
              )
            }
          >
            {busy === "everything" ? "Resetting…" : "Reset everything"}
          </DangerButton>
          {!slugMatches && typedSlug.length > 0 && (
            <p className="mt-1.5 text-[11px]" style={{ color: "var(--muted-2)" }}>
              Doesn&apos;t match yet.
            </p>
          )}
        </div>
      </section>

      <div>
        <GhostButton className="px-4" onClick={() => router.push("/dashboard")}>
          Back to dashboard
        </GhostButton>
      </div>
    </div>
  );
}
