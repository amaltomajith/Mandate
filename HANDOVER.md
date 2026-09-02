# Mandate — Handover

A merchant-owned control plane for money that AI agents move.

Built for the Razorpay AI Buildathon 2026, Track 01 (AI Growth & Agentic
Commerce). Live on Razorpay test-mode APIs.

---

## 1. What this is, and the problem it solves

An AI agent that can spend a merchant's money is useful and dangerous for the
same reason: it acts without asking. The usual answers are both bad. Give the
agent an API key and it can do anything until someone notices. Put a hard
ceiling on it and every order above the line is destroyed rather than reviewed.

Mandate sits between any agent and Razorpay and makes each money action a
decision with a record:

- **Bounded** — caps, rate limits, category rules, reputation floors
- **Gated** — cross a threshold and it escalates to a human instead of firing
- **Explainable** — every allow, block and escalation names the exact rule that
  fired, in plain language, and can be replayed

And because a control plane that only says no is a cost centre, the same engine
carries the growth side: an agent that cross-sells, a campaign orchestrator that
goes and finds revenue, and a threshold tuner that shows a merchant what their
own caution is costing them.

**The one-sentence version:** it is the difference between an agent that *can*
spend your money and an agent that spends it *the way you would*.

### The claim this makes, and its limits

Two things are genuinely true here and worth stating precisely, because the
overclaimed version of each is easy to write and would not survive a question.

**"Transactable by an AI buyer end to end."** True as far as Razorpay's own
design allows. An agent can discover the merchant from a public catalog, verify
who it is talking to, sign a request, get a policy decision, and have a real
Razorpay order or payment link created. It stops at *payment capture*, which is
customer-facing in Razorpay's own product and happens outside any control plane.

**"Grows revenue."** Three mechanisms, and they are not equal.
- **Cross-sell** creates genuinely new revenue: an order that would not have
  happened.
- **The campaign orchestrator** also creates new revenue, from customers who
  were not going to come back on their own.
- **The revenue impact panel** measures *loss avoided against a hard-cap
  baseline* — money a blunt "refuse everything above ₹5,000" rule would have
  destroyed, which escalation preserved. That is real and defensible, but it is
  not new revenue, and calling it that would not survive one follow-up question.
  Name the baseline when you present it.

---

## 2. The lifecycle of one money action

This is the whole system in one path. Everything else is a variation on it.

```
  agent                                                          Razorpay
    |                                                                ^
    | 1. POST /api/m/<slug>/mcp                                      |
    |    Ed25519-signed (RFC 9421-shaped headers)                    |
    v                                                                |
  [ proxy.ts ]  public route, Clerk does not gate it                 |
    |                                                                |
    v                                                                |
  [ route.ts ]  2. verify signature against THIS merchant's keys     |
    |              fail -> protocol_reject trace + 401, no policy    |
    v                                                                |
  [ MCP server ] 3. resolve tenant from the verified agent           |
    |                                                                |
    v                                                                |
  [ actionEvaluator ]                                                |
    |  4. mandate gate    — is this agent still authorized for       |
    |                       this customer? revoked/paused -> block   |
    |  5. policy engine   — pure, DB-free, first match wins          |
    |     category_block > cap > velocity > trust_floor > step_up    |
    |                                                                |
    |  allow    ------------------------------------------------------
    |  escalate -> escalations row, waits for a human
    |  block    -> nothing happens
    |
    v
  6. trace written: decision, rule that fired, reasoning, params,
     razorpay response, merchant, agent, customer, parent trace
    |
    v
  7. trust score recomputed over this agent's last 50 decisions
```

Two things to notice.

**Verification happens before the policy engine exists in the story.** A forged
or tampered request never becomes a policy decision — it is rejected at the
protocol layer and recorded as `protocol_reject`. That is the "one failure
handled gracefully" the brief asks for, and it happens on every sixth simulated
action.

**`simulate_action` runs steps 3–5 and stops.** Same engine, same inputs, same
answer — it just never reaches Razorpay and never counts toward a rate limit.
That is what makes probing free, which the sellable-catalog panel and the
upsell logic both depend on.

---

## 3. Two auth layers, and why they are different

| | Humans | Agents |
|---|---|---|
| Who | the merchant, in a browser | any AI buyer, over HTTP |
| Mechanism | Clerk session | Web Bot Auth (Ed25519, RFC 9421-shaped) |
| Gates | `/dashboard`, all server actions | `/api/m/<slug>/mcp` |
| Identity from | Clerk user id | `keyid` in the signature → `agents.id` |

