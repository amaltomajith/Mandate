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

## 2. Status: what's built and what's proven

`npx next build`, `npx tsc --noEmit` and `npx eslint src scripts` all pass clean.

**The system**

- Supabase Postgres, RLS on every table, ten migrations (`supabase/migrations/`)
- **Per-merchant tenancy** - every table carries a `merchant_id`, the tenant is
  resolved from the Ed25519 signature for agents and from Clerk for humans, and
  the public endpoints live under `/api/m/<slug>/`. See section 13.
- MCP server (Streamable HTTP, session-based), four tools: `simulate_action`,
  `enforce_action`, `explain`, `draft_policy`
- Policy engine: `category_block` > `cap` > `velocity` > `trust_floor` >
  `step_up`, fixed priority, first match wins. Pure and DB-free, so it is
  testable without a database and cannot drift from what the UI claims. Rules
  can be scoped to specific action types.
- Web Bot Auth (Ed25519, RFC 9421-shaped) on every MCP call, verified before
  the policy engine sees anything
- Razorpay test mode: `order.create`, `refund.create`, `subscription.create`
  and `payment_link.create` - see section 6
- Trust score over a 50-decision window, made consequential by `trust_floor`
- **Local inference** - Ollama/granite4 by default, with prompts classified by
  what they may send off-box. See section 5a.
- **Campaign orchestrator** - segment, plan, governed payment links, conversion
  read back from Razorpay. See section 14.
- Dashboard: Overview (3D graph, revenue impact, escalations, agent trust), Buy
  (conversational checkout, sellable catalog, buying activity), Transactions,
  Policies (rules, audit, threshold tuner, Horizon), Mandates

**Measured, not asserted**

Every number below comes from a script in `scripts/` that anyone can re-run.

- `scripts/bench-llm.ts` - the model contract suite, run against this
  codebase's real prompts. Local granite4: **42/42**.
- `scripts/verify-e2e.ts` - end to end, including tenant isolation. Creates two
  throwaway merchants and tries to make each one see the other.
- Payment links verified against Razorpay test mode: a real `plink_...` with a
  live `short_url`, read back with its `status` and `amount_paid`.

**Known limitations, stated plainly**

- Nothing converts in test mode on its own. A payment link reaches `paid` only
  if a human opens it and pays with a test card, so campaign conversion reads
  0% until someone does. The reconciler is real; the demand is not there.
- The dashboard reads the most recent 300 actions, and the panels making money
  claims say so. These are not lifetime totals.
- The campaign orchestrator has no UI yet - planner, orchestrator and
  reconciler are libraries with no dashboard surface.

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
7. **Cut scope that was unbuildable solo** (see §11 "Roadmap / explicitly cut")
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

### 5a. LLM provider: local first, and classified by what it may send

Originally Gemini, then Groq (the free Gemini tier was not usable for this
build). Now local by default, and the reason is not cost.

The semantic policy audit was posting every active rule - every cap, every
threshold, every blocked category - to a third-party API. That is precisely the
map `/api/m/<slug>/catalog` deliberately withholds from the public, on the
grounds that publishing it would let an adversary structure underneath it.
Withholding it from everyone and shipping it to a vendor are different
decisions, and the product was making both.

So `src/lib/llm/client.ts` classifies each of the six call sites:

- `public` - `crossSell`, `shopper`. The catalog and a shopper's own sentence,
  both already served unauthenticated. Safe anywhere.
- `internal` - `explain`, `draftPolicy`, `semanticAudit`, `suggestFix`. Policy
  configuration, thresholds, customer ids, full trace params.

Under the default provider, `internal` prompts never leave the machine: with no
local model reachable the call fails rather than falling back, because a
fallback that silently ships the policy set off-box makes the classification
decorative. `LLM_PROVIDER=groq` overrides deliberately and warns once - the
guard is against accidents, not against a configured choice.

Local inference is Ollama through its OpenAI-compatible endpoint, so the
`openai` SDK works unmodified: `messages`, `temperature`, `response_format`
JSON mode, `max_tokens` and `seed` are all supported, which covers every call
made here. Their docs flag that layer as experimental; the native client is the
escape hatch if it drifts.

**Model choice was measured, not read off a benchmark table.** Every call here
has a checkable contract - parse as JSON, satisfy a Zod schema, name a SKU that
exists - so `scripts/bench-llm.ts` runs the real code paths and counts how often
the contract holds.

```
                     Groq gpt-oss-120b     Local granite4 (2.1GB)
crossSell                 15/18                  18/18
shopper                   12/12                  12/12
semanticAudit               2/2                    3/3
  latency                13,352ms                 674ms
draftPolicy                 n/a                    9/9
```

