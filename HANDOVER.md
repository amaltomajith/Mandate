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
- Merchant dashboard, now four real sections (§9c, §10): Overview (graph + "Run demo" + escalations/alerts), Transactions (every trace, filterable/searchable), Policies (rule management + audit + Horizon), Risk (Track 02 module, kept separate — see below)
- Policy governance (§9b): deactivate/reactivate any rule, conflict-aware approval, a deterministic gap/conflict checker (runs free on every load) plus an on-demand LLM review — labeled and never blended
- 3D graph (react-three-fiber + postprocessing): entity hue, trust aura, decision rings, bloom/starfield/grid, hover inspect, fork/branch edges, an always-visible legend, a distinct block/reject shockwave effect, nodes that materialize in instead of popping (§9c)
- Live alert toasts + a plain-language explainability pass (amounts render as "₹6,000" not raw paise, "order.create" renders as "New purchase order")
- Real product catalog (Supabase `products` table) + LLM-reasoned cross-sell suggestions, grounded against hallucination — see §9a
- Demo agent (dashboard button and CLI script, same implementation) that signs its own requests and runs the full demo scenario
- Seed / key-generation CLI scripts
- **Track 02 bonus module** (§10): a real fraud-spike detector, trained and evaluated on PaySim (Kaggle, 6.36M real rows, 8,213 real fraud labels) — 83.6% precision / 45.4% recall at the max-F1 threshold on a held-out test set, full precision/recall tradeoff curve reported (not one cherry-picked number), false-positive cost under a stated assumption. Deliberately not wired into Mandate's own policy engine — a separate, honestly-evaluated module, not a rebrand of the project.
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
   `.env.example` first). Run **both** `supabase/migrations/0001_init.sql`
   **and** `0002_products.sql` against it via the SQL Editor — `0002` adds the
   `products` table the demo's cross-sell reasoning (§9a) reads from; without
   it, `runDemoScript` fails with a clear "table not found" error, not a
   silent no-op. *Free-tier projects auto-pause after 7 days of inactivity —
   open the dashboard once beforehand if it's been idle.*
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

## 10. Track 02 bonus: a real, honestly-evaluated fraud-spike detector

Prompted by a direct question: does this submission comply with Track 01, and
is it worth also touching Track 02 ("AI Risk Manager" — a working detector
with honest precision/recall on a held-out test set) for bonus consideration?
Two things had to be true before building this at all:

1. **It had to stay a genuinely separate module.** Mandate's whole pitch is
   accountability/governance, not fraud detection — a category Razorpay's own
   Vulcan, Visa's TAP, and Mastercard's Agent Pay already compete in at far
   greater scale (see §3's positioning discipline, which this doesn't
   abandon). This detector is **not wired into the policy engine or
   `enforce_action` in any way.** The dashboard's Risk tab says this
   explicitly, not just this document.
2. **"Honest metrics" had to mean something.** Mandate's own `traces` table
   has no fraud labels and nowhere near enough volume — reporting a
   precision/recall off it would be fabricated. This only got built once a
   real labeled dataset was available (PaySim, Kaggle: `ealaxi/paysim1`).

### What's real

