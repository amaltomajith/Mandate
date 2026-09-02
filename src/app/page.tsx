import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import GradientWaves from "@/components/landing/GradientWaves";
import CardNav from "@/components/landing/CardNav";
import CurvedLoop from "@/components/landing/CurvedLoop";
import { DecisionFlow } from "@/components/landing/DecisionFlow";
import { MandateMark } from "@/components/brand/MandateMark";

/**
 * The public face of the project.
 *
 * Before this existed, `/` redirected straight to `/dashboard`, which meant the
 * only way to find out what Mandate is was to create an account first. That is
 * a bad trade for anyone evaluating it — a judge, a reviewer, someone sent a
 * link — so everything needed to understand the thing is readable here without
 * signing in, and the dashboard is one click away for anyone who wants it.
 */

export const metadata = {
  title: "Mandate — a control plane for agent-initiated payments",
  description:
    "Mandate sits between any AI agent and Razorpay. Every order, refund and mandate an agent proposes is checked against caps, velocity limits and category rules before money moves — and every decision leaves a trace naming the rule that fired.",
};

const NAV_ITEMS = [
  {
    label: "How it works",
    bgColor: "#141829",
    textColor: "#eaeefa",
    links: [
      { label: "The decision path", href: "#how" },
      { label: "Policy rules", href: "#rules" },
      { label: "Why it exists", href: "#why" },
    ],
  },
  {
    label: "Protocol",
    bgColor: "#171b2e",
    textColor: "#eaeefa",
    links: [
      { label: "What is actually built", href: "#protocol" },
      { label: "The independent buyer", href: "#buyer" },
      { label: "Trust scoring", href: "#trust" },
    ],
  },
  {
    label: "Project",
    bgColor: "#1b1830",
    textColor: "#eaeefa",
    links: [
      { label: "Source on GitHub", href: "https://github.com/amaltomajith/Mandate" },
      { label: "Architecture, end to end", href: "/architecture.html" },
      { label: "Open the dashboard", href: "/dashboard" },
    ],
  },
];

/** The engine evaluates these in order and stops at the first match. The order
 *  is the design: a blocked category should never be rescued by a generous cap. */
const RULES = [
  {
    name: "category_block",
    color: "var(--decision-block)",
    body: "A category the agent may never touch, whatever the amount or its standing. Checked first so nothing downstream can override it.",
  },
  {
    name: "cap",
    color: "var(--entity-rule)",
    body: "A ceiling on a single action. The most common rule a merchant writes, and the one a naive system implements alone.",
  },
  {
    name: "velocity",
    color: "var(--entity-agent)",
    body: "How many actions an agent may take in a window. Catches the failure a cap cannot: a hundred small orders in a minute.",
  },
  {
    name: "trust_floor",
    color: "var(--entity-mandate)",
    body: "A minimum standing to act at all. A new or recently-blocked agent has to earn its way back before large actions are even considered.",
  },
  {
    name: "step_up",
    color: "var(--decision-escalate)",
    body: "Above this line, a human signs off. Not a refusal — the action waits in a queue with its full reasoning attached.",
  },
];