granite4 sits entirely on an 8GB GPU. `qwen3:8b` was tried as the larger
alternative and is worse on every axis on this hardware: 6.0GB spills to CPU,
4x slower, and it found zero issues in the policy audit where granite4 found
one. Bigger was not better; fitting in VRAM was.

One honest caveat the contract suite cannot capture: on the open-ended advisory
task, gpt-oss-120b's *judgment* is still better. It spotted that a 5,000 step-up
against a 20,000 cap puts most of the spending band behind approval; granite4
did not. Local wins on structured extraction and speed, and loses a little on
advice.

**Two prompt bugs were found by measuring, and both looked like model
failures.** Cross-sell offered `"sku": null` as a co-equal option and the model
took it two times in three (33% -> 100% after rewording). `draft_policy` turned
"Block any single order above 25,000" into a `category_block` - on *both*
models, which is the shape of a prompt problem rather than a capability one, and
the culprit was the word "block" sitting beside a rule type in the prompt
(67% -> 100%).

Setup: `winget install Ollama.Ollama`, then `ollama pull granite4`. Ollama adds
a startup entry, so it survives a reboot.

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

### 5c. A transient Supabase error: "JWT issued at future"

Hit twice live: the dashboard's Supabase queries occasionally fail with
`"JWT issued at future"`. Traced (not guessed) to Supabase's newer
`sb_secret_...` API key format: unlike a legacy static JWT, this key type
has an internal gateway mint a fresh JWT per request in front of PostgREST,
and this message means whichever internal Supabase service minted it and
whichever verified it disagreed about the time by even a moment — a
platform-side clock race, not a credentials or app-config problem. Confirmed
by a direct out-of-band probe with the exact same URL/key moments after
hitting it live: clean `200`, real data back. It comes and goes on its own.

**Fix**: `src/lib/dashboardData.ts`'s `withRetry` retries a query up to
twice more (short backoff) specifically when the error text matches this
pattern — any other error still fails immediately, same as before, so a
real problem still surfaces rather than being silently retried away. If
this class of error ever shows up from `src/lib/mcp/traceHelpers.ts` (the
MCP-tool-facing queries) instead of just the dashboard load, the same
`withRetry` pattern is the one to reuse there.

A more permanent fix, if this keeps recurring: Supabase project settings
still expose "Legacy API Keys" for most projects — swapping
`SUPABASE_SERVICE_ROLE_KEY` for the legacy JWT-format service_role key
removes the per-request minting step entirely (a legacy JWT is already
pre-signed, nothing to race against), at the cost of it being the key
format Supabase is gradually deprecating.

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

### Subscriptions/Plans need the same kind of account activation as RazorpayX

Found the same way as the RazorpayX gate above: the first time
`subscription.create` was actually exercised end-to-end (establishing a
mandate in §9d's new demo flow — it was written but never actually called
before that), `rzp.plans.create` returned `{statusCode: 401, error:
"Unauthorized"}`. Confirmed by direct diagnostic that it's not a
credentials problem — the *exact same* key pair succeeds immediately on
`orders.create`. Razorpay gates the Subscriptions/Plans product behind
account activation, test mode included, same category of constraint as
RazorpayX payouts.

**Consequence, matching this project's own established precedent (§6's
"real if the API cooperates, else a clearly-labeled simplified mandate
object," which was written into the plan before this was ever hit):**
`executeRealAction`'s `subscription.create` case now tries the real Plan +
Subscription call first, and only on that specific 401 falls back to a
locally-recorded object (`{plan: null, subscription: {id: "sim_sub_..."},
simulated: true, note: "..."}`) — any other failure still throws normally.
The mandate this produces is still a real row in `mandates`, and the part
that actually matters — a merchant revoking it blocking the agent's very
next action — doesn't depend on whether the subscription underneath it was
genuinely from Razorpay. The demo script's own step detail says outright
when it's the fallback path, not just this document. If Subscriptions
access shows up later, no code changes needed — the real path already
works and simply stops hitting the `catch`.

### A masked-error bug this surfaced: MCP tool errors showing "[object Object]"

