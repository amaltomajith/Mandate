import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { MandateMark } from "@/components/brand/MandateMark";
import { SettingsPanel } from "@/components/dashboard/SettingsPanel";
import { previewReset, type ResetPreview } from "@/lib/actions/settings";

export const dynamic = "force-dynamic";

/**
 * Account controls, on their own route rather than as another dashboard tab.
 *
 * The existing tabs are client state inside one page, which is right for
 * things a merchant flips between while watching traffic. This is not that: it
 * is a place you go deliberately, and giving it a URL means it can be linked,
 * bookmarked and — the reason that actually matters — left by navigating back,
 * so the destructive controls are not one stray click away from the view
 * someone spends all their time in.
 *
 * Guarded the same way /dashboard is. `proxy.ts` already protects this path,
 * so in normal operation a signed-out visitor never arrives; this is the
 * backstop for the failure that allowlist has actually had before, a route
 * slipping out of the matcher. Every action on the page re-checks the session
 * on the server regardless — the page gate is not what makes them safe.
 */
export default async function SettingsPage() {
  const { userId } = await auth();
  if (!userId) redirect("/login");

  // Read on the server so the page arrives with real counts rather than
  // flashing a spinner. Caught rather than thrown: a settings page that cannot
  // reach the database should still render Sign out, which is the one control
  // here that does not need the database at all.
  let initial: ResetPreview | null = null;
  let initialError: string | null = null;
  try {
    initial = await previewReset();
  } catch (err) {
    initialError = err instanceof Error ? err.message : "Could not read the account.";
  }

  return (
    <div className="relative flex min-h-screen flex-col bg-[var(--background-2)]">
      <header
        className="panel-glass sticky top-0 z-20 flex items-center justify-between px-6 py-3.5"
        style={{ borderTop: "none", borderLeft: "none", borderRight: "none" }}
      >
        <div className="flex items-center gap-3">
          <MandateMark size={28} />
          <div>
            <h1 className="text-[15px] font-semibold tracking-tight">Mandate</h1>
            <p className="text-[11px] leading-none" style={{ color: "var(--muted-2)" }}>
              settings
            </p>
          </div>
        </div>
        <Link
          href="/dashboard"
          className="rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition-colors hover:bg-[var(--panel-2)]"
          style={{ color: "var(--muted)" }}
        >
          ← Dashboard
        </Link>
      </header>

      <div className="relative z-10 flex flex-1 flex-col gap-5 p-5">
        <SettingsPanel initial={initial} initialError={initialError} />
      </div>
    </div>
  );
}
