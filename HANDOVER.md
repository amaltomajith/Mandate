# Mandate — HANDOVER

Status snapshot as of this build session. Read this before touching anything —
it's the resumable reference for both "continue with Claude Code" and "hand
phases to Antigravity" per the original project brief.

## 1. What this is

Mandate is a merchant-owned control plane for agent-initiated money actions,
built for Razorpay's hackathon (Track 01 — AI Growth & Agentic Commerce). This
codebase is a **deliberately re-scoped rebuild** of a larger planning document
the project started from — see "What changed from the original plan" below for
why.

The one-line pitch: an MCP server sits between any agent (third-party AI
shopping agent, or the merchant's own automation) and Razorpay's money-moving
endpoints, enforces policy-as-code, escalates to a human when needed, and
explains every decision by tracing a real graph.

## 2. Status: what's built vs what's untested

**Built and verified (`npm run build` + `npm run lint` both pass clean):**

- Supabase Postgres schema, RLS policies (`supabase/migrations/0001_init.sql`)
- MCP server (Streamable HTTP, session-based) with all 4 tools: `simulate_action`, `enforce_action`, `explain`, `draft_policy`
- Policy engine: cap / velocity / category_block / step_up, fixed priority order, pure + unit-testable
- Web Bot Auth-style request signing and verification (Ed25519, RFC 9421-shaped headers) wired into every MCP call
- Razorpay/RazorpayX integration code for orders, refunds, payouts, subscriptions
- Trust score formula, computed and stored per agent
- Merchant dashboard: Clerk login, a self-resolving onboarding banner, live-polling escalations/alerts/policy panels, Horizon trigger
- 3D graph (react-three-fiber + postprocessing): entity hue, trust aura, decision rings, bloom/starfield/grid, hover inspect, fork/branch edges
- Demo Checkout Agent script that signs its own requests and runs the full demo scenario
- Seed / key-generation CLI scripts
- Full visual pass: rich dark control-plane theme (deep navy/black, Razorpay-inspired blue `#2F8FFF` as the accent) with a bloom-lit, starfield-and-grid 3D graph panel as the centerpiece. (A light "white/navy" variant was tried first and reverted — dark read as more premium for this product; the CSS tokens in `globals.css` are the single place to flip it back if that changes again.)

**Fully configured and verified live, this session:**

- Supabase project, schema applied, RLS in place
- Razorpay test-mode keys (`RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`)
- Groq API key (`GROQ_API_KEY`) — see §5a, this replaced Gemini; the exact
  `draft_policy` prompt was tested end-to-end against the live API
- Clerk keys — signed in, dashboard confirmed rendering (dark theme, 3D graph,
  hover tooltips all checked)
- `npm run seed` run (policy rules + sample customer), `npm run gen-agent-key`
  run (a real registered agent identity, id + secret key in `.env.local`)
- **`npm run demo:checkout` run partway, successfully**: MCP session
  `initialize` → Web Bot Auth signature verify → `simulate_action` all
  confirmed working together, live, for the first time. It stopped at the
  first `enforce_action` call because RazorpayX (see §6) needs a registered
  business account, which wasn't available — **fixed by switching the demo's
  real-money action from `payout.create` to `order.create`** (§6), which only
  needs the standard Razorpay keys already configured. Re-running the demo
  script end to end is the very next step, not yet confirmed.

Everything above except the last full re-run is real, not aspirational — this
is closer to done than a fresh reader might assume from a "handover" doc.

## 3. What changed from the original plan, and why

The original handover doc was a genuinely well-researched positioning
document — the "why this gap is real" research holds up and is worth keeping
in the pitch. But as a *build* spec it had real gaps and was sized for a
team-week, not a solo session. Concretely, this build:

1. **Added a real data model.** The original doc named Supabase as storage but
   never specified a schema. See `supabase/migrations/0001_init.sql`.
2. **Added a real policy rule language.** "Policy-as-code" was named, never
   specified. See `src/lib/policy/types.ts` + `engine.ts` — four typed rule
   kinds, fixed evaluation priority, one pure evaluator shared by simulate and
   enforce.
3. **Added a real trust-score formula.** Drove a headline visual (node
   size/aura) and the "Agent Trust Index" pitch line but was never defined.
   See `src/lib/trust/score.ts`.
4. **Added a real key-distribution design for Web Bot Auth.** "Agents sign,
   Mandate verifies against operator-published keys" had no registry. See
   `/api/wba-directory` (rewritten to `/.well-known/http-message-signatures-directory`)
   backed by `agents.public_key`.
5. **Implemented a genuine (if intentionally non-spec-complete) RFC 9421-shaped
   signature scheme**, not the full IETF spec — see §5 below.
6. **Added a human-in-the-loop gate that was implied but never enforced.**
   `draft_policy` output is always `status: pending_review`. Nothing — human or
   Horizon-sourced — activates without an explicit dashboard approval.
7. **Cut scope that was unbuildable solo** (see §10 "Roadmap / explicitly cut")
   rather than half-building it. Nothing in the shipped UI has a dead button.
8. **Simplified the stack**, then **swapped two pieces mid-build on request**:
   Gemini → Groq (§5a) and Supabase Auth → Clerk (§5b). Both are documented
   below with what moved and why, not just "it's Clerk now."

## 4. Architecture as-built

```
Third-party AI agent / demo Checkout Agent (scripts/checkout-agent.ts)
        │  Web Bot Auth-signed MCP calls (Streamable HTTP, POST /api/mcp)
        ▼
Next.js app (single Vercel-deployable)
  ├─ /api/mcp            MCP server: signature verify → session → 4 tools
  ├─ /api/wba-directory  public key directory (rewritten from /.well-known/...)
  ├─ /login, /sign-up    Clerk-hosted auth (human/merchant)
  ├─ /dashboard          merchant UI — 3D graph, live-polling panels
  └─ src/lib/
       policy/           pure rule evaluator
       webBotAuth/       Ed25519 signing/verification, RFC 9421-shaped headers
       razorpay/         Orders/Refunds/Subscriptions SDK + RazorpayX REST client
       mcp/              tool implementations, trace/trust bookkeeping
       llm/              Groq client (explain() + draft_policy() generation)
        │
        ▼
Supabase Postgres (agents, mandates, customers, policy_rules, traces,
                    escalations, alerts) — storage only now; every read and
                    write goes through the service-role client (see §5b)
        │
        ▼
Razorpay test-mode API + RazorpayX test-mode API
```

### Why one Next.js app, not a separate MCP server

Collapsing dashboard + API routes + MCP server into one Next.js deployment
removes a whole category of "which service talks to which" wiring for a solo
build. Next's route handlers are a fine home for a Streamable HTTP MCP
endpoint — see `src/app/api/mcp/route.ts`.

### Session handling on serverless (read this before deploying)

MCP's Streamable HTTP transport is session-based: `initialize` gets a
`mcp-session-id`, and every later call in that session must hit the *same*
transport instance. `src/lib/mcp/sessionStore.ts` keeps sessions in an
in-memory `Map` for the lifetime of the Node process — correct for local dev
and a single warm Vercel instance, not correct once you scale to multiple
instances (fixing that means moving session state into Supabase or Redis).

## 5. Web Bot Auth: what's real, what's simplified

Every MCP call is signed with Ed25519 and verified server-side before it
reaches the policy engine — real cryptography, not a demo stub
(`src/lib/webBotAuth/`). What's *not* full spec compliance: a fixed covered-
component set (`@method`, `@path`, `@authority`, `content-digest`) rather than
RFC 9421's full derived-component vocabulary, and Ed25519-only (no algorithm
negotiation).