These are not two implementations of the same thing. A human proves who they
are once and gets a session. An agent proves it on **every single request**, and
the proof covers the method, path, authority and a digest of the body — so a
tampered body fails even with a valid signature attached.

`keyid` **is** the agent id. There is no separate registration step or API key:
an agent's identity is its public key, published in the merchant's directory at
`/api/m/<slug>/wba-directory` so anyone can verify a signature independently
rather than taking this server's word for it.

**What is simplified:** real Web Bot Auth involves a signature agent directory
with key rotation and expiry. Here, keys are registered once and do not rotate.
The signing and verification themselves are real Ed25519 over a canonical
signature base — see `src/lib/webBotAuth/canonical.ts` for exactly which
components are covered.

---

## 4. Data model

Ten tables, all scoped by `merchant_id`, all with RLS enabled.

| Table | What it holds |
|---|---|
| `merchants` | the tenant. `slug` is its public identity, `clerk_user_id` its owner |
| `agents` | name, description, Ed25519 public key, trust score and components |
| `customers` | who an action is on behalf of |
| `products` | the catalog an agent reads and reasons over |
| `policy_rules` | type, params, status (`active` / `pending_review` / `rejected` / `superseded`), source, rationale |
| `traces` | **the audit trail.** Every decision, ever |
| `escalations` | an escalated trace waiting for, or carrying, a human answer |
| `alerts` | what surfaced in the bell and the toasts |
| `mandates` | an agent's standing authorization for a customer |
| `campaigns` / `campaign_targets` | a campaign and every offer it made |

### `traces` is the spine

Everything else in the product is a view over this table. Revenue impact, the
order history, buying analytics, segmentation, the trust score, the 3D graph and
the threshold replay are all derived from traces — none of them keep their own
running totals.

That is deliberate. A stored total is a second source of truth, and it goes
wrong the first time an update fails after the action already happened. A
figure that has silently drifted is worse than no figure, because it will be
trusted. `totalExecuted` in `revenue.ts` and `committedDiscount` in the campaign
orchestrator are both functions over rows for exactly this reason.

A trace carries `parent_trace_id`, which is what makes upsell revenue
attributable: a child action exists only because a parent purchase happened, so
"this order came from that one" is a fact in the data rather than a label.

---

## 5. The policy engine

`src/lib/policy/engine.ts` — pure, no database access, no side effects. Given a
context, a rule list and pre-computed aggregates, it returns a decision. That
purity is what lets `simulate_action` and `enforce_action` be *guaranteed* to
agree, and what lets the threshold tuner replay history through the real engine
rather than a UI re-implementation that could drift from it.

### Five rule types, fixed priority, first match wins

```
category_block  →  cap  →  velocity  →  trust_floor  →  step_up
```

| Type | Measures | Decision |
|---|---|---|
| `category_block` | a named category (`gambling`, `crypto`) | block |
| `cap` | a money ceiling, per transaction or per day | block |
| `velocity` | a count within a time window, per agent or per customer | block |
| `trust_floor` | the agent's reputation | escalate (or block) |
| `step_up` | an amount above which a human decides | escalate |

The ordering is a policy choice, stated once, in one place. Hard blocks and
spend caps are absolute; step-up is the last resort that asks a human rather
than refusing. `trust_floor` sits above `step_up` because "this agent has not
earned the benefit of the doubt" is a stronger reason to involve a human than
"this amount is large" — a distrusted agent should be held at *any* amount, so
its reasoning is the one the merchant should read.

### Rules can be scoped to action types

Optional `action_types` on any rule. Absent means it applies to everything,
which is what every rule written before this existed means, so nothing changed
meaning when it was added. It exists because "₹50,000/day of discounted payment
links, on top of the orders" needs two ceilings about different things.

`getAggregates` mirrors the same scoping. The engine decides *whether* a rule
applies; the aggregate decides *what it counts*, and the two have to agree or a
scoped cap gets measured against traffic it does not govern and fires
immediately.

### Velocity counts only enforce-mode traces

So probing with `simulate_action` costs nothing. This is load-bearing: the
sellable-catalog panel puts every product to the engine on every refresh, and
the upsell logic probes for the best clearing alternative after a refusal.
Neither should consume the agent's rate budget or move money.

---

