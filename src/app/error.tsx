"use client";

import { useEffect } from "react";

/**
 * What a visitor sees when a page throws. Plain words, a way to try again, and a
 * reference they can quote; the detail stays in the server log (the digest
 * matches it), because in production the message is deliberately generic.
 */
export default function Error({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="surface w-full max-w-lg p-10 text-center">
        <p className="text-[24px] font-semibold tracking-tight">Something went wrong</p>
        <p className="mt-3 text-[15px] leading-6" style={{ color: "var(--muted)" }}>
          This page could not load. Your data is safe: nothing was changed. Try again, and if it keeps happening, check that the database is reachable.
        </p>
        {error.digest && (
          <p className="num mt-4 text-[12px]" style={{ color: "var(--muted-2)" }}>
            Reference {error.digest}
          </p>
        )}
        <button
          type="button"
          onClick={() => retry()}
          className="focus-ring mt-7 inline-flex min-h-[44px] items-center justify-center rounded-[12px] px-6 text-[15px] font-semibold text-white transition-transform active:scale-[0.97]"
          style={{ background: "linear-gradient(135deg, #7c5cff, #5227ff)" }}
        >
          Try again
        </button>
      </div>
    </main>
  );
}
