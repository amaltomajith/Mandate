# Mandate

**A merchant-owned control plane for money that AI agents move.**

Built for the Razorpay AI Buildathon — Track 01, AI Growth & Agentic Commerce.

An AI agent asks Mandate for permission before it moves money. Mandate checks
that the agent still holds a valid standing authorization, works out which
policy domain the request belongs to, evaluates that domain's rules, and either
lets the real Razorpay call through, escalates it to a human, or blocks it —
then records exactly why, permanently, so the decision can be explained later.

Live: <https://mandate-amaltomajiths-projects.vercel.app>

---

## How it works

An agent calls one endpoint — `POST /api/mcp` — and every request is
Ed25519-signed (Web Bot Auth). The decision path is:

```
signed request
  → verify signature          invalid → protocol_reject, never reaches policy
  → check mandate status      revoked/paused → block
  → resolve policy domain     by action type / category
  → evaluate that domain's rules only
       category_block → cap → velocity → step_up   (first match wins)
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

There are exactly four, and they are the same four for every agent and every
domain. A new domain does not get new tools or a new endpoint.

### Policy domains

A domain is a merchant-defined governance zone — its own rules, its own
approval queue. An action lands in one based on **what it is**, never on who
called it: routing matches the request's action type or category against each
domain's routing arrays, with one catch-all default so nothing is ever
ungoverned.

That means the two axes are independent. The same agent lands in different
domains depending on what it's doing; different agents doing the same thing
land in the same domain:

| | Checkout Agent | Background Traffic Bot |
| --- | --- | --- |
| `order.create` | Purchases | Purchases |
| `subscription.create` | Recurring Mandates | *(never calls this)* |

Domains are rows, created and edited from the dashboard — not a hardcoded list.

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
Editor. Then seed the policy domains, rules, and catalog:

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

**Run demo** (dashboard) walks an AI buyer through a full scenario against real
signed MCP calls: establishing a mandate, purchases with a cross-sell, one
purchase over the approval threshold that escalates instead of firing, an
attempt to structure around that threshold caught by a rate limit, the merchant
revoking the mandate and blocking the agent's very next action, and a forged
request rejected at the protocol layer.

**Register an agent** (Overview → Agent trust → *+ Register*) mints a real
Ed25519 keypair and hands back the three values an external agent needs —
endpoint, agent ID, secret key. The secret is shown once and never stored.

**Dashboard tabs:** Overview (3D entity graph, escalations, agent trust) ·
Transactions (every decision, with the rule and domain that decided it) ·
Policies (rule management, conflict detection, plain-language drafting) ·
Domains (draggable canvas, create and route domains) · Mandates (pause, revoke).

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
