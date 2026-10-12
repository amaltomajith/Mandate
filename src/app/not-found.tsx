import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="surface w-full max-w-lg p-10 text-center">
        <p className="num text-[13px]" style={{ color: "var(--muted-2)" }}>
          404
        </p>
        <p className="mt-2 text-[24px] font-semibold tracking-tight">There is nothing here</p>
        <p className="mt-3 text-[15px] leading-6" style={{ color: "var(--muted)" }}>
          That page does not exist, or it has moved.
        </p>
        <Link
          href="/dashboard"
          className="focus-ring mt-7 inline-flex min-h-[44px] items-center justify-center rounded-[12px] px-6 text-[15px] font-semibold text-white transition-transform active:scale-[0.97]"
          style={{ background: "linear-gradient(135deg, #7c5cff, #5227ff)" }}
        >
          Go to your dashboard
        </Link>
      </div>
    </main>
  );
}
