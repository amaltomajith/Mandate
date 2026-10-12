import { MandateMark } from "@/components/brand/MandateMark";

/**
 * Shown the instant someone clicks through to the dashboard.
 *
 * Without this file the route had no Suspense boundary, so Next held the old
 * page on screen until every server query had returned: a click that visibly did
 * nothing. A `loading.tsx` makes the navigation commit immediately and streams
 * the real page in behind it. `/dashboard` is `force-dynamic`, and Next only
 * prefetches the static shell of a dynamic route, which is exactly this file.
 *
 * It mirrors the real layout (left rail, slim bar, page title, a row of numbers)
 * so the page fills in rather than being replaced, and nothing jumps when the
 * data arrives. No shader: paying for a WebGL context that is about to be torn
 * down by the real page would slow the thing this is meant to speed up.
 */

const RAIL = ["Today", "Inventory", "Suppliers", "Sales", "Guardrails", "Activity", "Team", "Connections"];

function Shimmer({ className }: { className?: string }) {
  return <div className={`skeleton-shimmer rounded-[14px] ${className ?? ""}`} aria-hidden="true" />;
}

export default function DashboardLoading() {
  return (
    <div className="relative flex min-h-screen bg-[var(--background-2)]" role="status" aria-label="Loading your dashboard">
      <aside className="glass fixed inset-y-0 left-0 z-30 hidden w-[76px] flex-col gap-1 rounded-none border-y-0 border-l-0 px-3 py-5 lg:flex xl:w-[248px] xl:px-4">
        <div className="mb-6 flex items-center gap-3 px-2.5">
          <MandateMark size={32} />
          <div className="hidden xl:block">
            <p className="text-[17px] font-semibold leading-5 tracking-[-0.01em]">Mandate</p>
            <p className="text-[12px] leading-4" style={{ color: "var(--muted)" }}>
              store manager
            </p>
          </div>
        </div>
        {RAIL.map((label, i) => (
          <div key={label} className="flex min-h-[46px] items-center gap-3.5 rounded-[12px] px-3.5" style={{ background: i === 0 ? "rgba(124,92,255,0.18)" : "transparent" }}>
            <div className="skeleton-shimmer h-[22px] w-[22px] shrink-0 rounded-md" aria-hidden="true" />
            <span className="hidden text-[15px] font-medium xl:inline" style={{ color: i === 0 ? "var(--foreground)" : "var(--muted-2)" }}>
              {label}
            </span>
          </div>
        ))}
      </aside>

      <div className="flex min-h-screen flex-1 flex-col lg:pl-[76px] xl:pl-[248px]">
        <div className="glass sticky top-0 z-20 flex h-[64px] items-center justify-between rounded-none border-x-0 border-t-0 px-5 sm:px-8">
          <div className="flex items-center gap-3 lg:hidden">
            <MandateMark size={28} />
            <span className="text-[17px] font-semibold tracking-[-0.01em]">Mandate</span>
          </div>
          <Shimmer className="hidden h-5 w-40 lg:block" />
          <Shimmer className="h-7 w-24" />
        </div>

        <main className="mx-auto w-full max-w-[1360px] flex-1 px-5 py-10 sm:px-8">
          <div className="mb-10">
            <Shimmer className="h-10 w-48" />
            <Shimmer className="mt-3 h-5 w-80 max-w-full" />
          </div>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Shimmer key={i} className="h-[168px] rounded-[20px]" />
            ))}
          </div>
          <Shimmer className="mt-8 h-[320px] rounded-[20px]" />
          <Shimmer className="mt-8 h-[420px] rounded-[20px]" />
        </main>
      </div>
    </div>
  );
}