The 401 above should have shown up as a clear error. Instead the demo
failed with `Tool enforce_action returned an error: [object Object]` —
genuinely useless for debugging. Root cause: a Supabase `PostgrestError` (and
apparently some Razorpay SDK errors) are plain objects, not `Error`
instances. `throw error` on one is fine for a dashboard server action — the
UI's `catch` blocks already guard with `err instanceof Error ? err.message :
"Action failed."` — but an MCP tool handler's thrown error passes through
the `@modelcontextprotocol/sdk`'s own fallback, `error instanceof Error ?
error.message : String(error)`, and `String()` on a plain object is
literally the text "[object Object]". Fixed at the one place this actually
mattered: every Supabase call inside `src/lib/mcp/traceHelpers.ts` (the
helpers every MCP tool handler goes through) now runs through
`assertNoSupabaseError`, a small `asserts error is null` helper that throws
a real `Error` with the original message preserved, instead of the raw
Postgrest object.

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

## 8. Setup - do this before running anything

1. **Supabase**: create a project at supabase.com. Copy the project URL, the
   publishable/anon key and the service_role/secret key into `.env.local` (copy
   `.env.example` first). Then run every file in `supabase/migrations/` in
   numeric order through the SQL Editor. They are additive and safe to re-run.
   Migration `0010` is the one that makes the instance multi-tenant; nothing
   works without it. *Free-tier projects auto-pause after 7 days idle - open the
   Supabase dashboard once first if it has been sitting.*
2. **Razorpay**: test-mode keys (Dashboard -> Settings -> API Keys) into
   `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`. Everything real here runs on those
   two: orders, refunds and payment links. See section 6 for what is genuinely
   server-to-server and what stops at Razorpay's own customer-facing step.
3. **Clerk**: create an application at clerk.com, copy the publishable and
   secret keys into `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY`.
4. **Local inference** (recommended): `winget install Ollama.Ollama`, then
   `ollama pull granite4`. Ollama adds a startup entry, so it comes back after a
   reboot. Without it, policy-sensitive prompts refuse to run rather than going
   off-box - see section 5a for why that is the default, and set
   `LLM_PROVIDER=groq` with a `GROQ_API_KEY` if you want the hosted path instead.
5. `npm install`, then `npm run dev`, then sign up at `/sign-up`.

Signing up creates your merchant and seeds it with the default policy rules and
catalog, so the dashboard is a working shop with no activity in it. Press
**Start** on the simulation panel to give it a pulse.

**Verifying the install**

```
npx tsx scripts/bench-llm.ts     # the model contract suite, 42/42 on granite4
npx tsx scripts/verify-e2e.ts    # end to end, including tenant isolation
```

Both need the dev server running. `verify-e2e` creates two throwaway merchants
and deletes them afterwards, so it is safe to run against a live instance.

**On a network that intercepts TLS** (corporate or campus proxies), export the
proxy's root certificate and point `MANDATE_CA_CERT` at it in `.env.local`.
`scripts/dev.mjs` picks it up and sets `NODE_EXTRA_CA_CERTS` before starting
Next; without it, every Supabase call fails with an unhelpful
`UNABLE_TO_VERIFY_LEAF_SIGNATURE`.

## 9. Demo script (the "one failure handled gracefully" beat, and closing the Track 01 gap)

`src/lib/demo/runDemo.ts` (the dashboard's "Run demo" button and
`scripts/checkout-agent.ts` are both thin wrappers around this one
implementation), matching Track 1's bar *and* its actual ask — see the note
below on why the catalog/upsell part exists at all.

1. The agent buys a **Wireless Mouse** from a real product catalog (the
   `products` table, migration `0002_products.sql`, seeded by
   `src/lib/demo/catalog.ts`) — a real Razorpay test-mode order.
2. It then asks an LLM (Groq) to reason over the *actual* catalog and propose
   a **cross-sell** — see §9a below. Today that's a Mechanical Keyboard,
   "because customers who buy this mouse usually complete the desk with this
   keyboard." A second real order, flagged distinctly in the UI as an upsell.
   This is deliberate, not decoration: Track 01 asks for "an agent that grows
   revenue," not just an agent that places orders, and the original build had
   nothing that did this.
3. A Laptop Stand purchase, and its own LLM-reasoned upsell (today, a USB-C
   Hub).
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
thin before this pass: the original demo agent placed fixed-amount orders
purely to exercise policy rules, first with a hardcoded `{sku -> sku}`
pairing map for cross-sells, neither of which is real "agentic commerce"
behavior. §9a below is what actually closes that gap.

### 9a. Cross-sell reasoning: right-sized "advanced," not theater

The obvious over-engineered answers here were GraphRAG (built for reasoning
across thousands of unstructured documents — absurd for a 5-item catalog) and
a fifth MCP tool (`recommend_product` or similar — would have diluted
Mandate's actual differentiator, which is "four tools, reused everywhere";
recommendation is the *agent's* reasoning, not the *control plane's* job).
Neither was built, on purpose.

What's actually there (`src/lib/demo/crossSell.ts`): after a purchase, the
agent sends the **real** catalog (from Supabase, not a fixture) plus the
just-bought SKU to Groq, and asks it to pick the one complementary item a
real shopper would plausibly also want, with a one-sentence reason. Two
things make this "grounded" rather than "an LLM call that might hallucinate
a product that doesn't exist":

- The model's chosen SKU is checked against the real candidate list before
  it's used for anything — an invented SKU is treated the same as "no
  suggestion," never trusted.
- A failed or malformed LLM response is never a reason to fail the purchase
  it's attached to — `suggestCrossSell` returns `null` and the demo continues
  with a plain "no complementary item found" step instead of crashing.

**Why this doesn't use vector/embedding retrieval:** at 6 catalog rows, the
entire catalog fits in a single prompt for pennies — a full-context prompt is
exact, not approximate, and cheaper than building a retrieval pipeline for
data that small. That stops being true once a real catalog runs into the
hundreds or thousands of SKUs, at which point embeddings + a vector index
(Supabase supports `pgvector`) become the correct choice, not an upgrade for
its own sake. The `products` table's `description` column exists specifically
so that upgrade path — embed each row, store the vector, do a similarity
search before the LLM call instead of dumping the whole table — doesn't
require a schema change when the catalog outgrows this approach.

**Why the seeded velocity rule is 30/hour, not 5/hour:** it was originally
5/hour, which meant one full "Run demo" click used the entire hourly quota
for that agent — clicking "Run again" (the whole point of making the button
repeatable, e.g. for a live pitch) would then get blocked by the rate limiter
instead of showing the intended escalate/allow/reject outcomes. Bumped to 30
so several repeat runs fit inside an hour. `src/lib/demo/seedData.ts` also
migrates a pre-existing "Max 5 actions/hour per agent" row in place if it
finds one, rather than leaving a stale duplicate active alongside the new one.

### 9b. Policy governance: audit, management, conflict resolution

Requested directly: "the structure is rigid... detect and flag me... let me
play with policies... address the conflicts." Three real gaps, closed:

**The rule set couldn't be edited, only approved.** `PolicyRulesPanel` used to
only handle `pending_review` rules (approve/reject); an already-`active` rule
was permanent. Now every active rule has a **Deactivate** button, and every
deactivated one can be **Reactivate**d — it reuses the existing `superseded`
status rather than adding a new one (`superseded_by` stays `null` for a
manual deactivation, distinguishing it from "replaced by rule X" in the UI).
See `src/lib/actions/policy.ts`.

**Conflicts had no resolution path.** `draft_policy` already computed
`conflictsWith` at draft time, but nothing let you *act* on it later. Now,
approving a `pending_review` rule that shares a type with an existing active
rule shows those conflicting rules with checkboxes — "retire this one when
the new rule activates," left unchecked by default so keeping both is the
explicit choice, not the accidental one.

**Nothing checked the rule set for internal logic errors.** This is the part
that's actually "detect and flag" — `src/lib/policy/audit.ts`, run
automatically on every dashboard load (pure function, no API call, so a poll
every 4s is free), finds things that are *provably true* given how
`engine.ts` resolves priority:

- A step-up rule whose threshold is at or above a per-transaction cap's
  ceiling can **never fire** — the cap blocks first, every time, so the human
  approval path it was meant to create is dead code. Caught this exact bug in
  this project's own seed data while writing the checker (not contrived —
  see the old vs. new step-up/cap numbers in the seed history).
- Two caps in the same currency/scope where the looser one is **unreachable**
  behind the stricter one.
- Duplicate or overlapping category-block rules.
- **No step-up rule configured at all** — nothing routes to a human, every
  action is either allowed or hard-blocked.

A second, separate LLM-driven layer (`src/lib/policy/semanticAudit.ts`, "Run
AI review" button — on-demand, not automatic, because an LLM call on every 4s
poll would be wasteful and slow) looks for softer, judgment-call gaps a
deterministic checker structurally can't make ("no cap on payouts at all,"
"this category list looks incomplete given what's already blocked").
**Deliberately never blended with the deterministic findings** — the UI
labels deterministic issues by real severity (critical/warning/info) and
every LLM-sourced one as "worth reviewing," because they're not the same kind
of claim and presenting them identically would overstate the LLM layer's
certainty.

### 9c. Transactions view, dashboard navigation, and better graph feedback

**"I don't have any idea about all the transactions"** — there was no view of
transaction history beyond what fit in the graph or the escalations panel.
`TransactionsView` (a new "Transactions" tab) lists every trace with
filter-by-decision and a text search, using the same `formatMoney`/
`actionTypeLabel` helpers as everywhere else so amounts and action types read
the same way here as they do in the graph and the toasts.

**The dashboard was becoming one long, dense page.** Adding a transactions
table and real policy management on top of the graph and side panels would
have made that worse, not better. `DashboardTabs` splits it into three real
sections — Overview (graph + "Run demo" + escalations), Transactions, and
Policies (rule management + health audit + draft-a-policy) — instead of
everything stacked into one scroll. The Alerts panel moved out of Overview
entirely, into a header bell (`AlertsBell`) with a dropdown — same
information, "looks too cluttered" was the actual complaint, so it's now out
of the way until someone wants to look, with a count badge so it's not
invisible either. `AlertToasts` (transient, top-right, only for genuinely new
alerts) is unrelated and stayed — it's a different job, a live "this just
happened" nudge, not a persistent list.

**A transaction that got blocked/escalated didn't show which rule did it,
outside the 3D graph.** Clicking a row in `TransactionsView` now expands to
show the full reasoning and, if a rule fired, a chip naming it that jumps to
the Policies tab and highlights that exact rule for a few seconds.

**Rules could be deactivated but not removed**, and issues found by the
policy audit had no path to actually being fixed. Both closed:

- **Delete**, alongside deactivate/reactivate, on every rule — but only
  really permitted for a rule that's never fired: `deletePolicyRule` checks
  `traces.rule_fired_id` first and refuses (with the reason, not a silent
  no-op) if any real transaction depends on it, telling the caller to
  deactivate instead. A rule with real history keeping its ability to explain
  itself matters more than tidiness.
- **"Suggest a fix"** on any flagged issue (`src/lib/policy/suggestFix.ts`) —
  the LLM proposes a concrete parameter change for the specific rule(s)
  involved, shown as a before/after diff with its rationale. Grounded the
  same way as everywhere else the LLM proposes something concrete (crossSell,
  draft_policy): it can only name a rule that's actually in the input, and
  "suggest" never auto-applies — clicking "Apply this fix" is a second,
  separate, explicit action.

**The 3D graph's "blocked" feedback was just a static red ring**, the same
visual weight as every other outcome. Two real fixes in
`src/components/graph/GraphCanvas.tsx`'s `TraceNode`:

- A genuine bug: the fresh-decision pulse animation read the *scene's* shared
  clock, not a per-node one — so a node that appeared a minute into a session
  computed an elapsed time already far past its own animation window and
  rendered pre-faded, never actually pulsing. Fixed by giving each node its
  own local start time, captured on its first frame.
- A `block`/`protocol_reject` decision now gets a second ring — a shockwave
  that bursts outward and fades over ~1 second, distinct from the calm
  allow/escalate pulse, so a blocked action reads as a stop, not just a
  different color. Every node also now scales in from nothing over its first
  ~0.35s instead of popping into existence, which is most of what makes the
  graph read as a live simulation rather than a static picture that
  occasionally redraws.

### 9d. Mandate lifecycle: the product's own namesake, made real

Prompted by a direct question: with time left before the deadline, what
addition is most genuinely on-thesis for Track 01, not just more surface
area? The `mandates` table (`agent_id`, `customer_id`, `type`, `status`)
had existed in the schema since §Data model, and `ENTITY_COLORS.mandate`/
`--entity-mandate` had existed in the graph's color system since the very
first pass — but nothing ever wrote to the table, checked its status, or
rendered it. The single noun this product is named for was the one core
concept that wasn't actually end-to-end. This closes that gap:

- **Creation is real, not simulated.** `subscription.create` already made a
  genuine Razorpay Plan + Subscription call (see §6). Now, whenever that
  call succeeds *and* the request carries a `customerId`,
  `recordMandateFromSubscription` (`src/lib/mcp/traceHelpers.ts`) inserts a
  `mandates` row — `status: "active"`, the real subscription id as
  `razorpay_ref`. No customer attached, no mandate recorded: a subscription
  with nobody to attribute it to isn't a governable mandate.
- **The gate is a separate, more fundamental check than the policy engine,
  not a rule bolted onto it.** `runActionEvaluation`
  (`src/lib/mcp/tools/actionEvaluator.ts`) checks `checkMandateGate(agentId,
  customerId)` *before* `evaluatePolicy` runs at all, for any action that
  carries a `customerId`. A `paused` or `revoked` mandate short-circuits
  straight to `decision: "block"` with a mandate-specific reasoning string —
  the cap/velocity/category_block/step_up rules never even get evaluated.
  That ordering is deliberate: a revoked authorization is a more basic "this
  agent isn't allowed to act right now" fact than any per-transaction spend
  rule, and should win regardless of what those rules would otherwise say.
- **The merchant controls it live, from a real "Mandates" tab.** Pause
  (reversible), Resume (only from paused), and Revoke (deliberately
  terminal — a real UPI Autopay revocation isn't something a merchant
  undoes; the agent would need an entirely fresh mandate) —
  `src/lib/actions/mandates.ts`, mirroring the existing policy-rule
  activate/deactivate action pattern. Every action is a Clerk-gated server
  action, same as policy approval.
- **The graph shows it as a real third entity**, not just agents/rules/
  transactions. Mandate nodes orbit their agent (`computeLayout` in
  `src/components/graph/layout.ts`) with a status-colored ring — active/
  paused/revoked mapped to the same green/amber/red used for decision rings
  everywhere else — and an edge back to the agent that holds it. Hovering
  shows which customer it's for and what pausing/revoking actually does.
- **The demo script proves it, not just implements it.**
  `src/lib/demo/runDemo.ts` now: establishes a real mandate before any
  purchase happens, attributes every purchase to that same demo customer so
  the mandate genuinely governs them, then — after the existing step-up
  escalation beat — revokes the mandate directly (simulating the merchant's
  own dashboard click) and immediately attempts one more purchase under it.
  That purchase is blocked, live, in the same run — proof that revocation
  isn't a status flag nobody checks, demonstrated in <1 second right after
  the escalation beat, before the tampered-request self-defense beat closes
  the script.

### 9e. The "greedy agent" scenario: structuring around a threshold, caught anyway

The escalation beat (§9) proves the step-up rule works when an agent's
honest about a big purchase. It doesn't prove anything about an agent that
*isn't* — the original plan's §7 asked for exactly that second, more
adversarial beat, and it was cut for time (§11) until now.

**The scenario**: instead of one ₹7,200 purchase (which would trip the
₹5,000 step-up threshold and need a human's sign-off), the demo agent
splits it into six rapid ₹1,200 chunks — each individually well under that
threshold, each carrying no signal that would make `evaluatePolicy`'s
`cap`/`category_block`/`step_up` checks blink. What actually catches it is
a new seeded velocity rule ("Rapid-repeat guard: 10 actions / 5 min per
agent," `src/lib/demo/seedData.ts`) — amount-blind by design, it counts
actions, not their size, so splitting one big action into many small ones
doesn't evade it; it's exactly what trips it. `src/lib/demo/runDemo.ts`'s
`attemptStructuredEvasion` fires the chunks one at a time and stops at the
first non-`"allow"` result, which — given the mandate/purchase/upsell beats
already ahead of it in the same run consume most of that rule's headroom —
is typically partway through the burst, not the very first chunk: some
chunks succeed, then one gets blocked, same as a real rate limiter would.

This is also the concrete example of why the policy engine evaluates *all*
active rules of each type, not just one: `daily_spend_limit` (cap) and
`Step-up above ₹5,000` (step_up) don't fire on any individual ₹1,200 chunk,
but a rule of a completely different type — velocity — still catches the
pattern. Gaming one rule doesn't get an agent past the system; the rules
compose.

Four distinct control-plane demonstrations in one click now: an honest
step-up escalation, a dishonest structuring attempt caught by rate-limiting,
a merchant's mandate revocation enforced live, and a forged request
rejected before it reaches any of the above.

### 9h. Live deployment

Pushed to [github.com/amaltomajith/Mandate](https://github.com/amaltomajith/Mandate) and deployed on Vercel
(`https://mandate-amaltomajiths-projects.vercel.app`), Git-linked so every
push to `master` auto-deploys. Supabase is the same project used in local
dev — one database, not a separate prod copy, so `npm run dev` locally and
the deployed instance share live data (a mandate created via one shows up
in the other). Still using Clerk's development-instance keys (the visible
"Development mode" badge and console warning are real, not a bug); a
production Clerk instance is a real next step, not done here, since it
needs its own domain verification. `.vercelignore` excludes the local
PaySim CSV (§10) from *uploads* specifically — it's already gitignored
from commits, but Vercel's CLI still tried to upload it on the first
deploy attempt and hit the platform's 100MB file-size limit.