## 6. Trust

```
score = clamp(0, 100,
    50
  + 30 * (approvals − blocks) / total
  − 10 * (escalations / total)
  + 10 * min(accountAgeDays, 30) / 30
)
```

Computed over the agent's **last 50 decisions**, recomputed on every enforce
action. A short window on purpose: a score that barely moves cannot make
`trust_floor` meaningful, and an all-time average of a busy agent is nearly
immovable.

**The escalation weight is −10, not −30, and that number is load-bearing.**
Found by working the arithmetic backwards: an escalation is not a failure, it is
the system working. But once a `trust_floor` rule starts holding an agent,
*every subsequent decision is an escalation*, so the penalty becomes
self-sustaining. At −20, a held agent settles at exactly 30.0 — permanently
below a floor of 35, with no path back. A one-way trapdoor dressed as a
reputation system. At −10 a well-behaved held agent climbs back out and a
misbehaving one does not.

**`protocol_reject` does not affect trust.** Those traces carry `agent_id: null`
because the signature failed, so there is no verified identity to attribute them
to. Attributing them by the *claimed* keyid would let anyone tank a competitor's
score by signing garbage with that competitor's agent id.

---

## 7. Mandates — the product's namesake

A mandate is an agent's standing authorization to act for a particular customer.
The merchant can pause it (reversible) or revoke it (terminal, like a real UPI
Autopay revocation).

**The gate runs before the policy engine**, not alongside it: a revoked mandate
means "this agent is not authorized at all right now", which should short-circuit
spend rules rather than compete with them.

One deliberate exemption: `subscription.create` is not gated by a mandate,
because it is how a *new* mandate gets established. Without the exemption, a
merchant who revoked an agent could never re-authorize it — caught live, when
reusing the same agent and customer across runs permanently locked out
establishing a new one.

---

## 8. Multi-tenancy

Until migration `0010`, every table was global: two people signing in with
different Clerk accounts saw the same traces, agents and rules. Fine for one
person on one laptop; wrong for anything anyone else can clone and run.

**The agent is the tenancy bridge.** An MCP request already proves which agent
sent it. So the tenant is resolved from cryptography, not from a field in a
request body a caller could set to someone else's id. No MCP tool takes a
merchant parameter, so no agent can name one.

**`merchant_id` is `NOT NULL` on all ten tables.** That turned a delicate
refactor into a mechanical one: every write that would have created an
untenanted row failed to compile, and the compiler enumerated the call sites
instead of anyone guessing at them. Reads are the opposite — an unscoped
`select` compiles perfectly and returns other tenants' rows — so those were
audited by hand, and the dashboard's filter is applied once in
`getDashboardData`, the single place all its reads funnel through.

**The endpoint carries the tenant:** `/api/m/<slug>/{mcp,catalog,wba-directory}`.
That settles two things a global endpoint could not.

- **Key lookup is scoped to the addressed merchant.** An agent registered with
  merchant A fails against B's endpoint as `unknown_keyid`, *before any policy
  runs*. There is no window where a cross-tenant request has been authenticated
  but not yet rejected.
- **A forged request becomes attributable.** Its signature failed, so nothing it
  claims can be trusted — but the URL is not a claim, it is where the request
  was actually sent. Attributing by *claimed* keyid instead would let anyone
  flood a competitor's audit trail.

**Four holes closed that were not compile errors.** `getAggregates` was
unscoped, so one merchant's traffic would have consumed another's rate budget —
and unlike a display bug, that silently changes whether money moves. `explain`
let any agent read any merchant's decision including the rule that fired and its
thresholds. The `draft_policy` backtest replayed every tenant's traces. And
every by-id mutation in `policy.ts` and `mandates.ts` treated a row id as
authorization; a uuid being unguessable in practice is not a security boundary.

**New accounts are seeded** with the default rules and catalog on first sign-in.
A merchant with no rules governs nothing and one with no catalog has nothing to
sell, so without seeding "new account" would mean "nothing works" rather than
"no activity yet".

---

## 9. The LLM layer: local first, classified by what it may send

Originally Gemini, then Groq. Now **local by default**, and the reason is not
cost.

The semantic policy audit was posting every active rule — every cap, threshold
and blocked category — to a third-party API. That is precisely the map
`/api/m/<slug>/catalog` deliberately withholds from the public, on the grounds
that publishing it would let an adversary structure underneath it. Withholding
it from everyone and shipping it to a vendor are different decisions, and the
product was making both.

