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
    <div className="min-h-screen bg-[var(--background-2)]">
      <header className="glass sticky top-0 z-20 flex h-[64px] items-center justify-between rounded-none border-x-0 border-t-0 px-5 sm:px-8">
        <div className="flex items-center gap-3">
          <MandateMark size={28} />
          <span className="text-[17px] font-semibold tracking-[-0.01em]">Mandate</span>
        </div>
        <Link
          href="/dashboard"
          className="focus-ring inline-flex min-h-[44px] items-center rounded-[12px] px-4 text-[15px] font-medium transition-colors hover:bg-white/[0.06]"
          style={{ color: "var(--muted)" }}
        >
          Back to the dashboard
        </Link>
      </header>

      <main className="mx-auto flex w-full max-w-[920px] flex-col gap-8 px-5 py-10 sm:px-8">
        <div>
          <h1 className="text-[40px] font-semibold leading-[44px] tracking-[-0.03em]">Settings</h1>
          <p className="mt-2 text-[17px] leading-7" style={{ color: "var(--muted)" }}>
            Your account, and the controls you do not want one click away.
          </p>
        </div>
        <SettingsPanel initial={initial} initialError={initialError} />
      </main>
    </div>
  );
}