## 10. Track 02 bonus (built, then removed)

A real, from-scratch fraud-spike detector (logistic regression, trained and
evaluated on PaySim — Kaggle `ealaxi/paysim1`, 6.36M real rows, 8,213 real
fraud labels, 83.6% precision / 45.4% recall at max-F1 on a held-out test
split, full threshold curve reported honestly rather than one cherry-picked
number) was built as a deliberately separate Risk tab for Track 02 bonus
consideration, then removed by request.

The reasoning for removing it: PaySim (mobile-money transfers, with
before/after account-balance fields on both sides of a transfer) and
Mandate's own live traces (Razorpay orders, no equivalent balance fields)
don't share a schema. A follow-up attempt to fold a version of this score
into live PS1 traces (§ history — see git log for
`Fold an illustrative, amount-only risk score into live traces` and its
revert) only worked by mean-imputing 6 of the model's 7 features to zero
contribution, leaving a number that was really just the transaction amount
wearing a "risk score" label — real math, but not a genuine transfer of
PS2's fraud signal into PS1. Once that was clear, keeping the *separate*
Risk tab around stopped being worth the surface area it added, since its
whole value proposition was exactly the connection to PS1 that turned out
not to hold up. Removed rather than left half-relevant.

If a future data source for Mandate's own traffic ever carried genuinely
comparable fields (real balance deltas, not invented ones), rebuilding this
as a properly-connected feature would be a real option — the training
pipeline's approach (real held-out evaluation, full threshold sweep, no
single flattering number) is worth reusing as-is.