So `src/lib/llm/client.ts` classifies each of the six call sites:

| Class | Call sites | What it sends |
|---|---|---|
| `public` | `crossSell`, `shopper` | the catalog and a shopper's own sentence — already served unauthenticated |
| `internal` | `explain`, `draftPolicy`, `semanticAudit`, `suggestFix` | policy configuration, thresholds, customer ids, full trace params |

Under the default provider, `internal` prompts **never leave the machine**: with
no local model reachable the call fails rather than falling back, because a
fallback that silently ships the policy set off-box makes the classification
decorative. `LLM_PROVIDER=groq` overrides deliberately and warns once — the
guard is against accidents, not against a configured choice.

Local inference is Ollama through its OpenAI-compatible endpoint, so the
`openai` SDK works unmodified.

### Model choice was measured, not read off a benchmark table

Every LLM call here has a checkable contract — parse as JSON, satisfy a Zod
schema, name a SKU that exists. `scripts/bench-llm.ts` runs the real code paths
and counts how often the contract holds.

```
                     Groq gpt-oss-120b     Local granite4 (2.1GB)
crossSell                 15/18                  18/18
shopper                   12/12                  12/12
semanticAudit               2/2                    3/3
  latency                13,352ms                 674ms
draftPolicy                 n/a                   12/12
```

`qwen3:8b` was tried as the larger alternative and is worse on every axis on 8GB
hardware: 6.0GB spills to CPU, 4× slower, and it found *zero* issues in the
policy audit where granite4 found one. Bigger was not better; fitting in VRAM
was.

**One honest caveat the contract suite cannot capture:** on open-ended advisory
work, gpt-oss-120b's *judgment* is still better. It spotted that a ₹5,000
step-up against a ₹20,000 cap puts most of the spending band behind approval;
granite4 did not. Local wins on structured extraction and speed, and loses a
little on advice.

### Three bugs that looked like model failures and were not

1. **Cross-sell declined two times in three.** The prompt offered `"sku": null`
   as a co-equal option and the model took it. 33% → 100% after rewording.
2. **`draft_policy` turned "Block any single order above ₹25,000" into a
   `category_block`** — on *both* granite4 and gpt-oss-120b. An identical error
   across a 60× size difference is the shape of a prompt problem. The word
   "block" sat beside a rule type in the prompt. 67% → 100%.
3. **`draft_policy` scored 9/9 then 4/6 with no code change.** Raw output showed
   the *type* correct every time, with one draft putting velocity params under
   the `"cap"` key — right decision, wrong container. The reader now locates
   params by validating candidates against the chosen type's schema. 12/12 since.

The lesson is worth carrying: when output is schema-validated, a "model failure"
is usually a prompt failure, and the only way to tell is to look at the raw
output rather than the error message.

---

## 10. Growth

### Cross-sell (`src/lib/demo/crossSell.ts`)

After an allowed purchase, ~30% of the time, the agent asks a model for the best
complement from the *live* catalog and enforces it as a second, real,
policy-gated `order.create` carrying `forkFrom` — so an upsell that breaches a
cap gets refused like anything else, and the revenue is attributable.

Grounded, not trusted: the model's SKU is checked against the real catalog. An
invented SKU returns `null`, and a failed suggestion never fails the purchase it
was attached to.

Measured attach rate after the prompt fix: **~30%**, up from 2%.

### Campaign orchestrator (`src/lib/campaigns/`)

Cross-sell is reactive — it makes orders bigger, bounded by traffic the merchant
already had. A campaign goes the other way: pick customers out of the order
history, decide an offer, create the money action that might bring them back.

Which is exactly why it belongs here. A discount is money given away, and an
agent giving it away unattended across many customers is the thing this system
exists to bound. The guardrails needed no new concepts: a `cap` scoped to
`payment_link.create`, a `per_customer` velocity rule, a `step_up` for large
discounts.

**Payment links are the right money action** because their outcome is
observable. Creating an order tells you nothing about whether anyone paid; a
link carries a `status` that moves to `paid` and an `amount_paid`, so campaign
revenue is *fetched*, not claimed.

**Planning splits the way `draft_policy` does.** The model produces a structured
plan, a human approves it, everything after is deterministic. "Bought a stand
over a month ago and never bought a hub" is a query, not a judgment — putting it
through a model would make the answer non-reproducible for no gain, and a
campaign that targets a different set every time you look at it is not one
anyone can approve. Prices and discounts are computed from the catalog, never
taken from the model: a model that can state a price can state it wrong.

