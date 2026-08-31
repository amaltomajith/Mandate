# Mandate

**A merchant-owned control plane for money that AI agents move.**

Built for the Razorpay AI Buildathon — Track 01, AI Growth & Agentic Commerce.

An AI agent asks Mandate for permission before it moves money. Mandate checks
that the agent still holds a valid standing authorization, evaluates the
merchant's spending rules, and either lets the real Razorpay call through,
escalates it to a human, or blocks it — then records exactly why, permanently,
so the decision can be explained later.

Live: <https://mandate-amaltomajiths-projects.vercel.app>

---

## How it works

An agent calls one endpoint — `POST /api/mcp` — and every request is
Ed25519-signed (Web Bot Auth). The decision path is:

```
signed request
  → verify signature          invalid → protocol_reject, never reaches policy
  → check mandate status      revoked/paused → block
  → evaluate the active rules
       category_block → cap → velocity → trust_floor → step_up
       (first match wins)
  → allow | escalate | block
  → real Razorpay call, but only on allow
  → write trace, recompute agent trust
```

Nothing is faked at the edges: signatures are real Ed25519, allowed actions are
real Razorpay API calls, and every decision is a row in Postgres that the
dashboard reads live.

### Four MCP tools, reused everywhere

| Tool | Does | Side effect |
| --- | --- | --- |
| `simulate_action` | Full decision path, returns what *would* happen | None |
| `enforce_action` | Same path; on `allow`, actually executes | Real Razorpay call |
| `explain` | Plain-language account of a past decision | None |
| `draft_policy` | Turns plain language into a structured, backtested rule | Inserts as `pending_review` — never auto-activates |

There are exactly four, and they are the same four for every agent. A new
agent needs no new tools and no new endpoint — it registers, gets credentials,
and signs.

### Five rule types

| Type | Does |
| --- | --- |
| `category_block` | Refuses a category outright, at any amount |
| `cap` | A ceiling, per transaction or per day |
| `velocity` | A rate limit — amount-blind, it's the pace that's suspicious |
| `trust_floor` | Holds an agent whose trust score has fallen, regardless of amount |
| `step_up` | Sends anything above a threshold to a human |

Priority is fixed and documented in `src/lib/policy/engine.ts`; first match
wins. `trust_floor` sits above `step_up` because "this agent hasn't earned the
benefit of the doubt" is a stronger reason to involve a human than "this amount
is large" — so the merchant reads the real cause.

### Trust, and why it isn't decoration

Every agent starts at a neutral 50 and moves with its own record, computed over
its most recent decisions rather than all history — a score that can't recover
is one no gate can meaningfully act on. `trust_floor` is what makes it
consequential: below the threshold, an agent's actions are held for a human at
any amount, because at that point the problem is the caller, not the
transaction.

Forged requests are deliberately **not** counted against anyone's score. A
request whose signature doesn't verify carries no proven identity, so
attributing it by the *claimed* agent id would let anyone destroy a
competitor's reputation with forgeries in their name.

---

## Setup

**Requires:** a Supabase project, Razorpay test-mode keys, a Groq API key, and
a Clerk application.

```bash
npm install
```

Create `.env.local`:

```bash
NEXT_PUBLIC_SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
GROQ_API_KEY=
NEXT_PUBLIC_APP_URL=http://localhost:3000

NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/login
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL=/dashboard
NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL=/dashboard
```

Apply the migrations in `supabase/migrations/` in order, via the Supabase SQL
Editor. Then seed the rules, catalog, and sample customer:

```bash
npm run seed
```

```bash
npm run dev
```

Sign in at `/login`, then use **Run demo** on the dashboard.

> **Behind a TLS-inspecting proxy** (Sophos, Zscaler, most corporate or campus
> networks)? Node ships its own CA bundle and will fail every Supabase call
> with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, even though your browser is fine.
> Start it with `NODE_OPTIONS=--use-system-ca` so Node trusts the same roots
> your OS does.

---

## Trying it

**Simulated agent** (Overview) runs an AI buyer continuously — real, signed MCP
calls through the same policy engine any external agent would hit. Most go
through; some cross the approval threshold, some touch a banned category, and
some are forged requests rejected before the engine ever sees them. Nothing is
staged: each action is weighted by scenario and then the real engine decides.

The speed control matters. Calm and Busy stay inside the agent's velocity
limit; **Stress deliberately outruns it**, so the rate limiter can be watched
engaging rather than only described.

**Register an agent** (Overview → Agent trust → *+ Register*) mints a real
Ed25519 keypair and hands back the three values an external agent needs —
endpoint, agent ID, secret key. The secret is shown once and never stored.

**Dashboard tabs:** Overview (3D entity graph, escalations, agent trust with a
per-term score breakdown) · Transactions (every decision, with the rule that
decided it) · Policies (rule management, conflict detection, plain-language
drafting) · Mandates (pause, revoke — a revoked mandate blocks the agent's very
next action).

---

## What's real, and what isn't

**Real:** Ed25519 signature verification. `order.create` and `refund.create` as
genuine Razorpay API calls. Trust scores, traces, and mandate state computed
from actual history.

**Labeled, not hidden:**

- `subscription.create` falls back to a clearly-flagged simplified mandate
  object when Razorpay Subscriptions isn't activated on the account.
- Clerk runs on a development instance; the badge it renders is accurate.
- The policy-draft example button stands in for an automated compliance feed —
  the drafting pipeline behind it is real, the polling isn't built.
- RazorpayX payouts were removed rather than stubbed: they need a registered
  business that Razorpay itself gates, so they could never execute here.

## Stack

Next.js 16 (App Router, Turbopack) · TypeScript · Tailwind v4 ·
Supabase Postgres · Razorpay · Clerk · Groq · `@modelcontextprotocol/sdk` ·
react-three-fiber

Engineering history, architectural decisions, and the reasoning behind them
live in [HANDOVER.md](./HANDOVER.md).
