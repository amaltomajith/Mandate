function Shimmer({ className }: { className?: string }) {
  return <div className={`skeleton-shimmer rounded-[14px] ${className ?? ""}`} aria-hidden="true" />;
}

export default function SettingsLoading() {
  return (
    <div className="min-h-screen bg-[var(--background-2)]" role="status" aria-label="Loading settings">
      <div className="glass sticky top-0 z-20 flex h-[64px] items-center rounded-none border-x-0 border-t-0 px-5 sm:px-8">
        <Shimmer className="h-6 w-32" />
      </div>
      <main className="mx-auto w-full max-w-[920px] px-5 py-10 sm:px-8">
        <Shimmer className="h-10 w-48" />
        <Shimmer className="mt-3 h-5 w-72 max-w-full" />
        <Shimmer className="mt-10 h-[220px] rounded-[20px]" />
        <Shimmer className="mt-6 h-[280px] rounded-[20px]" />
      </main>
    </div>
  );
}