Budget is checked **before** each action — spending past the budget and then
noticing is not a budget.

### Threshold tuner (`src/lib/policy/thresholdSweep.ts`)

A slider over the step-up threshold, backtested against the merchant's own
recent traces through the **real** `evaluatePolicy`, showing the trade: at
₹5,000, N actions needed you; at ₹8,000, fewer would have, and ₹X would have
cleared automatically. Applying it routes through `pending_review`, so a policy
change is still reviewed rather than applied silently.

Blocks are excluded from the sample — a cap or category refusal stays refused at
any step-up threshold, so counting them would overstate what the slider can do.

### Headroom (`src/lib/actions/sellable.ts`)

The catalog answered by the policy engine rather than listed: which products the
agent can sell unaided right now, which need approval, which are refused. It
moves as trust moves and as caps are edited, which is the point — a static price
list cannot tell a merchant that half their range became unsellable because an
agent's trust fell.

---

## 11. Razorpay: what is real

All on test-mode keys (`rzp_test_...`). `executeRealAction` in
`src/lib/razorpay/actions.ts` is the **only** place a money call happens, and it
is called only after the engine returns `allow`.

| Action | Reality |
|---|---|
| `order.create` | real server-to-server. First leg; capture is customer-facing by Razorpay's design |
| `payment_link.create` | real. Returns a live `short_url` and a `status` that can be read back |
| `refund.create` | real, and genuinely end to end — no customer-facing step |
| `subscription.create` | real when the account has Subscriptions activated; otherwise falls back to a clearly-labelled local mandate object |

`payout.create` (RazorpayX) was **removed**, not left stubbed. It needs a
registered business that Razorpay itself gates, so it could never execute on
this account. Keeping unreachable code implied a capability that did not exist.

Verified live: `plink_TWodcxoDdCJ8xq` at ₹1,039 (₹1,299 less 20%), created
through the full path — signed MCP → mandate gate → policy engine → Razorpay —
and read back with its `status`, `amount_paid` and the discount and SKU carried
in its notes.

---

## 12. The dashboard

Five tabs. Everything is derived from traces; nothing keeps its own totals.

**Overview** — the revenue impact scoreboard, a 3D entity graph
(react-three-fiber) where agents, rules, mandates, customers and traces are
nodes and decisions are edges, the escalation queue, and agent trust with its
component breakdown. Plus the simulation panel: Start / Stop / Step, at Calm
(30s), Busy (10s) or Stress (3s). Stress deliberately outruns the 20-per-2-min
velocity limit, so the rate limiter can be *watched* firing rather than
described.

**Buy** — conversational checkout (say what you want in plain language, an agent
buys it through the same governed path), the sellable catalog, the public
storefront URLs, and buying activity: real order history with product, customer,
outcome and reasoning, plus revenue, average order, the share the agent handled
unaided, and cross-sell attach.

**Transactions** — the full audit log, filterable, including simulate-mode
previews and rejected signatures. The investigative view; Buy is the commerce
view.

**Policies** — rule management, a deterministic gap/conflict checker that runs
free on every load, an on-demand LLM review (kept clearly separate, never
blended), the threshold tuner, and Horizon (a regulatory notice → drafted rule →
`pending_review`).

**Mandates** — pause, resume, revoke. Enforced live, not cosmetic.

### The simulation is not a script

An earlier version was an eleven-step scripted demo. It showed the beats
reliably and read as a rehearsal. This picks a scenario by weight — ordinary 72,
high-value 14, banned category 8, forged 6 — and then lets the **real** engine
decide. A high-value tick escalates because it genuinely crosses the threshold,
not because the simulation labelled it an escalation. Retune a rule and the mix
shifts with it.

---

## 13. Setup

1. **Supabase** — create a project. Put the URL, publishable key and
   service-role key in `.env.local` (copy `.env.example`). Run every file in
   `supabase/migrations/` in numeric order through the SQL Editor. They are
   additive and safe to re-run. **`0010` is required** — nothing works without
   it. *Free-tier projects auto-pause after 7 days idle.*