- **The data**: 6,362,621 real rows downloaded via the Kaggle API
  (`scripts/risk/downloadPaysim.ts`), streamed (never held fully in memory —
  it's ~470MB) and filtered to 2,770,409 TRANSFER/CASH_OUT rows
  (`scripts/risk/trainModel.ts`) — the only two types PaySim ever labels as
  fraud, 8,213 of them. Split 80/20 into train/test *before* any sampling, so
  no row can leak across the split.
- **The model**: logistic regression trained from scratch
  (`src/lib/risk/logisticRegression.ts` — no ML library; every coefficient is
  inspectable, consistent with everything else in this project being
  explainable rather than a black box). Seven engineered features
  (`src/lib/risk/features.ts`), the strongest being PaySim's known "error
  balance" signal — a legitimate transfer's ledger has to balance exactly;
  fraud often doesn't.
- **The evaluation**: only ever run on the held-out test split, which the
  model never saw during training.

### The honest part of the story, not just the result

The first real training run (`positiveWeight=25`, a single threshold of 0.5)
produced **4.4% precision, 99.5% recall** — a real, unfabricated number, but
a bad one to report as "the" result: it implies roughly 21 false alarms for
every real fraud caught. Reporting that single number and calling it done
would have technically satisfied "measured precision and recall" while
missing the actual point of the bar ("honest metrics including false-positive
cost"). Instead of picking a different single threshold that looked better,
`trainModel.ts` was reworked to **sweep 10 thresholds** (each test example is
scored once, then evaluated cheaply at every threshold — no retraining
needed) and `positiveWeight` was retuned to 8. The max-F1 operating point
that came out of that — reported alongside the *entire* curve, not
instead of it — is **83.6% precision, 45.4% recall** (726 fraud caught, 142
false alarms, 874 missed, out of 1,600 real fraud cases in the untouched test
set). Both the dashboard's Risk tab and `report.json` show the full
threshold-by-threshold table, not just the recommended row — the tradeoff is
the honest artifact here, not a single flattering number.

False-positive cost is reported too, under an **explicitly labeled
assumption** (₹50/manual review — there's no real operating-cost data
available to this project) rather than presented as measured fact.

### Setup

`npm run risk:download` (needs `KAGGLE_USERNAME`/`KAGGLE_KEY` in
`.env.local`) then `npm run risk:train`. Writes `src/lib/risk/model.json` and
`report.json` — both tiny (under 10KB combined) and committed; the raw CSV
and Kaggle credentials are not (see `.gitignore`). The dashboard's Risk tab
reads `report.json` directly and shows an honest "not trained yet, run these
two commands" state if it's missing — never a fabricated number.

### What this deliberately doesn't do

It does not score Mandate's own live transactions. The model's features
depend on PaySim's mobile-money account-balance fields (before/after balance
on both sides of a transfer) — Razorpay's Orders API doesn't expose anything
equivalent, so applying this model to a live `order.create` trace would mean
inventing input values to feed it, which is exactly the kind of fabrication
this whole module was built to avoid. If a future data source actually
carried comparable balance fields, wiring up live scoring would be a real
next step; faking the inputs to do it today would not be.

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
- **Mandate/customer graph nodes.** Schema-ready (`mandates`, `customers`
  tables), not populated by the demo flow, so the 3D graph renders
  agent/rule/transaction nodes only.
- **True push-based Realtime.** Traded for a 4s poll when auth moved to Clerk
  — see §5b for why that's a deliberate tradeoff, not a shortcut.
- **PaySim-calibrated background traffic generator** (from the original
  plan's §7a): drive realistic transaction *volume* — varied amounts, varied
  simulated identities, an occasional anomaly — through the real MCP path
  continuously, instead of relying only on "Run demo" clicks for history.
  Explicitly deferred this session, not forgotten: real enough to matter
  (trust scores, the policy audit, and a transactions table all get more
  meaningful with volume behind them), but sizable enough (rate-limit-aware
  batching against a real Razorpay account, a calibration step) that bolting
  it on here risked shipping everything else shallower. Natural next step
  after this batch.
- **The "greedy agent" scripted overreach scenario** (from the original
  plan's §7): a demo path where the agent deliberately stacks too much
  discount/spend and gets caught — a second, more adversarial "blocked" beat
  alongside the existing step-up escalation. Same reasoning as above.
- **Statistical anomaly flagging** (outlier amounts, sudden rate spikes) —
  the honest reason this isn't built yet is that it needs real transaction
  volume to mean anything, which is exactly what the traffic generator above
  would provide. Building it against a handful of demo-run transactions would
  produce a detector that's confidently wrong, not "advanced" — the same
  judgment call as declining to use an RNN for policy-conflict detection
  (§9a's reasoning applies here too: right-sized, not decorative).

## 12. Where things live

```
supabase/migrations/0001_init.sql     schema, RLS (now largely vestigial — see §5b)
supabase/migrations/0002_products.sql product catalog (§9a's cross-sell reasoning reads from this)
src/types/db.ts                       hand-written Database types
src/lib/policy/                       rule types + pure evaluator + audit.ts (deterministic gap
                                       checker) + semanticAudit.ts (LLM layer) + suggestFix.ts
                                       (LLM-proposed, human-applied fixes) — see §9b
src/lib/trust/score.ts                trust formula
src/lib/webBotAuth/                   keys, canonical signing, sign, verify
src/lib/razorpay/                     SDK client, RazorpayX REST client, action dispatch
src/lib/mcp/                          schemas, server (4 tools), session store, trace helpers
src/lib/llm/                          Groq client (explain, draft_policy, cross-sell reasoning)
src/lib/actions/                      dashboard server actions (escalations, policy, horizon, demo)
src/lib/demo/                         catalog.ts (products), crossSell.ts (LLM-reasoned upsells,
                                       §9a), seedData.ts, MandateClient, runDemoScript — shared by
                                       the dashboard's "Run demo" button AND the CLI scripts
src/lib/supabase/admin.ts             the only Supabase client left — service role, storage-only
src/proxy.ts                          Clerk middleware
src/app/api/mcp/route.ts              the MCP endpoint (verify → session → transport)
src/app/api/wba-directory/route.ts    public key directory
src/app/login/, src/app/sign-up/      Clerk auth routes
src/app/dashboard/                    merchant UI
src/components/auth/AuthShell.tsx     split-hero shell around Clerk's components (also the onboarding copy)
src/components/brand/MandateMark.tsx  shared logo mark
src/components/graph/                 3D graph + legend (layout.ts is the pure/testable part;
                                       GraphCanvas.tsx has the block-shockwave/materialize-in effects)
src/components/dashboard/             DashboardTabs (Overview/Transactions/Policies), TransactionsView,
                                       PolicyHealthPanel, AlertsBell (header dropdown, not a panel
                                       anymore), panels, buttons, DemoRunner, toasts, live poll refresher
scripts/                              seed, gen-agent-key, checkout-agent — thin CLI wrappers around src/lib/demo/
scripts/risk/                         downloadPaysim.ts, trainModel.ts — Track 02 module, §10
src/lib/risk/                         features.ts, logisticRegression.ts (from-scratch, no ML lib),
                                       loadReport.ts, model.json + report.json (committed, tiny —
                                       the raw CSV and Kaggle creds are not, see .gitignore)
src/components/dashboard/RiskPanel.tsx the Risk tab — real metrics or an honest "not trained yet" state
```

## 13. Resuming in Antigravity

Paste this file plus the relevant `src/lib/...` files for whatever phase
you're extending — this file is written to stand alone as context. The
"Roadmap / explicitly cut" list (§10) is the natural next-phases list if you
want to hand Antigravity a scoped next task instead of the whole thing at once.