## 11. Roadmap / explicitly cut (not built, not stubbed)

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
- **Customer nodes in the graph.** Mandate nodes are real now (§9d); a
  customer is currently just a name looked up for a mandate's tooltip, not
  its own node/edge in the 3D graph. A natural, small next step, not a gap
  in the mandate enforcement itself.
- **True push-based Realtime.** Traded for a 4s poll when auth moved to Clerk
  — see §5b for why that's a deliberate tradeoff, not a shortcut.
- **A real "continuously running regardless of who's watching" scheduler**
  for the simulation panel — it's on-demand (a dashboard
  button) rather than a Vercel Cron job or similar, since this session had
  no deployed instance yet to schedule against. The generation logic itself
  is real and already reusable from a cron route if/when one gets added;
  only the "runs on its own" part is roadmap.
- **Statistical anomaly flagging** (outlier amounts, sudden rate spikes) —
  the honest reason this isn't built yet is that it needs real transaction
  volume to mean anything. The simulation panel now provides
  that volume on demand, but building an anomaly detector against a
  still-small, on-demand-generated history would produce something
  confidently wrong, not "advanced" — the same judgment call as declining to
  use an RNN for policy-conflict detection (§9a's reasoning applies here
  too: right-sized, not decorative). Worth revisiting once real volume has
  actually accumulated, not before.