2. **Razorpay** — test-mode keys into `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`.
3. **Clerk** — publishable and secret keys.
4. **Local inference** (recommended) — `winget install Ollama.Ollama`, then
   `ollama pull granite4`. Ollama adds a startup entry, so it survives a reboot.
   Without it, policy-sensitive prompts refuse rather than going off-box; set
   `LLM_PROVIDER=groq` with a `GROQ_API_KEY` if you want the hosted path.
5. `npm install`, `npm run dev`, sign up at `/sign-up`.

Signing up creates your merchant and seeds it with the default rules and
catalog, so the dashboard is a working shop with no activity in it. Press
**Start** on the simulation panel to give it a pulse.

**To claim the pre-tenancy `demo` data** (only relevant on the original
instance): set `MANDATE_CLAIM_DEMO_MERCHANT=true`, sign in once, then remove it.
It is off by default because handing that data to whoever signs in first would
mean a stranger cloning this repo inherits the operator's traces and rules.

**On a TLS-intercepting network** (corporate or campus proxies): export the
proxy's root certificate and point `MANDATE_CA_CERT` at it. `scripts/dev.mjs`
sets `NODE_EXTRA_CA_CERTS` before starting Next. Without it every Supabase call
fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, which names the symptom and not
the cause.

---

## 14. Verifying it works

Both need the dev server running.

```bash
npx tsx scripts/verify-policy.ts  # every rule type, both directions
npx tsx scripts/verify-e2e.ts     # end to end, including tenant isolation
npx tsx scripts/bench-llm.ts      # the model contract suite
```

`verify-policy` installs one rule at a time on a throwaway merchant and drives
it through MCP as an agent would, so what is tested is the whole path -- the
signature, the aggregates fetched from real traces, the rule matched, the
decision recorded -- not an evaluator agreeing with itself. Every case asserts
**both** directions: the rule fires when it should and does not when it should
not. A test that only checks the block is satisfied by an engine that blocks
everything. 14/14:

```
category_block   refuses crypto            · leaves electronics alone
cap              blocks above the ceiling  · allows below it
step_up          escalates above threshold · allows below it
trust_floor      holds a below-floor agent · ignores an above-floor one
velocity         per_agent limit enforced  · per_customer limit enforced
                 per_customer does NOT leak across customers
                 per_customer ignores actions naming no customer
action_types     a links-only cap does not bind an order
priority         category_block beats step_up when both match
```

`verify-e2e` is the important one. **Multi-tenancy that is not tested is not
multi-tenancy** — an unscoped read compiles perfectly and leaks silently, so the
only way to know the boundary holds is to stand on both sides of it and push. It
creates two throwaway merchants with real Ed25519 keypairs and tries to make
each one see or touch the other, then deletes them.

Every isolation check is written so it **fails if the scoping is removed**. A
test that passes against an unscoped database is worse than no test, because it
certifies the bug. Where a check could pass trivially — an empty table returns
nothing whether filtered or not — it asserts a control first, so the owner must
see the row *in the same instant* the outsider does not. That mistake was made
and caught while verifying migration 0009, which is why it is guarded here.

Last run, 15/15:

```
A's agent rejected by B's endpoint       401, before any policy ran
B cannot explain A's trace               refused by the scoped lookup
A's trace visible to A, invisible to B   1 row vs 0, same instant
A's catalog serves only A's products     6 items, no leakage
A's key directory excludes B's agent     1 key
forged request attributed to its target  1 trace, 0 stray on the other tenant
B's rate budget unaffected by A          allowed
each merchant has its own rule rows      A 5, B 5, 0 shared
banned category refused                  category_block fired
payment_link.create                      live link at rzp.io
tenants cascade-delete cleanly           0 orphans
```

`scripts/regen.ts` rebuilds demo history at a pace the engine considers
ordinary. Ten seconds between ticks, deliberately: running flat out blows the
velocity limit, the guardrail fires on everything after, and the trust score
collapses — so the history that comes out is a record of a system being
rate-limited rather than one behaving normally.

---

## 15. Where things live