const BUILT = [
  {
    id: "protocol",
    kicker: "Model Context Protocol",
    title: "Revision 2026-07-28, statelessly",
    body: "No initialize handshake, no session id. Capabilities travel in a per-request _meta envelope, which is what lets the merchant answer each call correctly without remembering the last one.",
  },
  {
    kicker: "SEP-2322",
    title: "The merchant can counter-offer",
    body: "When an action would breach a rule, the tool can return input_required with alternatives instead of a flat refusal. The agent retries the original call with its answer. Every candidate is pre-cleared through the same policy engine first, so an offer is never something the merchant would then have to block.",
  },
  {
    kicker: "Web Bot Auth",
    title: "Requests are signed, not tokenised",
    body: "Ed25519 over an RFC 9421-shaped base covering method, path, authority and a content digest. Timestamps are bounded to five minutes and each request carries a single-use nonce, so a captured request cannot be replayed even inside that window.",
  },
  {
    id: "trust",
    kicker: "Trust",
    title: "Earned over a rolling window",
    body: "An agent's score is computed from its last fifty decisions — allows against blocks, escalations weighted separately, tempered by how long it has been active. It moves. A static allowlist cannot tell you an agent started behaving differently yesterday.",
  },
  {
    kicker: "Razorpay",
    title: "Real orders, real payment links",
    body: "Allowed actions execute against live Razorpay APIs in test mode. The decisions are not a simulation with a payment-shaped drawing at the end.",
  },
  {
    kicker: "Inference",
    title: "Local by default",
    body: "Reasoning runs against a local model. Anything classified as internal — policy thresholds, caps, trust scores — never leaves the machine, because publishing how an agent will be judged is the map you would use to structure underneath it.",
  },
];

