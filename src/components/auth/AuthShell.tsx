import type { ReactNode } from "react";
import { MandateMark } from "@/components/brand/MandateMark";

const PILLARS = [
  {
    title: "Sells what is stuck",
    body: "Your selling agent marks slow stock down a step at a time, never below your margin, and haggles with buyers inside limits it never sees.",
  },
  {
    title: "Restocks what is selling",
    body: "Your buying agent gets quotes from suppliers over email and WhatsApp, picks the best, and pays, sized to what sales have earned.",
  },
  {
    title: "Guarded in code",
    body: "Every price drop and payout passes a Payment Wall that checks your own records. No message or prompt can talk it into paying the wrong person.",
  },
];

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-screen w-full lg:grid-cols-2">
      <div className="relative hidden overflow-hidden bg-[var(--background-2)] lg:flex lg:flex-col lg:justify-between lg:p-12">
        <BackgroundGlow />

        <div className="relative z-10 flex items-center gap-2.5">
          <MandateMark size={30} />
          <span className="text-lg font-semibold tracking-tight text-white">Mandate</span>
        </div>

        <div className="relative z-10 max-w-md">
          <h1 className="text-3xl font-semibold leading-tight tracking-tight text-white">
            An autonomous manager for your store.
          </h1>
          <p className="mt-3 text-[15px] leading-relaxed text-white/70">
            Agents that sell your slow stock to fund restocking your bestsellers, with a payment
            guardrail between them and your money.
          </p>

          <div className="mt-8 space-y-5">
            {PILLARS.map((p) => (
              <div key={p.title} className="flex gap-3">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--brand-violet)]" />
                <div>
                  <p className="text-sm font-semibold text-white">{p.title}</p>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-white/60">{p.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <p className="relative z-10 text-xs text-white/40">
          Built on Razorpay.
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
        style={{ background: "radial-gradient(circle, #5227ff, transparent 70%)" }}
      />
      <div
        className="absolute -bottom-40 -right-20 h-[380px] w-[380px] rounded-full blur-[110px]"
        style={{ background: "radial-gradient(circle, #ff9ffc, transparent 70%)" }}
      />
    </div>
  );
}