```
supabase/migrations/     0001 schema+RLS · 0002 products · 0004-0008 rule-type
                         changes and the removal of policy domains ·
                         0009 campaigns · 0010 merchants (tenancy)
src/proxy.ts             Clerk middleware; /api/m/(.*) is public
src/app/api/m/[slug]/    the public surface, one merchant per slug:
                           mcp/            verify → session → transport
                           catalog/        agent-readable storefront
                           wba-directory/  that merchant's public keys
src/app/dashboard/       merchant UI
src/lib/merchant.ts      tenant resolution — Clerk for humans, the verified
                         agent for MCP. Nothing takes a merchant id from outside
src/lib/policy/          engine (pure) · types · audit (deterministic checker) ·
                         semanticAudit + suggestFix (LLM) · thresholdSweep
src/lib/mcp/             schemas · server (4 tools) · sessionStore · traceHelpers
src/lib/mcp/tools/       actionEvaluator (the lifecycle in §2) · explain · draftPolicy
src/lib/webBotAuth/      keys · canonical · sign · verify
src/lib/razorpay/        client + actions (the only real money calls)
src/lib/llm/client.ts    provider selection and egress classification
src/lib/trust/score.ts   the trust formula
src/lib/campaigns/       planner · segment · orchestrator · conversion
src/lib/orders.ts        the audit trail read back as commerce
src/lib/revenue.ts       revenue impact, derived from decisions that happened
src/lib/actions/         dashboard server actions
src/lib/demo/            catalog · crossSell · shopper · seedData ·
                         MandateClient · simulation
src/components/graph/    3D graph; layout.ts is the pure, testable part
src/components/dashboard/ DashboardTabs and every panel
scripts/                 seed · bench-llm · verify-e2e · regen · dev.mjs
```

---

## 16. Known limitations

Stated here rather than discovered by a reviewer.

- **Nothing converts in test mode on its own.** A payment link reaches `paid`
  only if a human opens it and pays with a test card, so campaign conversion
  reads 0%. The reconciler is real; the demand is not there.
- **The campaign orchestrator has no UI.** Planner, orchestrator and reconciler
  are working, tested libraries with no dashboard surface yet.
- **The dashboard reads the most recent 300 actions.** The panels making money
  claims say so. These are not lifetime totals.
- **Web Bot Auth keys do not rotate.** Registered once, no expiry.
- **The catalog is prompt-sized, not retrieval-backed.** Right for six SKUs,
  wrong at thousands — that is where embeddings and a vector index become the
  correct next step, not a nice-to-have.
- **No anomaly detection.** It needs real transaction volume to mean anything,
  and building it against on-demand simulated history would produce something
  that looks like a feature and is not one.
- **`/.well-known/http-message-signatures-directory`** is per-origin and cannot
  carry a slug, so it serves the merchant named by `MANDATE_PUBLIC_MERCHANT`.
  Every merchant also has an unambiguous explicit directory URL.

---

## 17. Decisions worth knowing about

Things that were tried, reversed, or nearly went wrong. A handover that only
lists what works teaches nothing about where the edges are.

**Policy domains were built, then removed** (migrations 0004 → 0008). Rules were
scoped to merchant-defined "domains" matched by keyword. It looked flexible and
was actually a hardcoded string match wearing a nicer coat, and removing it
un-scoped a mandate cap that then refused 13 of 14 ordinary orders — which is
how the trust-floor trapdoor in §6 got found. Rules are global by merchant now,
with optional action-type scoping where a genuine second dimension was needed.

**A scripted demo was replaced by weighted simulation.** See §12.

**Agent registration UI was removed.** `keyid` *is* the agent id, and the
registration flow was returning an id the UI then dropped, producing credentials
that could not work. One agent identity, pinned in env, is the honest shape.

**The trust floor was a one-way trapdoor.** §6. Found by arithmetic, not by
observation — the agent would have looked merely unlucky.

**The revenue panel's escalation limit was 50 with 48 approved.** One more
approval and settled revenue would have started reporting as pending, with
nothing on screen to reveal it. Raised to match the trace window, with a comment
explaining why the two numbers must stay equal.

**Trace params were spread caller-first.** A caller passing
`params: { amount: 1 }` would have had its order judged on the real amount but
*recorded* — and reported in every revenue figure — as one paisa. Authoritative
fields now win.

**The Clerk allowlist named three literal paths.** The routes moved under
`/api/m/<slug>/`; the literals did not. Every public endpoint began redirecting
to a sign-in page an AI buyer cannot complete — the merchant became
undiscoverable while looking perfectly fine to anyone already signed in. Found
by the e2e suite, not by reading the diff.

**`per_customer` velocity never worked.** The scope was in the schema since the
beginning and `draft_policy` offered it to the model as a rule it could
generate, but the count only ever filtered by agent. No active rule used it, so
nothing was wrong in practice — but it is *the* guardrail on a campaign, and it
was the one that silently did nothing.