## 12. Where things live

```
supabase/migrations/          0001 schema+RLS, 0002 products, 0005-0008 rule-type
                              changes and the removal of policy domains,
                              0009 campaigns, 0010 merchants (tenancy)
src/types/db.ts               hand-written Database types
src/lib/merchant.ts           tenant resolution - Clerk for humans, the verified
                              agent for MCP. Nothing takes a merchant id from
                              outside. (section 14)
src/lib/policy/               rule types, pure evaluator, audit.ts (deterministic
                              gap checker), semanticAudit.ts + suggestFix.ts (LLM,
                              internal-only), thresholdSweep.ts (the tuner's replay)
src/lib/trust/score.ts        trust formula, 50-decision window
src/lib/webBotAuth/           keys, canonical signing, sign, verify
src/lib/razorpay/             SDK client and action dispatch - the only place a
                              real money call happens
src/lib/mcp/                  schemas, server (4 tools), session store, trace
                              helpers (getActiveRules / getAggregates / insertTrace,
                              all merchant-scoped)
src/lib/llm/client.ts         provider selection and the egress classification
                              (section 5a)
src/lib/campaigns/            planner, segment, orchestrator, conversion (section 15)
src/lib/orders.ts             the audit trail read back as commerce
src/lib/revenue.ts            revenue impact, derived from decisions that happened
src/lib/actions/              dashboard server actions - escalations, policy,
                              mandates, horizon, simulation, checkout, sellable
src/lib/demo/                 catalog, crossSell (LLM upsells), shopper (intent),
                              seedData, MandateClient, simulation
src/lib/supabase/admin.ts     the only Supabase client - service role
src/proxy.ts                  Clerk middleware
src/app/api/m/[slug]/         the public surface, one merchant per slug:
                              mcp (verify -> session -> transport),
                              catalog (agent-readable storefront),
                              wba-directory (that merchant's public keys)
src/app/dashboard/            merchant UI
src/components/graph/         3D graph + legend (layout.ts is the pure, testable part)
src/components/dashboard/     DashboardTabs and every panel
scripts/                      seed, bench-llm (model contracts), verify-e2e
                              (isolation), regen (paced history), dev.mjs (TLS)
```

