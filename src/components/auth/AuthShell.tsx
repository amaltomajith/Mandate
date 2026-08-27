import type { ReactNode } from "react";
import { MandateMark } from "@/components/brand/MandateMark";

const PILLARS = [
  {
    title: "Bounded",
    body: "Every payout, refund, order, or mandate an agent proposes is checked against caps, velocity limits, and category rules before a paisa moves.",
  },
  {
    title: "Gated",
    body: "Cross a threshold and the action escalates to a human instead of firing blind — nothing above the line executes without sign-off.",
  },
  {
    title: "Explainable",
    body: "Every allow, block, and escalation traces back to the exact rule that fired, in plain language, on a live graph you can inspect.",
  },
];

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-screen w-full lg:grid-cols-2">
      <div className="relative hidden overflow-hidden bg-[var(--brand-navy)] lg:flex lg:flex-col lg:justify-between lg:p-12">
        <BackgroundGlow />

        <div className="relative z-10 flex items-center gap-2.5">
          <MandateMark size={30} />
          <span className="text-lg font-semibold tracking-tight text-white">Mandate</span>
        </div>

        <div className="relative z-10 max-w-md">
          <h1 className="text-3xl font-semibold leading-tight tracking-tight text-white">
            A control plane for money your agents move.
          </h1>
          <p className="mt-3 text-[15px] leading-relaxed text-white/70">
            Mandate sits between any AI agent — a third-party shopping agent, or your own
            automation — and Razorpay. It decides, explains, and remembers.
          </p>

          <div className="mt-8 space-y-5">
            {PILLARS.map((p) => (
              <div key={p.title} className="flex gap-3">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--brand-blue)]" />
                <div>
                  <p className="text-sm font-semibold text-white">{p.title}</p>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-white/60">{p.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <p className="relative z-10 text-xs text-white/40">
          Built for Razorpay Track 01 — AI Growth &amp; Agentic Commerce.
        </p>
      </div>

      <div className="flex items-center justify-center bg-[var(--background-2)] p-6">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex flex-col items-center gap-3 lg:hidden">
            <MandateMark size={36} />
            <span className="text-xl font-semibold tracking-tight">Mandate</span>
          </div>
          {/* No wrapper box here on purpose — Clerk's <SignIn>/<SignUp> already
              render their own card (border, shadow, rounded corners). Wrapping
              that in a second panel-card-lg box created a visibly mismatched
              nested-box look (the two didn't share a padding/radius, so the
              outer one peeked out unevenly around the inner one). Clerk's own
              card is themed to match via ClerkProvider's `appearance` in
              layout.tsx — one real box, not two. */}
          {children}
        </div>
      </div>
    </div>
  );
}

function BackgroundGlow() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden opacity-60">
      <div
        className="absolute -left-32 -top-32 h-[420px] w-[420px] rounded-full blur-[110px]"
        style={{ background: "radial-gradient(circle, #0d94fb, transparent 70%)" }}
      />
      <div
        className="absolute -bottom-40 -right-20 h-[380px] w-[380px] rounded-full blur-[110px]"
        style={{ background: "radial-gradient(circle, #8b5cf6, transparent 70%)" }}
      />
    </div>
  );
}
