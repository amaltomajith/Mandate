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

An agent calls one endpoint — `POST /api/m/<merchant-slug>/mcp` — and every
request is Ed25519-signed (Web Bot Auth). The slug is in the path because
Mandate is multi-tenant: one deployment serves many merchants, each with its
own agents, catalog, rules and history, and an agent registered with one can
never see or act on another's. The decision path is:

```
signed request
  → verify signature          invalid → protocol_reject, never reaches policy
  → check mandate status      revoked/paused → block
  → evaluate the active rules
       category_block → catalog_scope → cap → velocity → trust_floor → step_up
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

### Six rule types

| Type | Does |
| --- | --- |
| `category_block` | Refuses a category outright, at any amount |
| `catalog_scope` | Confines an agent to the part of the catalog it was hired for |
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
> networks)? The certificate your *server* sees for Supabase is signed by the
> interceptor, not by Supabase. Your browser accepts it because the OS trusts
> that root; Node ships its own CA bundle that doesn't, so every server-side
> query fails with `fetch failed` / `UNABLE_TO_VERIFY_LEAF_SIGNATURE` while the
> site looks fine in a browser.
>
> Export the interceptor's root certificate from your OS trust store and point
> `.env.local` at it:
>
> ```bash
> MANDATE_CA_CERT=/absolute/path/to/interceptor-root.pem
> ```
>
> `npm run dev` goes through `scripts/dev.mjs`, which sets
> `NODE_EXTRA_CA_CERTS` from that before starting Next — Node only reads it at
> process start, so it can't be set from inside the app. A complete no-op if
> the variable is absent, which is the normal case.

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

**A real external agent** lives in `buyer/` — a separate process that holds
only its own keypair and talks to Mandate over signed MCP. It is the honest
test of the whole design: it shares no code with the engine and gets no special
treatment. One process is one agent, and `--profile` lets several run at once,
each with its own keypair, persona, budget and pace:

```bash
npm --prefix buyer run keygen -- --profile ergonomic   # mint a keypair
# register the public half from the Agents tab, put the private half in the profile
npm --prefix buyer start -- --profile ergonomic
```

Three profiles ship as `.env.example` files, chosen to diverge rather than to be
copies: `ergonomic` (₹15,000, deliberate, takes sensible complements), `budget`
(₹6,000, never over ₹2,000 an item, declines most offers) and `bulk` (₹60,000,
routine orders that cross the step-up line). Run them together and the trust
scores separate on their own, because the records genuinely differ.

**Dashboard tabs:** Overview (3D entity graph, revenue impact, escalations,
agent trust with a per-term breakdown) · Buy (a storefront an agent can be
watched shopping) · Catalog (products, per-agent scope, best sellers) ·
Campaigns (outbound offers an agent negotiates) · Agents (register, pause,
retire, per-agent trust history) · Transactions (every decision, with the rule
that decided it) · Policies (rule management, conflict detection,
plain-language drafting, and a threshold tuner that backtests a proposed
step-up level against this merchant's own traffic before anything is applied) ·
Mandates (pause, revoke — a revoked mandate blocks the agent's very next
action) · Settings (account, and a self-serve reset).

**Starting over** is a button rather than a support ticket. Settings offers two
resets, both scoped to the signed-in account and both showing exact row counts
before you confirm: *Reset transactions* clears history but keeps every
registered agent and its keypair, which is the slow part of starting again;
*Reset everything* returns the account to what a new sign-up gets, and asks you
to type the account slug rather than trusting a single click.

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

## Verifying it yourself

Correctness here is not a matter of clicking around the dashboard. Seven suites
drive the real engine against throwaway merchants and assert what actually
happened — 125 checks:

```bash
npx tsx scripts/verify-policy.ts        # every rule type, both directions      24
npx tsx scripts/verify-catalog.ts       # catalog, per-agent scope, headroom    20
npx tsx scripts/verify-agent-control.ts # cooperative pause vs enforced retire  21
npx tsx scripts/verify-mrtr.ts          # counter-offers and the MRTR invariant 17
npx tsx scripts/verify-graph-colors.ts  # what a node in the graph may mean      8
npx tsx scripts/verify-replay.ts        # a captured request, resent             6
npx tsx scripts/verify-settings.ts      # the self-serve reset, and isolation   29
npx tsx scripts/verify-e2e.ts           # end to end, including tenant isolation
```

`verify-e2e` is the one to run if you only run one: it proves tenant isolation,
which is the claim that would matter most in production and the one that is
worthless if merely asserted.

To rebuild a demo history at a pace the velocity rule considers ordinary:

```bash
MANDATE_MERCHANT_SLUG=<your-slug> npx tsx scripts/regen.ts 100
```

It deliberately paces itself. Running ticks back to back trips the rate limiter
on every subsequent action and collapses the trust scores — the resulting
history then reads as a system being throttled rather than one behaving
normally.

---

## Stack

Next.js 16 (App Router, Turbopack) · TypeScript · Tailwind v4 ·
Supabase Postgres · Razorpay · Clerk · Groq · `@modelcontextprotocol/sdk` ·
react-three-fiber

Engineering history, architectural decisions, and the reasoning behind them
live in [HANDOVER.md](./HANDOVER.md).