## 13. Per-merchant tenancy

Until migration 0010 every table was global: two people signing in with
different Clerk accounts saw the same traces, agents and rules. Fine for one
person on one laptop, wrong for anything anyone else can clone and run.

**The agent is the tenancy bridge.** An MCP request already proves which agent
sent it, by verifying an Ed25519 signature against `agents.public_key`. So the
tenant is resolved from cryptography, not from a field in a request body a
caller could set to someone else's id. No MCP tool takes a merchant parameter,
so no agent can name one.

**`merchant_id` is `NOT NULL` on all ten tables.** That is what turned a
delicate refactor into a mechanical one: every write that would have created an
untenanted row failed to compile, and the compiler enumerated the call sites
instead of anyone guessing at them. Reads are the opposite - an unscoped
`select` compiles perfectly and returns other tenants' rows - so those were
audited by hand, and the dashboard's filter is applied once in
`getDashboardData`, the single place all its reads funnel through.

**The endpoint carries the tenant**: `/api/m/<slug>/{mcp,catalog,wba-directory}`.
That settles two things a global endpoint could not.

- Key lookup is scoped to the addressed merchant, so an agent registered with
  merchant A fails verification against B's endpoint as `unknown_keyid`, before
  any policy runs. There is no window where a cross-tenant request has been
  authenticated but not yet rejected.
