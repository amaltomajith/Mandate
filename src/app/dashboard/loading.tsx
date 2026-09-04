import { MandateMark } from "@/components/brand/MandateMark";

/**
 * Shown the instant someone clicks through to the dashboard.
 *
 * Without this file the route had no Suspense boundary, so Next held the old
 * page on screen until every server query in `getDashboardData` had returned —
 * around a second of a click doing visibly nothing, which reads as a dead
 * button rather than as a page loading. A `loading.tsx` makes the navigation
 * commit immediately and streams the real page in behind it.
 *
 * It also earns its keep before the click: `/dashboard` is `force-dynamic`, and
 * Next will only prefetch the static shell of a dynamic route — which is
 * exactly this file. With no loading boundary there was nothing for the
 * landing page's <Link> to prefetch at all.
 *
 * The skeleton deliberately mirrors the real header and tab strip rather than
 * being a centred spinner. The chrome here is identical to what lands, so the
 * page appears to fill in rather than to be replaced, and nothing jumps when
 * the data arrives. No shader: this is on screen for a moment, and paying to
 * spin up a WebGL context that is about to be torn down and recreated by the
 * real page would make the thing it is meant to speed up slower.
 */

const TABS = ["Overview", "Buy", "Catalog", "Campaigns", "Agents", "Transactions", "Policies", "Mandates"];

function Shimmer({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={`skeleton-shimmer rounded-md ${className ?? ""}`} style={style} />;
}

export default function DashboardLoading() {
  return (
    <div className="relative flex min-h-screen flex-col bg-[var(--background-2)]">
      {/* A flat stand-in for the gradient band, so the top of the page is the
          right colour and depth before the shader mounts. */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-[168px]"
        style={{
          background:
            "linear-gradient(to bottom, rgba(82,39,255,0.28) 0%, rgba(8,8,12,0.55) 45%, var(--background-2) 100%)",
        }}
      />

      <header
        className="panel-glass sticky top-0 z-20 flex items-center justify-between px-6 py-3.5"
        style={{ borderTop: "none", borderLeft: "none", borderRight: "none" }}
      >
        <div className="flex items-center gap-3">
          {/* Real, not a placeholder — it is already here and its absence would
              be the one obvious difference between this and the loaded page. */}
          <MandateMark size={28} />
          <div>
            <h1 className="text-[15px] font-semibold tracking-tight">Mandate</h1>
            <p className="text-[11px] leading-none" style={{ color: "var(--muted-2)" }}>
              control plane
            </p>
          </div>
          <div className="ml-6 hidden items-center gap-4 border-l pl-6 sm:flex" style={{ borderColor: "var(--panel-border)" }}>
            {["agents", "active rules", "pending"].map((label) => (
              <div key={label} className="flex flex-col gap-1">
                <Shimmer className="h-3.5 w-7" />
                <span className="text-[10px] leading-none" style={{ color: "var(--muted-2)" }}>
                  {label}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--muted)" }}>
            <span className="live-dot h-1.5 w-1.5 rounded-full" style={{ background: "var(--decision-allow)" }} />
            live
          </div>
          <Shimmer className="h-6 w-20" />
          <Shimmer className="h-6 w-6 rounded-full" />
        </div>
      </header>

      <div className="relative z-10 flex flex-1 flex-col gap-5 p-5">
        <div className="flex gap-1.5">
          {TABS.map((t, i) => (
            <div
              key={t}
              className="rounded-lg px-3 py-1.5 text-[12.5px] font-medium"
              style={{
                color: i === 0 ? "var(--foreground)" : "var(--muted-2)",
                background: i === 0 ? "var(--panel-2)" : "transparent",
              }}
            >
              {t}
            </div>
          ))}
        </div>

        {/* The Overview shape: a tall graph panel with a sidebar beside it. */}
        <div className="grid flex-1 gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
          <Shimmer className="min-h-[420px] rounded-2xl" />
          <div className="flex flex-col gap-5">
            <Shimmer className="h-40 rounded-2xl" />
            <Shimmer className="h-56 rounded-2xl" />
          </div>
        </div>
      </div>
    </div>
  );
}
