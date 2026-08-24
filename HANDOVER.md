# Mandate — HANDOVER

Status snapshot as of this build session. Read this before touching anything —
it's the resumable reference for both "continue with Claude Code" and "hand
phases to Antigravity" per the original project brief.

## 1. What this is

Mandate is a merchant-owned control plane for agent-initiated money actions,
built for Razorpay's hackathon (Track 01 — AI Growth & Agentic Commerce). This
codebase is a **deliberately re-scoped rebuild** of a larger planning document
the project started from — see "What changed from the original plan" below for
why, and `docs/original-mandate-doc.md` is not checked in anywhere; the scoping
decisions themselves are captured here instead.

The one-line pitch: an MCP server sits between any agent (third-party AI
shopping agent, or the merchant's own automation) and Razorpay's money-moving
endpoints, enforces policy-as-code, escalates to a human when needed, and
explains every decision by tracing a real graph.

## 2. Status: what's built vs what's untested

**Built and verified (`npm run build` + `npm run lint` both pass clean):**

- Supabase Postgres schema, RLS policies, Realtime publication (`supabase/migrations/0001_init.sql`)
- MCP server (Streamable HTTP, session-based) with all 4 tools: `simulate_action`, `enforce_action`, `explain`, `draft_policy`
- Policy engine: cap / velocity / category_block / step_up, fixed priority order, pure + unit-testable
- Web Bot Auth-style request signing and verification (Ed25519, RFC 9421-shaped headers) wired into every MCP call
- Razorpay/RazorpayX integration code for orders, refunds, payouts, subscriptions
- Trust score formula, computed and stored per agent
- Merchant dashboard: Supabase Auth login, live (Realtime) escalations/alerts/policy panels, Horizon trigger
- 3D graph (react-three-fiber): entity hue, trust aura, decision rings, hover inspect, fork/branch edges
- Demo Checkout Agent script that signs its own requests and runs the full demo scenario
- Seed / key-generation / dashboard-user CLI scripts

**Not yet run end-to-end** — because it needs real credentials I can't create on
your behalf (account creation / entering secrets isn't something I do for you):

- No Supabase project exists yet — the schema has never actually been applied
- No Razorpay/RazorpayX test-mode keys are configured
- No Gemini API key is configured
- The dashboard, MCP server, and demo agent have not been run against live infrastructure

**Your next step is §8 (Setup).** Everything downstream of that is expected to
work, but "compiles clean" and "verified end-to-end against real Supabase/Razorpay"
are different claims — say so honestly if you demo this before running it once
yourself.

## 3. What changed from the original plan, and why

The original handover doc was a genuinely well-researched positioning
document — the "why this gap is real" research (§3 of the original) holds up
and is worth keeping in the pitch. But as a *build* spec it had real gaps and
was sized for a team-week, not a solo session. Concretely, this build:

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
   signature scheme**, not the full IETF spec — see §5 below for exactly what
   that means and why it's an honest choice, not a shortcut.
6. **Added a human-in-the-loop gate that was implied but never enforced.**
   `draft_policy` output is always `status: pending_review`. Nothing — human or
   Horizon-sourced — activates without an explicit dashboard approval. This
   matters for the "bounded and gated" claim in Track 1's bar.
7. **Cut scope that was unbuildable solo** (see §9 "Roadmap / explicitly cut"
   below) rather than half-building it. Nothing in the shipped UI has a button
   that doesn't work.
8. **Simplified the stack**: one Next.js 16 app (dashboard + API routes + MCP
   server) instead of an implied separate MCP server; react-three-fiber
   instead of raw Three.js r128; Gemini's `@google/genai` SDK for `explain`/
   `draft_policy` structured output.

## 4. Architecture as-built

```
Third-party AI agent / demo Checkout Agent (scripts/checkout-agent.ts)
        │  Web Bot Auth-signed MCP calls (Streamable HTTP, POST /api/mcp)
        ▼
Next.js app (single Vercel-deployable)
  ├─ /api/mcp            MCP server: signature verify → session → 4 tools
  ├─ /api/wba-directory  public key directory (rewritten from /.well-known/...)
  ├─ /login, /dashboard  merchant UI — Supabase Auth, Realtime, 3D graph
  └─ src/lib/
       policy/           pure rule evaluator
       webBotAuth/       Ed25519 signing/verification, RFC 9421-shaped headers
       razorpay/         Orders/Refunds/Subscriptions SDK + RazorpayX REST client
       mcp/               tool implementations, trace/trust bookkeeping
       gemini/           explain() + draft_policy() structured generation
        │
        ▼
Supabase Postgres (agents, mandates, customers, policy_rules, traces,
                    escalations, alerts) — RLS for dashboard reads, service
                    role for all writes
        │
        ▼
Razorpay test-mode API + RazorpayX test-mode API
```

### Why one Next.js app, not a separate MCP server

The original doc implied Mandate MCP server + separate frontend. Collapsing
them into one Next.js deployment removes a whole category of "which service
talks to which" wiring for a solo build, and Next's route handlers are a fine
home for a Streamable HTTP MCP endpoint — see `src/app/api/mcp/route.ts`.

### Session handling on serverless (read this before deploying)

MCP's Streamable HTTP transport is session-based: `initialize` gets a
`mcp-session-id`, and every later call in that session must hit the *same*
transport instance (it's the transport, not the DB, that remembers
initialization happened). `src/lib/mcp/sessionStore.ts` keeps sessions in an
in-memory `Map` for the lifetime of the Node process.

That's correct for local dev and for a single warm Vercel function instance —
which is what a live demo actually is. It stops being correct the moment you
scale to multiple instances (a session's second request could land on a
process that never saw its `initialize`). Fixing that means moving session
state into Supabase or Redis — a real, known next step, not a bug that
surprised us.

## 5. Web Bot Auth: what's real, what's simplified

Every MCP call is signed with Ed25519 and verified server-side before it
reaches the policy engine — this part is fully real cryptography, not a demo
stub (`src/lib/webBotAuth/`). What's *not* full spec compliance:

- Covers a fixed component set (`@method`, `@path`, `@authority`,
  `content-digest`) rather than RFC 9421's full derived-component vocabulary.
- No signature-algorithm negotiation — Ed25519 only.

This is a deliberate, documented choice: Web Bot Auth's own IETF working group
was chartered in 2026 and has **no adopted documents yet**. There is no single
canonical implementation to be byte-compatible with. What the pitch needs —
and what's actually here — is real asymmetric-key request signing, real
verification, a real key registry (`/api/wba-directory`), and the same header
shape (`Signature-Input` / `Signature` / `Content-Digest`) that Visa's TAP and
Mastercard's Agent Pay also build on. Say this plainly if asked; it reads as
informed, not naive.

The "live self-defense" demo beat (`scripts/checkout-agent.ts`'s tampered
request) is real: a corrupted signature is rejected in `/api/mcp/route.ts`
*before* the MCP transport or policy engine ever see it, logged as a distinct
`protocol_reject` trace.

## 6. Razorpay integration: what's real S2S vs what isn't

Verified against Razorpay's actual API docs during this build (not assumed):

- **`payout.create` (RazorpayX) and `refund.create`** are genuinely
  server-to-server, no customer-facing step. `payout.create` is the demo
  script's primary "real money movement" proof point for exactly this reason.
- **`order.create` and `subscription.create`** are real S2S calls too, but
  they're the *first* leg of flows whose completion (actually capturing a
  card payment, or a customer authorizing a UPI Autopay mandate) is, by
  Razorpay's own design, a customer-facing step — Checkout.js or an auth
  link — that happens outside this control plane. Mandate's job is the gate
  before and the record after, not reimplementing Razorpay's checkout UI.
  There is no documented headless "just charge a card server-side" API in
  test mode; don't build one to fake it.

**Operational gotcha, not hypothetical:** RazorpayX requires allowlisting the
calling server's IP in the RazorpayX dashboard before `/payouts` accepts
requests, even in test mode. If payouts fail with a 403, that's almost always why.

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

Every agent starts at a neutral 50. See `src/lib/trust/score.ts` — the
`protocolRejectPenalty` term is a small addition beyond the original build
plan (repeated malformed/tampered calls should cost *something*, even though
they're a protocol-layer signal, not a policy judgment).

## 8. Setup — do this before running anything

1. **Supabase**: create a project at supabase.com. Copy the project URL,
   `anon` key, and `service_role` key into `.env.local` (copy `.env.example`
   first). Run `supabase/migrations/0001_init.sql` against it (Supabase
   Studio's SQL editor, or the CLI).
   *Note: Supabase free-tier projects auto-pause after 7 days of inactivity —
   open the dashboard once beforehand if you haven't touched it in a while.*
2. **Razorpay**: generate **test-mode** API keys (Dashboard → Settings → API
   Keys) into `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`.
3. **RazorpayX**: enable test mode, add a dummy test balance, get your test
   `account_number` into `RAZORPAYX_ACCOUNT_NUMBER`, and **allowlist the IP
   you'll be calling from** (RazorpayX dashboard) — see §6's gotcha.
4. **Gemini**: get a free API key at aistudio.google.com/apikey into
   `GEMINI_API_KEY`.
5. `npm install` (already done in this session, but for a fresh clone).
6. `npm run seed` — creates the four starter policy rules the demo script
   depends on, plus one sample customer.
7. `npm run create-dashboard-user -- you@merchant.com "some-password"` — the
   merchant login (Supabase Auth). Different from an agent identity.
8. `npm run gen-agent-key -- "Checkout Agent"` — prints an agent id and a
   secret key. Put them in `.env.local` (or your shell) as
   `CHECKOUT_AGENT_ID` / `CHECKOUT_AGENT_SECRET_KEY`.
9. `npm run dev`, log into `/dashboard` with the user from step 7.
10. `npm run demo:checkout` — runs the full demo script against the running
    dev server (needs `MANDATE_APP_URL`, default `http://localhost:3000`).

## 9. Demo script (the "one failure handled gracefully" beat)

`scripts/checkout-agent.ts`, matching Track 1's bar exactly:

1. Three normal payouts under every threshold — calm, all `allow`.
2. One payout at ₹6,000, over the seeded ₹5,000 step-up rule → `escalate`,
   *not* blocked. Sits in the dashboard's Escalations panel with a
   plain-language `explain()`-quality reasoning string.
3. Approve it in the dashboard (`approveEscalation` server action) — the real
   RazorpayX payout executes only now, driven by the human, through Supabase
   Auth, not Web Bot Auth (see the "two auth layers" distinction in the
   original doc's §8 — still true here).
4. A deliberately tampered signed request → rejected at the protocol layer,
   logged as `protocol_reject`, never reaches the policy engine. The "live
   self-defense" beat.
5. Optional, if there's time: the dashboard's "Simulate Horizon finding an
   update" button → real `draft_policy` pipeline → backtested candidate rule
   sitting in pending review.

## 10. Roadmap / explicitly cut (not built, not stubbed)

These have a real, working foundation underneath (the policy engine, the
trace/graph model, `draft_policy`) but the specific feature isn't built. None
of these have a dead button in the UI.

- **Horizon's live RSS/GitHub polling.** The dashboard's "Simulate Horizon"
  button feeds one curated example into the *real* `draft_policy` pipeline —
  the pipeline is real, the scheduled polling that would trigger it live isn't.
- **Slack/email alert delivery.** Alerts are real rows in `alerts`, shown live
  in the dashboard panel. No outbound webhook.
- **Time-travel scrubbing, shareable PDF snapshots, voice ask-and-fly,
  constellation/Agent Trust Index zoom view.** Not built.
- **A second full demo agent (Recovery Agent).** The policy engine already
  supports it — payout/refund retry logic needs no new engine code — it's
  just not wrapped as a second scripted demo agent.
- **Mandate/customer graph nodes.** The schema supports them
  (`mandates`, `customers` tables) but the demo flow doesn't populate them
  meaningfully, so the 3D graph renders agent/rule/transaction nodes only.

## 11. Where things live

```
supabase/migrations/0001_init.sql     schema, RLS, realtime publication
src/types/db.ts                       hand-written Database types (regenerate once a live project exists)
src/lib/policy/                       rule types + pure evaluator
src/lib/trust/score.ts                trust formula
src/lib/webBotAuth/                   keys, canonical signing, sign, verify
src/lib/razorpay/                     SDK client, RazorpayX REST client, action dispatch
src/lib/mcp/                          schemas, server (4 tools), session store, trace helpers
src/lib/gemini/                       Gemini client
src/lib/actions/                      dashboard server actions (escalations, policy, horizon)
src/app/api/mcp/route.ts              the MCP endpoint (verify → session → transport)
src/app/api/wba-directory/route.ts    public key directory
src/app/dashboard/, src/app/login/    merchant UI
src/components/graph/                 3D graph (layout.ts is the pure/testable part)
src/components/dashboard/             panels + realtime refresher
scripts/                              seed, gen-agent-key, create-dashboard-user, checkout-agent demo
```

## 12. Resuming in Antigravity

Paste this file plus the relevant `src/lib/...` files for whatever phase
you're extending — this file is written to stand alone as context. The
"Roadmap / explicitly cut" list (§10) is the natural next-phases list if you
want to hand Antigravity a scoped next task instead of the whole thing at once.