- A forged request becomes attributable. Its signature failed, so nothing it
  claims can be trusted - but the URL is not a claim, it is where the request
  was actually sent. Attributing protocol rejects by *claimed* keyid instead
  would let anyone flood a competitor's audit trail by signing garbage with that
  competitor's agent id, the same attack that keeps protocol rejects out of the
  trust score.

**Four holes closed that were not compile errors.** `getAggregates` was
unscoped, so one merchant's traffic would have consumed another's rate budget -
and unlike a display bug, that silently changes whether money moves. `explain`
let any agent read any merchant's decision, including the rule that fired and
its thresholds. The `draft_policy` backtest replayed every tenant's traces. And
every by-id mutation in `policy.ts` and `mandates.ts` treated a row id as
authorization; a uuid being unguessable in practice is not a security boundary.

Uniqueness that was global is now per-merchant: two shops can both stock a
`mouse-01`, two merchants can both name an agent "Checkout Agent".

**New accounts are seeded** with the default rules and catalog on first sign-in.
A merchant with no rules governs nothing and one with no catalog has nothing to
sell, so without seeding "new account" would mean "nothing works" rather than
"no activity yet".

**The pre-tenancy data** went to an unclaimed `demo` merchant. Claiming it needs
`MANDATE_CLAIM_DEMO_MERCHANT=true` set deliberately, then one sign-in - handing
it to whoever signs in first would mean a stranger cloning this repo inherits
the operator's traces, rules and agents.

`scripts/verify-e2e.ts` proves the boundary rather than asserting it: it stands
up two merchants and tries to make each one see or touch the other. Every
isolation check is written so it fails if the scoping is removed, and where a
check could pass trivially - an empty table returns nothing whether filtered or
not - it asserts a control first, so the owner must see the row in the same
instant the outsider does not.

## 14. Campaign orchestrator

Cross-sell is reactive: it waits for a purchase and makes it bigger. Real
revenue, but bounded by traffic the merchant already had. A campaign goes the
other way - pick customers out of the order history, decide an offer, and create
the money action that might bring them back.

Which is also why it belongs in this project rather than beside it. A discount
is money given away. An agent running a campaign is spending the merchant's
money, unattended, across many customers, and every send is exactly the kind of
action Mandate exists to bound. The guardrails needed no new concepts: a `cap`
scoped to `payment_link.create`, a `per_customer` velocity rule, a `step_up` so
a large discount needs a human. Every offer lands in the same audit trail as
everything else.

**Payment links are the right money action** because their outcome is
observable. Creating an order tells you nothing about whether anyone paid; a
link carries a `status` that moves to `paid` and an `amount_paid`, so campaign
revenue is fetched rather than claimed.

**Planning splits the way `draft_policy` does.** The model produces a structured
plan, a human approves it, and everything after is deterministic. "Bought a
stand over a month ago and never bought a hub" is a query, not a judgment -
putting it through a model would make the answer non-reproducible for no gain,
and a campaign that targets a different set every time you look at it is not one
anyone can approve. Every SKU the plan names is grounded against the real
catalog, and a plan naming a phantom product is discarded rather than repaired:
a segment referencing a phantom SKU silently matches nobody, which looks exactly
like a campaign that found no audience.

Prices and discounts are computed from the catalog, never taken from the model.
A model that can state a price can state it wrong.

**Budget is checked before each action, not after** - spending past the budget
and then noticing is not a budget - and committed discount is summed from the
targets rather than stored, the same reasoning as `totalExecuted` in
`revenue.ts`: a stored total is a second source of truth that drifts the first
time an update fails halfway.

Two bugs surfaced while building it, both directly on the campaign path.
`per_customer` velocity had never worked - the scope was in the schema and
`draft_policy` offered it to the model, but `getAggregates` only ever filtered
by agent, so a per-customer rule behaved identically to a per-agent one. That is
*the* guardrail on a campaign. And rules could not be scoped by action type, so
campaign spend could not be bounded separately from order spend.

Not yet built: the dashboard UI, and simulated demand. Without the latter,
conversion reads 0% in test mode because nothing pays a link on its own.

## 15. Resuming in Antigravity

Paste this file plus the relevant `src/lib/...` files for whatever phase
you're extending — this file is written to stand alone as context. The
"Roadmap / explicitly cut" list (§11) is the natural next-phases list if you
want to hand Antigravity a scoped next task instead of the whole thing at once.