Deliberate, not lazy: Web Bot Auth's own IETF working group was chartered in
2026 and has **no adopted documents yet** — there's no canonical
implementation to be byte-compatible with. What's here is real asymmetric-key
signing, real verification, a real key registry (`/api/wba-directory`), and
the same header shape (`Signature-Input` / `Signature` / `Content-Digest`)
Visa's TAP and Mastercard's Agent Pay also build on.

The "live self-defense" beat (`scripts/checkout-agent.ts`'s tampered request)
is real: a corrupted signature is rejected in `/api/mcp/route.ts` *before* the
MCP transport or policy engine ever see it, logged as `protocol_reject`.

### 5a. LLM provider: Groq, not Gemini

Gemini's free tier wasn't usable during this build, so `explain()` and
`draft_policy()` run on **Groq** instead (`src/lib/llm/client.ts`), via the
`openai` npm SDK pointed at `https://api.groq.com/openai/v1` — Groq's chat
completions API is OpenAI-compatible, so no Groq-specific SDK dependency was
needed. Model: `openai/gpt-oss-120b`. Groq's own docs list
`llama-3.3-70b-versatile` as a production model, but it 404'd ("does not exist
or you do not have access to it") on this account — the catalog is
account/region-gated in ways the docs don't reflect. Don't trust the docs list
a second time; verify with `GET https://api.groq.com/openai/v1/models` against
the actual configured key before picking a model. Note also that `gpt-oss-120b`
is a reasoning model — it spends tokens on hidden chain-of-thought before
`message.content`, so neither caller sets `max_tokens` (capping it low
truncates the real answer before it's written).

`draft_policy` uses Groq's broadly-supported `json_object` response format
plus a Zod schema validated on our side, rather than Groq's model-gated
`json_schema` structured-output mode — more portable across whichever Groq
model ends up configured. If Groq ever becomes unavailable, swapping the
provider again means touching only `src/lib/llm/client.ts` and the two callers
in `src/lib/mcp/tools/`.

### 5b. Dashboard auth: Clerk, not Supabase Auth

Human/merchant login moved to **Clerk** (`@clerk/nextjs`) this session. What
that changed:

- `src/proxy.ts` is now `clerkMiddleware()`, protecting everything except
  `/login`, `/sign-up`, `/api/mcp`, and `/api/wba-directory` (those two
  authenticate themselves — see §5).
- `/login` and `/sign-up` render Clerk's `<SignIn>` / `<SignUp>` components
  inside `src/components/auth/AuthShell.tsx` (a split hero: brand story on the
  left, the Clerk card on the right — this is also the app's onboarding copy,
  since it's the first thing anyone sees).
- `src/lib/actions/authGuard.ts` now resolves the acting user via Clerk's
  `currentUser()` instead of a Supabase session.
- **`src/lib/dashboardData.ts` now reads through the Supabase *service-role*
  client, not an RLS-scoped one.** Clerk gates the routes at the proxy layer;
  Supabase's `authenticated`-role RLS policies from the original migration are
  no longer this app's access boundary (they're harmless, just vestigial —
  the MCP server's writes already used the service role).
- **Realtime became polling.** The old `RealtimeRefresher` subscribed to
  Supabase Realtime with the *anon* key from the browser. With Supabase Auth
  gone, that anon-key connection has no session backing it — and this schema's
  RLS only grants reads to `authenticated`, not `anon`. Opening `anon` SELECT
  policies just to keep Realtime working would make the tables readable to
  anyone holding the (public, bundled) anon key, bypassing Clerk entirely.
  `src/components/dashboard/LiveRefresher.tsx` does a plain 4-second
  `router.refresh()` poll instead — a real, deliberate tradeoff, not an
  oversight, and visually indistinguishable from push updates at demo pace.
- `scripts/create-dashboard-user.ts` is gone — Clerk's own `/sign-up` page
  handles account creation now, self-serve, no CLI step required.

## 6. Razorpay integration: what's real S2S vs what isn't

Verified against Razorpay's actual API docs during this build (not assumed):

- **`payout.create` (RazorpayX) and `refund.create`** are genuinely
  server-to-server, no customer-facing step.
- **`order.create` and `subscription.create`** are real S2S calls too, but
  they're the *first* leg of flows whose completion (capturing a card payment,
  or a customer authorizing a UPI Autopay mandate) is, by Razorpay's own
  design, a customer-facing step outside this control plane. There is no
  documented headless "just charge a card server-side" API in test mode;
  don't build one to fake it.

### RazorpayX needs a registered business — even for test mode

Found out the hard way: RazorpayX's dashboard gates access behind having a
registered business account, not just a Razorpay login. Test mode with a
dummy balance is real once you're in, but getting in isn't self-serve the way
standard Razorpay test-mode is — and on top of that, RazorpayX requires
**allowlisting the calling server's IP** before `/payouts` accepts requests
even in test mode. Neither of those is a hackathon-friendly five minutes if
you don't already have a registered business.

**Consequence: `scripts/checkout-agent.ts` uses `order.create` as its
real-money-adjacent proof point, not `payout.create`.** `order.create` needs
nothing but standard `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` (no business
registration gate) and is still a real, live Razorpay API call — it shows up
in your test-mode Orders dashboard. The `payout.create` code path in
`src/lib/razorpay/actions.ts` and `src/lib/razorpay/x.ts` is fully written and
untouched; `enforce_action` already supports it. If RazorpayX access shows up
later, swap the demo script's action type back — no engine changes needed.

## 7. Trust score

```
score = clamp(0, 100,
  50
  + 30 * (approvals - blocks) / total
  - 20 * (escalations / total)
  + 10 * min(accountAgeDays, 30) / 30
  - 5  * min(protocolRejects, 4)   // small, capped penalty added beyond the plan
)
```

Every agent starts at a neutral 50. See `src/lib/trust/score.ts`.

## 8. Setup — do this before running anything

1. **Supabase**: create a project at supabase.com. Copy the project URL,
   anon/publishable key, and service_role/secret key into `.env.local` (copy
   `.env.example` first). Run `supabase/migrations/0001_init.sql` against it
   via the SQL Editor. *Free-tier projects auto-pause after 7 days of
   inactivity — open the dashboard once beforehand if it's been idle.*
2. **Razorpay**: test-mode keys (Dashboard → Settings → API Keys) into
   `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`. This alone is enough to run the
   demo script (§6 — it uses `order.create`, not RazorpayX payouts).
3. **RazorpayX** (optional, needs a registered business — see §6): enable
   test mode, add a dummy test balance, get the test `account_number` into
   `RAZORPAYX_ACCOUNT_NUMBER`, and allowlist the calling IP. Only needed if
   you want to exercise `payout.create` specifically.
4. **Groq**: get a free key at console.groq.com/keys into `GROQ_API_KEY`.
5. **Clerk**: create an application at clerk.com, copy the publishable and
   secret keys into `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY`.
6. `npm install`.
7. `npm run dev`, sign up at `/sign-up` (Clerk, self-serve).
8. On the dashboard, click **"Run demo"** — it seeds the policy rules, sets up
   an agent identity, and runs the full scenario (§9) in one click. No further
   CLI steps needed. (The CLI equivalents — `npm run seed`, `npm run
   gen-agent-key -- "Checkout Agent"`, `npm run demo:checkout` — still work
   individually if you want more control, and share the same underlying code
   via `src/lib/demo/`.)

## 9. Demo script (the "one failure handled gracefully" beat, and closing the Track 01 gap)

`src/lib/demo/runDemo.ts` (the dashboard's "Run demo" button and
`scripts/checkout-agent.ts` are both thin wrappers around this one
implementation), matching Track 1's bar *and* its actual ask — see the note
below on why the catalog/upsell part exists at all.

1. The agent buys a **Wireless Mouse** from a small catalog
   (`src/lib/demo/catalog.ts`) — a real Razorpay test-mode order.
2. It then proposes a **cross-sell**: a Mechanical Keyboard, "because
   customers who buy this mouse usually complete the desk with this
   keyboard" — a second real order, flagged distinctly in the UI as an
   upsell. This is deliberate, not decoration: Track 01 asks for "an agent
   that grows revenue," not just an agent that places orders, and the
   original build had nothing that did this.
3. A Laptop Stand purchase, and its own paired upsell (a USB-C Hub).
4. A **Premium Standing Desk** at ₹6,999, over the seeded ₹5,000 step-up rule
   → `escalate`, *not* blocked. Sits in the dashboard's Escalations panel with
   a plain-language reasoning string. This is the "one failure handled
   gracefully" beat.
5. Approve it in the dashboard (`approveEscalation` server action) — the real
   Razorpay order-create call executes only now, driven by the human through
   Clerk, not Web Bot Auth (see §5b's "two auth layers").
6. A deliberately tampered signed request → rejected at the protocol layer,
   logged as `protocol_reject`, never reaches the policy engine. The "live
   self-defense" beat.
7. Optional, if there's time: the dashboard's "Simulate Horizon finding an
   update" button → real `draft_policy` pipeline → backtested candidate rule
   sitting in pending review.

**Track 01 fit, honestly assessed:** "The Bar" quote (*"every money action
explainable, bounded and gated... one failure handled gracefully"*) is
close to a direct match for what this build does — that was the design
center from the start. The track's other half — *"build an agent that grows
revenue... or makes a merchant transactable by an AI buyer end to end"* — was
thin before this catalog/upsell pass: the original demo agent placed
fixed-amount orders purely to exercise policy rules, with no real "agentic
commerce" behavior. It's better now, but still deliberately modest (a static
2-item upsell map, not a real recommendation engine) — if you want it
stronger, that's the honest next place to invest, not more control-plane
depth.

**Why the seeded velocity rule is 30/hour, not 5/hour:** it was originally
5/hour, which meant one full "Run demo" click used the entire hourly quota
for that agent — clicking "Run again" (the whole point of making the button
repeatable, e.g. for a live pitch) would then get blocked by the rate limiter
instead of showing the intended escalate/allow/reject outcomes. Bumped to 30
so several repeat runs fit inside an hour. `src/lib/demo/seedData.ts` also
migrates a pre-existing "Max 5 actions/hour per agent" row in place if it
finds one, rather than leaving a stale duplicate active alongside the new one.

## 10. Roadmap / explicitly cut (not built, not stubbed)

These have a real, working foundation underneath but the specific feature
isn't built. None of these have a dead button in the UI.

- **Horizon's live RSS/GitHub polling.** The dashboard's "Simulate Horizon"
  button feeds one curated example into the *real* `draft_policy` pipeline.
- **Slack/email alert delivery.** Alerts are real rows in `alerts`, shown live
  in the dashboard panel. No outbound webhook.
- **Time-travel scrubbing, shareable PDF snapshots, voice ask-and-fly,
  constellation/Agent Trust Index zoom view.** Not built.
- **A second full demo agent (Recovery Agent).** The policy engine already
  supports it; it's just not wrapped as a second scripted demo agent.
- **Mandate/customer graph nodes.** Schema-ready (`mandates`, `customers`
  tables), not populated by the demo flow, so the 3D graph renders
  agent/rule/transaction nodes only.
- **True push-based Realtime.** Traded for a 4s poll when auth moved to Clerk
  — see §5b for why that's a deliberate tradeoff, not a shortcut.

## 11. Where things live

```
supabase/migrations/0001_init.sql     schema, RLS (now largely vestigial — see §5b)
src/types/db.ts                       hand-written Database types
src/lib/policy/                       rule types + pure evaluator
src/lib/trust/score.ts                trust formula
src/lib/webBotAuth/                   keys, canonical signing, sign, verify
src/lib/razorpay/                     SDK client, RazorpayX REST client, action dispatch
src/lib/mcp/                          schemas, server (4 tools), session store, trace helpers
src/lib/llm/                          Groq client (explain, draft_policy)
src/lib/actions/                      dashboard server actions (escalations, policy, horizon, demo)
src/lib/demo/                         catalog/upsell data, seed data, MandateClient, runDemoScript —
                                       shared by the dashboard's "Run demo" button AND the CLI scripts
src/lib/supabase/admin.ts             the only Supabase client left — service role, storage-only
src/proxy.ts                          Clerk middleware
src/app/api/mcp/route.ts              the MCP endpoint (verify → session → transport)
src/app/api/wba-directory/route.ts    public key directory
src/app/login/, src/app/sign-up/      Clerk auth routes
src/app/dashboard/                    merchant UI
src/components/auth/AuthShell.tsx     split-hero shell around Clerk's components (also the onboarding copy)
src/components/brand/MandateMark.tsx  shared logo mark
src/components/graph/                 3D graph + legend (layout.ts is the pure/testable part)
src/components/dashboard/             panels, buttons, DemoRunner (the "Run demo" button), toasts, live poll refresher
scripts/                              seed, gen-agent-key, checkout-agent — thin CLI wrappers around src/lib/demo/
```

## 12. Resuming in Antigravity

Paste this file plus the relevant `src/lib/...` files for whatever phase
you're extending — this file is written to stand alone as context. The
"Roadmap / explicitly cut" list (§10) is the natural next-phases list if you
want to hand Antigravity a scoped next task instead of the whole thing at once.