export default async function LandingPage() {
  const { userId } = await auth();
  const signedIn = Boolean(userId);

  return (
    <main className="relative flex w-full flex-col">
      {/* ---------------------------------------------------------------- hero */}
      <section className="relative flex min-h-[clamp(620px,94vh,900px)] w-full flex-col overflow-hidden">
        <div className="pointer-events-none absolute inset-0 z-0">
          <GradientWaves
            /* The three colors are the brand mark read across depth: navy
               at the horizon, brand blue through the wave bodies, the mandate
               violet on the nearest crests. A near-black horizon was the first
               attempt and it swallowed the whole field -- distant pixels mix
               toward the horizon color, so making that black makes most of the
               shader black. fogDepth sets how much of the field is near enough
               to be opaque at all; at the default 15 almost none of it was. */
            horizonColor="#0c2651"
            waveColor="#2f8fff"
            crestColor="#b8a6ff"
            speed={0.28}
            amplitude={2.6}
            waveScale={0.72}
            /* The defaults (35 / 20) distort the field so heavily it reads as
               fog rather than water. Pulled back until wave lines survive. */
            swell={26}
            turbulence={15}
            tilt={1.14}
            height={5.2}
            fogDepth={26}
            detail="medium"
            brightness={1.05}
            opacity={1}
            parallaxStrength={0.45}
            grainIntensity={0.04}
            dprCap={1.5}
          />
        </div>

        {/* The shader runs bright at the horizon. Without this the eyebrow and
            subhead sit on top of the crests and lose contrast at exactly the
            moment someone is deciding whether to keep reading. */}
        <div
          className="pointer-events-none absolute inset-0 z-[1]"
          style={{
            background:
              "linear-gradient(to bottom, rgba(5,7,13,0.82) 0%, rgba(5,7,13,0.46) 26%, rgba(5,7,13,0.14) 56%, rgba(5,7,13,0.42) 86%, var(--background) 100%)",
          }}
        />

        <CardNav
          logo={
            <>
              <MandateMark size={26} />
              <span className="text-[15px] font-semibold tracking-tight">Mandate</span>
            </>
          }
          items={NAV_ITEMS}
          ctaLabel={signedIn ? "Dashboard" : "Get started"}
          ctaHref={signedIn ? "/dashboard" : "/sign-up"}
        />

        <div className="relative z-10 mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center px-6 pb-20 pt-40 sm:px-8">
          <p
            className="font-mono text-[10px] uppercase tracking-[0.15em] sm:text-[11px] sm:tracking-[0.22em]"
            style={{ color: "var(--brand-blue)" }}
          >
            Razorpay AI Buildathon 2026 &middot; Track 01
          </p>

          <h1 className="mt-5 max-w-3xl text-[clamp(2.4rem,6.2vw,4.15rem)] font-semibold leading-[1.03] tracking-[-0.035em] text-balance">
            Agents can move money.
            <br />
            <span
              style={{
                background: "linear-gradient(100deg, #eaeefa 12%, #6fb4ff 52%, #a78bfa 92%)",
                WebkitBackgroundClip: "text",
                backgroundClip: "text",
                color: "transparent",
              }}
            >
              This decides whether they should.
            </span>
          </h1>

          <p
            className="mt-6 max-w-xl text-[15.5px] leading-[1.65]"
            style={{ color: "var(--muted)" }}
          >
            Mandate sits between any AI agent and Razorpay. Every order, refund and mandate an agent
            proposes is checked against your caps, velocity limits and category rules before a paisa
            moves — and every decision leaves a trace naming the exact rule that fired.
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Link
              href={signedIn ? "/dashboard" : "/sign-up"}
              className="group relative overflow-hidden rounded-xl px-5 py-3 text-[13.5px] font-semibold text-white shadow-lg transition-all duration-200 hover:brightness-110"
              style={{ background: "linear-gradient(135deg, #0d94fb, #0b7fd9)" }}
            >
              <span className="relative z-10">
                {signedIn ? "Open the dashboard" : "Open the dashboard"}
              </span>
              <span className="absolute inset-0 -translate-x-full bg-white/20 transition-transform duration-500 group-hover:translate-x-full" />
            </Link>
            <a
              href="#how"
              className="rounded-xl border px-5 py-3 text-[13.5px] font-semibold transition-colors hover:bg-white/[0.04]"
              style={{ borderColor: "var(--panel-border-strong)", color: "var(--foreground)" }}
            >
              How it works
            </a>
          </div>

          <div
            className="mt-12 flex flex-wrap gap-x-6 gap-y-2 font-mono text-[11px]"
            style={{ color: "var(--muted)" }}
          >
            <span>MCP 2026-07-28</span>
            <span aria-hidden="true">·</span>
            <span>Ed25519 request signing</span>
            <span aria-hidden="true">·</span>
            <span>Live Razorpay orders</span>
            <span aria-hidden="true">·</span>
            <span>Local inference</span>
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------------------- why */}
      <Section id="why" eyebrow="The gap" title="An agent with a credential is an agent that can spend.">
        <div className="grid gap-8 md:grid-cols-2">
          <p className="text-[15px] leading-[1.72]" style={{ color: "var(--muted)" }}>
            Agentic commerce moves the buying decision from a person to a model. That part is
            already working. What is missing is everything between{" "}
            <em className="not-italic text-[var(--foreground)]">the model decided</em> and{" "}
            <em className="not-italic text-[var(--foreground)]">the money moved</em> — the merchant
            has no say in that gap, and today it is empty.
          </p>
          <p className="text-[15px] leading-[1.72]" style={{ color: "var(--muted)" }}>
            The obvious fix is a blunt one: refuse anything over a threshold. It works, and it costs
            you every legitimate large order along with the bad ones. Mandate escalates instead of
            refusing, so the revenue a flat cap would have destroyed survives with a human on it —
            and the dashboard shows you exactly how much that is.
          </p>
        </div>
      </Section>

      {/* ----------------------------------------------------------------- how */}
      <Section
        id="how"
        eyebrow="The decision path"
        title="Four gates, in order, on every request."
      >
        <DecisionFlow />
      </Section>

      {/* --------------------------------------------------------------- rules */}
      <Section
        id="rules"
        eyebrow="Policy"
        title="Five rule types. First match wins."
        lede="The precedence is the design, not an implementation detail — a blocked category must never be rescued by a generous cap sitting below it."
      >
        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {RULES.map((r, i) => (
            <li key={r.name} className="panel-card relative flex flex-col rounded-2xl p-5">
              <div
                className="pointer-events-none absolute inset-x-0 top-0 h-[2px] rounded-t-2xl opacity-80"
                style={{ background: r.color }}
              />
              <div className="flex items-baseline gap-2.5">
                <span
                  className="font-mono text-[11px] tabular-nums"
                  style={{ color: "var(--muted-2)" }}
                >
                  {String(i + 1).padStart(2, "0")}
                </span>
                <code className="font-mono text-[13px] font-semibold" style={{ color: r.color }}>
                  {r.name}
                </code>
              </div>
              <p className="mt-2.5 text-[13.5px] leading-[1.6]" style={{ color: "var(--muted)" }}>
                {r.body}
              </p>
            </li>
          ))}
          <li
            className="flex flex-col justify-center rounded-2xl border border-dashed p-5"
            style={{ borderColor: "var(--panel-border-strong)" }}
          >
            <p className="text-[13.5px] leading-[1.6]" style={{ color: "var(--muted)" }}>
              No rule matched? The action is allowed, and the trace records that nothing fired —
              which is itself an answer a merchant can audit.
            </p>
          </li>
        </ol>
      </Section>

      {/* ---------------------------------------------------------------- band */}
      <div
        className="relative w-full select-none overflow-hidden py-6"
        style={{ color: "rgba(234,238,250,0.13)" }}
      >
        {/* A shallow arc, not the component default. At 260 the curve swings
            far enough to read as a diagonal slash across the page rather than
            a band, and the asymmetry of the underlying quadratic (its control
            point sits left of centre) becomes obvious at that depth. */}
        <CurvedLoop
          marqueeText="Bounded ✦ Gated ✦ Explainable ✦"
          speed={0.55}
          curveAmount={130}
          className="font-semibold uppercase tracking-tight"
        />
      </div>

      {/* ------------------------------------------------------------ protocol */}
      <Section
        id="protocol"
        eyebrow="What is actually built"
        title="None of this is a mock."
        lede="Every claim below is code in the repository, not a slide."
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {BUILT.map((b) => (
            <article key={b.title} id={b.id} className="panel-card flex flex-col rounded-2xl p-5">
              <p
                className="font-mono text-[10.5px] uppercase tracking-[0.14em]"
                style={{ color: "var(--brand-blue)" }}
              >
                {b.kicker}
              </p>
              <h3 className="mt-2 text-[15px] font-semibold leading-snug tracking-tight">
                {b.title}
              </h3>
              <p className="mt-2.5 text-[13.5px] leading-[1.62]" style={{ color: "var(--muted)" }}>
                {b.body}
              </p>
            </article>
          ))}
        </div>
      </Section>

      {/* --------------------------------------------------------------- buyer */}
      <Section
        id="buyer"
        eyebrow="The other side"
        title="A buying agent that genuinely is not ours."
      >
        <div className="panel-card-lg rounded-2xl p-6 sm:p-8">
          <p className="max-w-3xl text-[15px] leading-[1.72]" style={{ color: "var(--muted)" }}>
            A control plane that only ever sees requests from its own author proves nothing. So the
            repository ships a second program in{" "}
            <code
              className="rounded px-1.5 py-0.5 font-mono text-[13px]"
              style={{ background: "var(--panel-2)", color: "var(--foreground)" }}
            >
              buyer/
            </code>{" "}
            that shops autonomously against the merchant over the wire — and it is structurally
            incapable of cheating.
          </p>
          <ul className="mt-6 grid gap-x-8 gap-y-3 sm:grid-cols-2">
            {[
              "Zero imports from the merchant's source tree.",
              "No database URL, no service-role key, no Razorpay secret.",
              "Its whole world is a public catalog, a signing key, and one URL.",
              "It reimplements the wire format independently — so if the two disagree, verification fails loudly.",
            ].map((line) => (
              <li key={line} className="flex gap-2.5 text-[13.5px] leading-[1.6]">
                <span
                  className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: "var(--decision-allow)" }}
                />
                <span style={{ color: "var(--muted)" }}>{line}</span>
              </li>
            ))}
          </ul>
          <p className="mt-6 text-[13.5px] leading-[1.6]" style={{ color: "var(--muted-2)" }}>
            If that process could reach the database, the demo would be theatre.
          </p>
        </div>
      </Section>

      {/* -------------------------------------------------------------- footer */}
      <footer className="relative mt-8 w-full border-t" style={{ borderColor: "var(--panel-border)" }}>
        <div className="mx-auto w-full max-w-6xl px-6 py-16 sm:px-8">
          <div className="flex flex-col items-start justify-between gap-10 md:flex-row md:items-end">
            <div className="max-w-lg">
              <h2 className="text-[clamp(1.6rem,3.2vw,2.2rem)] font-semibold leading-tight tracking-[-0.03em] text-balance">
                See it decide, live.
              </h2>
              <p className="mt-3 text-[14.5px] leading-[1.65]" style={{ color: "var(--muted)" }}>
                The dashboard runs a real agent against a real catalog, and shows every allow, block
                and escalation as it happens — with the rule that caused it.
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <Link
                  href={signedIn ? "/dashboard" : "/sign-up"}
                  className="rounded-xl px-5 py-2.5 text-[13.5px] font-semibold text-white transition-all hover:brightness-110"
                  style={{ background: "linear-gradient(135deg, #0d94fb, #0b7fd9)" }}
                >
                  {signedIn ? "Open the dashboard" : "Get started"}
                </Link>
                <a
                  href="/architecture.html"
                  target="_blank"
                  rel="noopener"
                  className="rounded-xl border px-5 py-2.5 text-[13.5px] font-semibold transition-colors hover:bg-white/[0.04]"
                  style={{ borderColor: "var(--panel-border-strong)" }}
                >
                  Read the architecture
                </a>
              </div>
            </div>

            <div className="flex flex-col gap-2.5 font-mono text-[12px]">
              {[
                { label: "Source on GitHub", href: "https://github.com/amaltomajith/Mandate" },
                { label: "Architecture, end to end", href: "/architecture.html" },
                { label: "Sign in", href: "/login" },
              ].map((l) => (
                <a
                  key={l.label}
                  href={l.href}
                  {...(l.href.startsWith("http")
                    ? { target: "_blank", rel: "noopener noreferrer" }
                    : {})}
                  className="transition-colors hover:text-[var(--foreground)]"
                  style={{ color: "var(--muted)" }}
                >
                  {l.label}
                </a>
              ))}
            </div>
          </div>

          <div
            className="mt-14 flex flex-col gap-2 border-t pt-6 text-[11.5px] sm:flex-row sm:items-center sm:justify-between"
            style={{ borderColor: "var(--panel-border)", color: "var(--muted-2)" }}
          >
            <div className="flex items-center gap-2">
              <MandateMark size={18} />
              <span>Mandate — a merchant-owned control plane for agent-initiated money actions.</span>
            </div>
            <span>Built for Razorpay Track 01 — AI Growth &amp; Agentic Commerce.</span>
          </div>
        </div>
      </footer>
    </main>
  );
}

function Section({
  id,
  eyebrow,
  title,
  lede,
  children,
}: {
  id?: string;
  eyebrow: string;
  title: string;
  lede?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="mx-auto w-full max-w-6xl scroll-mt-24 px-6 py-16 sm:px-8 sm:py-20">
      <p
        className="font-mono text-[11px] uppercase tracking-[0.2em]"
        style={{ color: "var(--brand-blue)" }}
      >
        {eyebrow}
      </p>
      <h2 className="mt-3 max-w-3xl text-[clamp(1.6rem,3.4vw,2.35rem)] font-semibold leading-[1.15] tracking-[-0.032em] text-balance">
        {title}
      </h2>
      {lede && (
        <p className="mt-4 max-w-2xl text-[14.5px] leading-[1.68]" style={{ color: "var(--muted)" }}>
          {lede}
        </p>
      )}
      <div className="mt-10">{children}</div>
    </section>
  );
}
