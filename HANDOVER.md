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
    |     category_block > catalog_scope > cap > velocity >          |
    |     trust_floor > step_up                                      |
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
That is what makes probing free, which the sellable-catalog panel, the upsell
logic and the counter-offer pre-clearing all depend on.

### 2a. When the merchant answers back: the counter-offer round trip

Under protocol revision 2026-07-28 a tool can return an `input_required` result
instead of a final one, and the client retries the ORIGINAL call with its
answers. Mandate uses it to answer a purchase with a policy decision *and* a
complementary product the buyer may accept or decline.

```
  POST #1   verify -> tenant -> mandate gate -> policy engine
            parent evaluated in SIMULATE mode
            complement found and pre-cleared by the engine
            -> InputRequiredResult + sealed requestState
            NOTHING EXECUTED. No Razorpay call, no velocity slot.

            (buyer decides)

  POST #2   verify AGAIN -> tenant AGAIN -> mandate gate AGAIN
            policy engine AGAIN, on the parent and then the child
            -> execute
```

**Nothing from POST #1 is carried forward and reused.** Trust, velocity, caps
and mandates may all have moved between the two posts, and a cached "it was
allowed a moment ago" is exactly the bypass this shape has to avoid. POST #2
calls the same evaluator a first-time caller would and can legitimately reach a
different answer — `scripts/verify-mrtr.ts` installs a cap *between* the two
posts and asserts the outcome flips from allow to block.

Three properties worth stating precisely, because each is easy to assume and
hard to notice missing:

- **POST #1 cannot execute, structurally.** The parent is evaluated in
  `simulate` mode, so there is no code path from the offer branch to
  `executeRealAction`. It is not a rule anyone has to remember.
- **The offer costs nothing.** A simulate trace is already excluded from
  velocity aggregates and from the trust score, so a counter-offer cannot burn
  a rate slot or move an agent's standing. That property comes from choosing
  the right mode rather than from filters added to `getAggregates` — so there
  is no filter for a later change to forget.
- **An accepted offer is consent, not authorization.** The child is a full
  action evaluated by the same engine. It can be blocked or escalated while the
  parent still executes.

**`requestState` is the sealed continuation, and it is client-controlled
input.** MRTR resumes by having the *client* echo it back verbatim, and the
buyer signs its own retry legitimately — so Web Bot Auth's digest covers
whatever the agent put there. A signature proves who sent the bytes, not that
they are the bytes the server minted. It is therefore HMAC-sealed with a
ten-minute TTL and bound to the agent it was offered to, and even then treated
as a hint: the offered product is re-derived from the catalog by SKU, so a
stale or chosen price cannot reach a policy decision.

**Executing twice is prevented by a uniqueness constraint, not a check.** Two
concurrent retries would both pass a check-then-execute guard. Each offer mints
an `offerId` into its sealed state, the executing trace carries it, and a
partial unique index (migration 0011) turns a replay into an insert conflict.

**Clients that cannot do a round trip are a first-class path, not a hedge.**
Most MCP clients today declare no elicitation capability. Capability is read
from the per-request `_meta` envelope — it travels with every request rather
than being negotiated once, which is what lets a stateless server answer each
one correctly — and a client without it gets the same pre-cleared candidate
attached to the ordinary result as `suggestions`.

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
| `agents` | name, description, Ed25519 public key, trust score and components, `managed`, `catalog_scope`, and `retired` |
| `customers` | who an action is on behalf of |
| `products` | the catalog an agent reads and reasons over. Merchant-managed, `active` retires without deleting |
| `policy_rules` | type, params, status (`active` / `pending_review` / `rejected` / `superseded`), source, rationale |
| `traces` | **the audit trail.** Every decision, ever |
| `escalations` | an escalated trace waiting for, or carrying, a human answer |
| `alerts` | what surfaced in the bell and the toasts |
| `mandates` | an agent's standing authorization for a customer |
| `campaigns` / `campaign_targets` | a campaign and every offer it made |

### `products.active` — retire, do not delete

Traces record a SKU in `params.notes.sku` and **nothing enforces that as a
foreign key**. So deleting a product that has sold would not fail — it would
quietly leave traces pointing at a name that no longer resolves. `active`
retires a product instead: it leaves the public `/catalog`, counter-offer
candidates and campaign planning, while the row stays put so history still
reads correctly. Hard delete is offered only when no trace references the SKU,
and the Delete button only renders in that case, because a button that usually
errors is worse than no button.

"Appears in the audit trail" is deliberately wider than "has sold" — a product
that only ever escalated or was blocked still has history worth keeping. On the
live tenant the Premium Standing Desk has zero units sold and is still
undeletable for exactly that reason.

`fetchCatalog()` is the single place that decides what "for sale" means, so a
retired product leaves three of the four readers at once. The fourth, the
public `/catalog` route, runs its own query and filters the same way — that
duplication is the real risk in this design and is called out in both files,
with `verify-catalog` asserting the route specifically (with a cache-buster,
since it sets `max-age=60` and a naive test would assert the cache).

### Categories are a closed vocabulary

`PRODUCT_CATEGORIES` in `src/lib/demo/catalog.ts`. Not tidiness:
`category_block` rules match the category string **exactly**, so a product
typed `electronic` would walk straight past a rule blocking `electronics` and
nothing would report an error, because both are valid strings. `gambling` and
`crypto` are in the list on purpose — the seeded policy blocks them, and a
merchant needs to be able to create a product in a blocked category to watch
the block fire.

### `agents.retired` — hide the agent, never its history

The same call `products.active` makes, for the same reason. Traces carry
`agent_id`, and deleting an agent row to tidy a roster leaves every trace it
produced pointing at nobody — or, with a cascade, destroys the record of money
that genuinely moved. Retiring hides the agent; the history stays readable.

**Not `agents.status`.** That column exists and is `active | paused`, and it is
the COOPERATIVE channel: an agent polls `/agent-control`, reads it, and a
well-behaved one complies. Nothing is enforced by it. Retirement is enforced —
the key stops verifying, so requests are refused at the protocol layer before
any policy runs, whether the agent cooperates or not. Folding an enforced state
into the cooperative field would leave a merchant reaching for "stop" unable to
tell which of the two they just got, which is the exact conflation the Agents
panel is built to keep apart.

The filtering is **per surface**, and getting that wrong loses the history by a
slower route than deleting it. `getDashboardData` still returns every agent,
because `TransactionsView` builds its agent-name map from that same array —
filter retired agents out upstream and every trace they ever produced starts
rendering "Unknown agent". So: hidden from the roster, the entity graph and the
trust panel (all of which list things that *can act*); kept in Transactions,
orders, revenue and mandates (all of which read *what happened*).

Hard delete stays available only for an agent with zero traces, and the button
only renders in that case. The managed identity is refused outright — deleting
it would leave the simulation with no identity to sign as.

### `agents.managed` — merchant scaffolding vs. a real third party

`managed` is true for exactly one row per merchant: the identity Mandate's own
traffic simulation signs as. It is false for every agent registered through the
dashboard, and a partial unique index (`agents_one_managed_per_merchant`)
enforces the "exactly one" part in the database rather than trusting the code
that writes it.

The distinction matters in three places. The Agents page lists third parties as
the primary roster and puts the managed row under its own heading, because a
traffic generator sitting among them overstates how many parties are actually
integrated. `scripts/mint-sim-identity.ts` will only ever re-key a `managed`
row — re-keying an agent whose private half we have never held would lock a real
third party out of its own identity. And the simulation's identity resolution
refuses to touch anything else.

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

A trace carries `parent_trace_id`, which is what makes upsell and counter-offer
revenue attributable: a child action exists only because a parent purchase
happened, so "this order came from that one" is a fact in the data rather than
a label.

**`decision` means what the engine said, and nothing else.** The counter-offer
states — an offer made, an offer declined — are not policy verdicts and are
deliberately not values of `decision`. Adding them there would have silently
reshaped every panel that derives from it. They live in `params` instead, as
server-stamped fields:

| Field | Meaning |
|---|---|
| `mrtr: "input_required"` | this trace records an offer being made; `mode` is `simulate`, so nothing moved |
| `mrtr: "counter_declined"` | the buyer said no; also `simulate`, because declining an offer is not a money action |
| `offered_sku` | which complement was proposed |
| `offer_id` | the once-only token the re-entry guard is built on |

Those four are stamped **after** the caller's own params, so a buyer agent
cannot forge one by putting it in its own request. That matters most for
`offer_id`: if a caller could set it, a caller could collide it deliberately
and block someone else's purchase.

## 5. The policy engine

`src/lib/policy/engine.ts` — pure, no database access, no side effects. Given a
context, a rule list and pre-computed aggregates, it returns a decision. That
purity is what lets `simulate_action` and `enforce_action` be *guaranteed* to
agree, and what lets the threshold tuner replay history through the real engine
rather than a UI re-implementation that could drift from it.

### Five rule types, fixed priority, first match wins

```
category_block  →  catalog_scope  →  cap  →  velocity  →  trust_floor  →  step_up
```

| Type | Measures | Decision |
|---|---|---|
| `category_block` | a named category (`gambling`, `crypto`) | block |
| `catalog_scope` | the acting agent's assigned catalog, on the agent | block |
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

`catalog_scope` sits **second**, and the reason is about which sentence the
merchant ends up reading. A merchant-wide prohibition is a stronger and more
general fact than one agent's permission boundary: if gambling is blocked for
everyone, *"gambling is blocked"* is the true and useful explanation, whereas
*"this agent is out of scope"* would imply that widening the scope would help —
and it would not. Scope then precedes the money rules because "may not transact
this at all" outranks "how much of it".

### `catalog_scope` — a global rule reading a per-agent fact

The rule carries **no categories of its own**. It is one merchant-wide statement
— *agents are held to their assigned catalog* — and the scope it compares
against lives on `agents.catalog_scope`. That is exactly the shape of
`trust_floor`, which states a threshold while the score lives on the agent.

Putting the categories on the rule instead would mean one rule per agent, which
is per-rule targeting under another name. §17 records that being built and
removed once already.

Three states, kept apart deliberately: `undefined` means the caller had no scope
to give, so the rule is **skipped** (the `draft_policy` backtest replays actions
whose scope at the time is unrecoverable); `null` means explicitly unscoped;
an array means exactly those, and an **empty array means none**. Collapsing
`undefined` into `null` would make a backtest quietly assert every historical
action was in scope. A missing agent row maps to `undefined`, so *"we could not
find this agent"* never becomes *"this agent may buy anything"*.

A scope block **consumes velocity budget and costs trust**, both because
`category_block` is the exact analogue and does both. Making it free would hand
an agent an unmetered enumeration oracle — name SKUs until one sticks — and
would create the only block type in the system that costs nothing, which is the
shape of three separate bugs in §17. Asserted on the counts themselves in
`verify-policy`, not left to inference.

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

### What each mandate has actually authorized

The panel used to list permissions with no evidence any of them had ever been
exercised, which is a strange thing for a control plane to show: the interesting
question about a standing authorization is not that it exists but what has
happened under it. A mandate covering forty actions and one covering none
rendered identically, and they are not remotely the same risk.

`mandateActivity()` derives actions covered, value settled and last used from
traces — matching on agent **and** customer, never stored. `customerId` lives
inside the jsonb params rather than a column, so traces written before it was
persisted are invisible here, which is correct: there is no way to know who they
were for.

### A mandate whose agent is retired

It still reads `active`, because it is — but that agent's key no longer verifies,
so nothing can ever act under it. "Active" alone there is technically true and
practically a lie, so the row says so explicitly. Three of the six mandates on
the working tenant are in exactly that state, left over from the orphaned
simulation identities.

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

### Cross-sell and counter-offers (`src/lib/demo/crossSell.ts`, `src/lib/mcp/counterOffer.ts`)

After an allowed purchase the agent looks for the best complement in the *live*
catalog and enforces it as a second, real, policy-gated action carrying
`forkFrom` — so an upsell that breaches a cap is refused like anything else, and
the revenue is attributable.

Grounded, not trusted: the model's SKU is checked against the real catalog. An
invented SKU yields nothing, and a failed suggestion never fails the purchase it
was attached to.

**There is no probability any more.** A 0.3 dice roll used to decide whether the
agent would even look. That made the attach rate a constant someone chose rather
than a measurement of anything, and it meant the agent declined perfectly good
complements at random — which is a coin, not judgement. With the dice gone the
rate is an outcome of two real things: whether the model finds a complement the
catalog supports, and whether the merchant's own policy would clear it.

**The model and the engine are kept strictly apart**, and this is the boundary
most worth protecting here. The model picks candidates from the catalog and
stays in the `public` egress class. The engine decides which of them clear, by
calling `evaluatePolicy` directly. Caps, thresholds and trust scores are never
sent to any model — a model that knew the step-up threshold could be induced to
propose just underneath it, which is precisely the structuring the rate limiter
exists to catch.

Only candidates that *currently* clear are offered. Proposing something that
would be refused on acceptance wastes a round trip and teaches a buyer agent
that this merchant's offers cannot be trusted.

The pitch text lands in another agent's context, so it is treated as data and
never as instructions: structural characters are stripped and the length is
bounded. Catalog copy is merchant-editable and the pitch is model-written, which
makes it a path from two soft sources into a third party's prompt.

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

### Headroom (`src/lib/actions/sellable.ts`) — per agent

Takes an agent and judges the whole active catalog against **that agent's**
trust, rate budget and catalog scope. The catalog deliberately stays *unscoped*
here, which is the opposite choice from `/catalog`: the merchant wants to see
that a product is refused **and why**, not to have it quietly disappear. An
out-of-scope item renders as a block naming the scope, which is what makes two
agents' views differ visibly rather than merely differ in length.

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

Eight tabs. Everything is derived from traces; nothing keeps its own totals.

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

**Mandates** — pause, resume, revoke, and **what each one has actually
authorized**: actions covered, value settled, last used, derived from traces.
Status counts, active first, terminal rows dimmed so they stop competing with
things anyone can act on. That pausing here is *enforced* — unlike pausing the
agent, which is a request the agent may ignore — is now stated in the interface
rather than only in a code comment, because a merchant reaching for "stop"
during an incident has to know which of the two they just got.

**Catalog** — what the merchant sells, and two columns a shop admin could not
show. Units sold and revenue are derived from the audit trail rather than a
stored counter, same rule every other panel follows. And each active row
carries the policy engine's current verdict on it, reusing the headroom probe
rather than asking a second way — two implementations of "would this clear" is
how they drift, and a catalog disagreeing with the Buy tab about the same
product is worse than one that says nothing. Catalog health is deterministic,
no model, in the same spirit as the policy health checker: an agent has the
JSON and nothing else, so a missing description is not untidy, it is a product
the agent cannot reason about and will pass over.

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
   `supabase/migrations/` in numeric order through the SQL Editor (through
   `0018_agent_retired.sql`). They are
   additive and safe to re-run. **`0010` is required** — nothing works without
   it. *Free-tier projects auto-pause after 7 days idle.*
2. **Razorpay** — test-mode keys into `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`.
3. **Clerk** — publishable and secret keys.
4. **Local inference** (recommended) — `winget install Ollama.Ollama`, then
   `ollama pull granite4`. Ollama adds a startup entry, so it survives a reboot.
   Without it, policy-sensitive prompts refuse rather than going off-box; set
   `LLM_PROVIDER=groq` with a `GROQ_API_KEY` if you want the hosted path.
5. `npm install`, `npm run dev`, sign up at `/sign-up`.
6. Optional, and the most convincing thing to show: the external buyer.
   `npm --prefix buyer install`, then follow `buyer/README.md` to mint a keypair
   and register it. It is a separate package with separate dependencies and no
   access to anything in this one.

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

### Turning per-agent catalog scope on

Neither the column nor the rule does anything on its own, and a deployment can
sit in the state the working tenant was in for a while: every agent unscoped and
no `catalog_scope` rule active, so nothing enforces anything. Two steps:

1. Add an active `catalog_scope` rule for the merchant. It carries no
   parameters — it is the merchant-wide statement that agents are held to their
   assigned catalog.
2. Assign each agent a scope from the Agents page. `null` (the default) is the
   full catalog; an empty selection means **nothing**, which is a different and
   deliberate state.

Leave at least one agent unscoped. It is the control that makes the others'
narrowing legible — without it a narrow catalog is indistinguishable from a
small one.

---

## 14. Verifying it works

Both need the dev server running.

```bash
npx tsx scripts/verify-policy.ts        # every rule type, both directions      24/24
npx tsx scripts/verify-catalog.ts       # catalog, scope, and the headroom claim 20/20
npx tsx scripts/verify-agent-control.ts # cooperative pause vs enforced retire   21/21
npx tsx scripts/verify-mrtr.ts          # counter-offers and the MRTR invariant  17/17
npx tsx scripts/verify-graph-colors.ts  # what a node in the graph may be        8/8
npx tsx scripts/verify-replay.ts        # a captured request, resent             6/6
npx tsx scripts/verify-e2e.ts           # end to end, incl. tenant isolation     see §17
npx tsx scripts/bench-llm.ts            # the model contract suite               56/56
```

Six suites, 96 checks, all green. `verify-e2e` passes its twelve
tenant-isolation checks and then dies on the Razorpay payment-link quota — an
account limit, not a regression; see §17.

**Every scope and retirement check carries a CONTROL**, because the negative
form of each one passes vacuously. "A scoped agent cannot buy office" proves
nothing unless an unscoped agent buys office in the same instant; "a retired
agent cannot transact" proves nothing unless that same agent transacted a moment
earlier. Without the pairing these would keep passing after the feature was
deleted.

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

`verify-mrtr` tests the counter-offer round trip against its invariant rather
than its happy path. The property that makes the feature safe — POST #1 decides
nothing durable, POST #2 re-decides everything — is invisible when it works and
catastrophic when it does not, so the cases are written to fail if it is
removed. A cap is installed *between* the two posts and the outcome must flip; a
sealed state is replayed and the second use must be refused; the offer post must
leave no Razorpay call and no velocity slot spent, asserted on the trace count
itself rather than on a downstream decision that could be right by accident.

Two of its cases passed for the wrong reason on their first run, and both are
worth recording because both are the same failure mode this project keeps
meeting — **a test satisfied by the path never executing.**

"An accepted offer that breaches a cap is refused while the parent executes"
passed while producing *no offer at all*: capping at the parent's price means
every dearer complement fails pre-clearing, so nothing was offered, and "the
child did not clear" is trivially true when there is no child. The path is only
reachable when state moves between the posts.

"The same offer id can never execute twice" asserted only that one trace carried
an offer id — which also holds if the replay quietly took some other path and
wrote nothing. It now inspects the replay's own outcome.

`scripts/regen.ts` rebuilds demo history at a pace the engine considers
ordinary. Ten seconds between ticks, deliberately: running flat out blows the
velocity limit, the guardrail fires on everything after, and the trust score
collapses — so the history that comes out is a record of a system being
rate-limited rather than one behaving normally.

---

### `verify-catalog` — 20 checks

Retiring a product has to reach every reader, and the one most likely to keep
silently working off a stale read is counter-offer candidacy. So that check is
written to fail loudly if it ever stops proving anything: it asserts the SKU
**is** offerable *before* retiring it, which makes "not offered after" a change
rather than a vacuous truth about an empty candidate list.

Also asserts that `/catalog` still withholds policy thresholds after the
change — the filter touched that route, and a catalog that started leaking
`threshold_amount` would hand an adversary the map the rate limiter exists to
deny them.

## 15. The buyer — a real third party

`buyer/` is an autonomous AI buying agent that shops at a Mandate merchant and
is **not part of Mandate**. Everything else in this repo is the merchant's side;
this is the other one.

The distinction is enforced rather than asserted, because an isolation you only
claim is worth nothing:

- **Its own package and `node_modules`**, outside any workspace. Nothing in the
  parent repo builds, bundles or imports it.
- **Zero imports from `src/`.** `buyer/src/transport.ts` is a *copy* of the
  signing and MRTR logic, written against the protocol rather than shared — a
  real third-party buyer would have to write its own, and one that borrowed the
  merchant's would prove nothing.
- **Four environment variables**, none of which is a database or payment
  credential: the MCP URL, an agent id, an Ed25519 private key, and a model key.
  If that process could reach the merchant's database, watching it buy something
  would be theatre.
- **Products and tools discovered over the wire** — the catalog from
  `GET /api/m/<slug>/catalog`, the tool list from `tools/list`.

Verify it with `grep -rE 'from "@/|\.\./\.\./' buyer/src/`, which must return
nothing.

### What it demonstrates that the simulation cannot

The simulation is in-process and holds the merchant's own credentials. It is the
right tool for producing variety — ordinary, high-value, banned-category and
forged traffic, which is where `protocol_reject` evidence comes from — but it
cannot show that an outsider can transact, because it is not one.

The buyer can. It arrives knowing only a URL, discovers the merchant, registers
a public key, signs every request, and gets refused when it should be. Both run
alongside each other; neither replaces the other.

### It has a model on both sides of the conversation

Previously the counterparty answering counter-offers was
`src/lib/demo/mandateClient.ts` driven by `offer.price <= parent.price`. A rule
dressed as an agent is still a rule. The buyer's decisions — what to purchase,
and whether to accept an offer — are made by a hosted model reasoning from a
persona and a budget, and each produces a decision **and** a stated reason that
is logged.

The split of model to task is deliberate and follows the measurements in section
9: the merchant runs a small local model, which measured better at structured
extraction and must not send policy data off-box; the buyer runs a hosted one,
which measured better at open-ended judgement and holds no policy data to leak.
Nothing in `llm/client.ts` changed.

Every SKU the model names is grounded against the fetched catalog. A
hallucinated one is discarded rather than repaired — repairing it would mean
guessing about someone else's money.

### The buyer checks before it commits

`simulate_action` first, `enforce_action` only if it would clear. That is what
simulate exists for from the buyer's side, and it is the behaviour the free
probing in section 5 was built to enable: a refusal found by simulating costs a
round trip, a refusal found by enforcing costs a mark on the agent's trust score.

### The fallback is announced

With no model reachable, the agent still runs: cheapest thing that fits, decline
every offer. That path prints `[fallback, not a decision]`, because a
deterministic rule wearing the agent's voice would be the most misleading thing
the program could output.

### A live run

```
▸ Found a merchant: Demo Storefront
  6 products, prices in INR
  tools offered: simulate_action, enforce_action, explain, draft_policy
  my identity: 1ce21b3d… (Ed25519, published in their key directory)

▸ I want the Premium Standing Desk — ₹6,999
  "I chose the premium standing desk because it greatly improves ergonomics
   and keeps my workspace tidy with a single, high-quality piece."
  checked first: this would clear

▸ They came back with a counter-offer before completing it:
  "Elevate your typing experience… Add Mechanical Keyboard for ₹4,499.00?"

▸ I'll take it.
  "I accept because the ergonomic keyboard complements my standing desk
   and fits my budget."

▸ Bought the Premium Standing Desk. ₹6,999.
  razorpay order order_TX91B9FlV5SumB
▸ They added the Mechanical Keyboard too. ₹4,499.
  budget left: ₹3,502
```

See `buyer/README.md` for keypair generation and registration.


### Several buyers at once

One process is one agent. `--profile <name>` reads `buyer/profiles/<name>.env`
instead of `buyer/.env`, so three can run side by side, each with its own
keypair, agent id, persona, budget and pace:

```bash
npm --prefix buyer run keygen -- --profile ergonomic   # mint, print both halves
# register the PUBLIC half in the dashboard, save the private half in the profile
npm --prefix buyer start -- --profile ergonomic
```

Three ship as `.env.example` files, chosen to diverge rather than to be copies:
`ergonomic` (₹15,000, deliberate, takes sensible complements), `budget`
(₹6,000, never over ₹2,000 an item, declines most offers) and `bulk` (₹60,000,
routine ₹8,000–15,000 orders that cross the step-up line).

Measured after ~40 actions each, trust does diverge: budget 80, bulk 76,
ergonomic 74 — driven by escalations, which are weighted separately from clean
allows. Every trace landed on its own agent id and none on the managed
simulation row.

`--pace` is a local override. `--max-actions` is a ceiling nothing remote can
raise: the merchant's pace and pause are cooperative and this agent honours
them, but a loop spending real money must not need a reachable server to stop.

### An escalation is not a refusal

The buyer used to back off from anything its pre-flight `simulate_action` did
not return as `allow` — including `escalate`. That had two costs. The merchant's
gated path became undemonstrable from outside: no external buyer could ever
produce a pending escalation, so the queue only ever filled from the simulation.
And it modelled precisely the behaviour this whole system argues against — an
agent walking away from a legitimate large purchase because a human would have
to look at it is how over-blocking destroys revenue.

`block` and `protocol_reject` still stop it; committing there is pointless. On
`escalate` it now submits and waits, because the merchant has said a person will
decide. A profile can opt out with `BUYER_AVOIDS_ESCALATION=true` — that is a
persona choice (the frugal buyer has no patience for sign-off), not a safety
setting.

## 16. Where things live

```
supabase/migrations/     0001 schema+RLS · 0002 products · 0004-0008 rule-type
                         changes and the removal of policy domains ·
                         0009 campaigns · 0010 merchants (tenancy) ·
                         0011 offer-id index · 0012 agent control ·
                         0013 replay nonces · 0014 managed agents ·
                         0015 products.active · 0016 agents.catalog_scope ·
                         0017 catalog_scope rule type · 0018 agents.retired
src/lib/actions/products.ts
                         catalog CRUD + derived units/revenue + health checks
src/lib/actions/mandates.ts
                         pause/resume/revoke + derived per-mandate usage
src/components/dashboard/CatalogPanel.tsx
                         the Catalog tab
scripts/mint-sim-identity.ts
                         provisions ONE merchant's simulation keypair. The only
                         place a public key is rewritten, run by a person
buyer/profiles/          one .env per independent buyer; *.env is gitignored,
                         *.env.example is not
src/components/landing/  the public landing page: GradientWaves (ogl shader),
                         SiteNav, CurvedLoop, DecisionFlow
src/proxy.ts             Clerk middleware; / and /api/m/(.*) are public
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
scripts/                 seed · bench-llm · verify-e2e · verify-policy ·
                         verify-catalog · verify-agent-control · verify-replay ·
                         verify-graph-colors · verify-mrtr · verify-campaign ·
                         mint-sim-identity · regen · dev.mjs ·
                         register-buyer
buyer/                   THE OTHER SIDE. A third-party buying agent with its own
                         package.json and node_modules, zero imports from src/:
                           transport.ts  signing + MRTR, copied not shared
                           brain.ts      the model that decides and explains
                           agent.ts      discover, check, buy, answer offers
                           catalog.ts    products over HTTP, never imported
```

---

## 17. Known limitations

Stated here rather than discovered by a reviewer.

- **Nothing converts in test mode on its own.** A payment link reaches `paid`
  only if a human opens it and pays with a test card, so campaign conversion
  reads 0%. The reconciler is real; the demand is not there.
- **The campaign orchestrator has no UI.** Planner, orchestrator and reconciler
  are working, tested libraries with no dashboard surface yet.
- **The Razorpay test account has hit its 30 payment-link ceiling.** Cancelling
  does not free quota — verified. `payment_link.create` fails with HTTP 429 for
  the life of this key, which takes out campaigns and the payment-link leg of
  `verify-e2e`. `order.create` is unaffected. A fresh test account restores it.
- **Headroom used to be identical for every agent, and the claim was false.**
  `getSellableCatalog()` took no agent and probed as the merchant's own identity,
  so opening it for a high-trust and a low-trust agent showed the same answer.
  Fixed: it takes an agent, and `verify-catalog` asserts the claim directly
  rather than describing it — 4 of 6 products differ between a scoped and an
  unscoped agent, with a control confirming both still see every product so the
  difference is in the verdicts and not in things vanishing. What varies is
  `catalog_scope`; `trust_floor` still would not vary it on its own, since it is
  set to 35 while every live agent scores 50–80.
- **The per-agent probe cannot go over the wire, and that is the point.**
  Signing as an agent needs that agent's private key, and a third party's key is
  never generated, stored or reachable here. So headroom calls `evaluatePolicy`
  in process — same pure engine, same rules, same aggregates, same per-agent
  trust and scope, exactly the precedent `counterOffer.ts` sets. The mandate gate
  is the only thing the wire path adds and it runs only when an action names a
  customer; these probes name none. If this ever *could* sign on another agent's
  behalf, the isolation `buyer/` demonstrates would be a claim rather than a
  fact.
- **A scope block consumes velocity budget and costs trust — decided, not
  defaulted.** `category_block` is the exact analogue and does both. Making
  scope free would hand an agent an unmetered enumeration oracle (name SKUs
  until one sticks) and create the only block type in the system that costs
  nothing. The "boundary it cannot see" objection does not survive Phase 3: a
  scoped agent's `/catalog` shows exactly what it may buy. Asserted on the trace
  count and the trust score themselves.
- **`catalog_scope` sits second, above the money rules.** A merchant-wide
  prohibition is a stronger and more general fact than one agent's boundary — if
  gambling is blocked for everyone, saying "this agent is out of scope" would
  imply widening the scope would help, and it would not.
- **`null` and `[]` on `catalog_scope` are opposites that look identical.** Full
  catalog versus nothing at all, both rendering as "no categories listed". Every
  surface that shows a scope states which one is in force in words; anything
  added later has to do the same.
- **`ed.verifyAsync` throws on malformed input** rather than returning false — a
  signature that is not 64 bytes raises. Unwrapped, that turned a bad signature
  into a 500 from an endpoint whose whole job is refusing them cleanly. Now
  wrapped in `verify.ts`, so every reachable failure returns a reason. Found by
  adding a third caller; it had been latent on `/mcp` and `/agent-control`.
- **Retirement was opt-in, so one surface forgot.** `getDashboardData` returned
  a single `agents` array containing retired rows, and every consumer had to
  remember to filter. The graph, the roster and the trust panel did; the header
  count did not, so the same page reported six agents above a roster of four.
  Section 8 records four cross-tenant holes of exactly this shape: an unscoped
  read compiles fine and returns rows it should not. Fixed by inverting the
  default rather than by adding a fifth filter — `agents` is now live-only, and
  a surface that genuinely needs retired rows asks for `allAgents` by name.
  Forgetting now gives you the safe answer. Exactly two callers ask for the full
  list, and both read history rather than list actors: Transactions resolves
  trace names from it, Mandates resolves the agent behind an old authorization.
- **A stale dev server will show you the old bug for as long as you let it.**
  The graph's own read had already been corrected, but the running server
  predated that edit by forty-four minutes. This is the second time in this
  project that a confusing symptom turned out to be a server older than the fix
  — the first was API routes returning 404 for routes that existed. Restart
  before concluding anything about the dashboard.
- **A feature can be finished, tested, and switched off.** Per-agent catalog
  scope was built across five phases and verified by 24 policy checks and 20
  catalog checks — and on the working tenant it was doing nothing at all.
  Replaying the headroom derivation against live data gave *one* distinct view
  across four agents, because every agent was unscoped **and** no
  `catalog_scope` rule was active. Nothing was enforcing anything. The tests
  create their own rules and their own scoped agents, which is what makes them
  reliable and is exactly why they could not notice. A green suite says the
  mechanism works; it says nothing about whether the deployment uses it. The
  live tenant now runs three distinct views across four agents, with the bulk
  buyer left deliberately unscoped as the control that makes the others'
  narrowing visible.
- **Two panel bugs that types could not catch, found by replaying the
  derivations against live data.** Editing a product's *category* changes which
  agents may buy it, but the Catalog tab refreshed products and health without
  refreshing scopes — the row kept describing the category the product used to
  be in until a full reload. And the verdict column read `agents: allow`, plural
  and unattributed, while probing as exactly **one** agent: harmless before
  per-agent scope existed, actively wrong afterwards, since a product scoped
  away from every third-party buyer would still have shown "allow". It names
  whose verdict it is now. Both compiled, linted and passed every suite.
- **The dashboard has never been verified visually from here.** It is Clerk-
  gated and this environment holds no session, so every claim about it rests on
  replaying what each panel derives against live data — 799 traces all resolving
  to a name, every category one the engine can match, per-product sales
  reconciling — plus types, lint, build and the suites. That is a real gap, not
  a formality: both bugs above were *invisible* to all of those and only showed
  up in the replay. Look at it before recording.
- **The two `Checkout Agent (HH:MM:SS)` rows are the visible residue of that
  bug, and they are retired rather than deleted.** 119 traces between them, all
  real signed history from when the simulation was minting a new identity per
  restart. Deleting the rows to tidy the roster would have rewritten the audit
  trail — the same call the product delete guard makes, for the same reason.
  They are hidden from the roster and the graph, their keys no longer verify,
  and their past actions still resolve to their own names in Transactions.
  Verified on the live tenant: 185 orders and ₹3,39,320.15 identical before and
  after, and the graph drawing four agent nodes instead of six.
- **A stale `SIM_AGENT_ID` used to be invisible.** The env pin names one agent
  id, which belongs to one merchant, and the lookup filters on `merchant_id`. On
  any other tenant it missed — and the old fallback registered a brand new agent
  with an `(HH:MM:SS)` suffix rather than failing, so one identity silently
  became one per server process. Three "Checkout Agent" rows on one tenant were
  three restarts. The suffix was the load-bearing mistake: it made a name
  collision survivable instead of fatal, so the duplication never surfaced. The
  fallback now refuses and names the provisioning script; the unique index makes
  a second managed row impossible.
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
- **Counter-offers need a client that declares elicitation.** Most MCP clients
  today do not, and those take the `suggestions` path instead. That is a real
  product behaviour rather than a degraded one, but it does mean the round trip
  is exercised mainly by this repo's own agent and test suite.
- **A counter-offer depends on the parent action naming a SKU.** It is read from
  `params.notes.sku`, written at purchase time. There is deliberately no
  inference from the amount — the order history refuses to guess a product from
  a price for the same reason, and a counter-offer built on a guess would be
  worse.
- **The buyer needs a hosted model key.** Without one it still runs, but on a
  deterministic fallback that is clearly labelled as such rather than passed off
  as judgement.
- **The buyer is registered by a script**, not by a self-service flow. That is
  the correct shape — an agent cannot register itself — but a real merchant
  would need an onboarding surface for it.
- **The MCP v2 SDK is days old at the time of writing.** It is the stable line,
  not a beta, but this project is an early adopter of it and of protocol
  revision 2026-07-28.

---

## 18. Decisions worth knowing about

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

**The MCP transport was replaced, not upgraded.** v1
`@modelcontextprotocol/sdk` topped out at protocol 2025-11-25 and had no MRTR;
v2 ships as split `server`/`client` packages with no compatibility layer. The
spike that established this is in SPIKE.md, including the false positive that
would have cost a day: `input_required` *does* appear in v1, as a `TaskStatus`
enum member belonging to the unrelated tasks feature.

**Sessions were deleted rather than left unused.** 2026-07-28 has no
`initialize` handshake and no `Mcp-Session-Id`. That suited this project
unusually well — Web Bot Auth already re-verified every single request, so the
session machinery was ceremony the security model never used.

**`requestState` was missing from the original design and is the
security-critical part.** The plan described the retry as "the same params plus
`inputResponses`". The actual mechanism is an opaque blob the *client* echoes
back, which makes it client-controlled input on POST #2. The "re-run the engine"
invariant protects against a stale decision, not a forged counter-offer. See
section 2a for what closes it.

**`per_customer` velocity never worked.** The scope was in the schema since the
beginning and `draft_policy` offered it to the model as a rule it could
generate, but the count only ever filtered by agent. No active rule used it, so
nothing was wrong in practice — but it is *the* guardrail on a campaign, and it
was the one that silently did nothing.

---

## 19. The graph and the analytics layer

Two rounds of work sit on top of everything above: the dashboard learned to
show quantities over time, and the 3D scene was rebuilt to read as a designed
system rather than a pile of glowing shapes. Both produced findings worth
keeping, because in each case the thing that looked broken was not the thing
that was broken.

### Charts are hand-rolled, and every label is HTML

There is no charting library. `StackedAreaChart` and `AnimatedLineChart` are
plain SVG, matching the house style already set by `GradientWaves`. Two bugs in
them are worth knowing about, because both are easy to reintroduce:

**Series order is load-bearing.** In a stacked area chart each series' stroke
traces the cumulative total of everything beneath it. Drawing `refused` last
put its line at the top of the stack, so a large `approvedThroughGate` bucket
rendered as a huge *refusal* — the chart said the opposite of the truth.
Refusals are drawn first, at the bottom, deliberately.

**No SVG `<text>` survives a stretched viewBox.** These charts use
`preserveAspectRatio="none"` with `width="100%"`, which stretches everything
horizontally. Shape strokes are protected with `vectorEffect="non-scaling-
stroke"`; plain `<text>` has no equivalent and its glyphs come out visibly
widened. Every label — axis, dates, threshold, clip markers — is therefore an
HTML element in an absolutely-positioned overlay, outside the transform. Adding
one `<text>` back reintroduces the bug.

A single outlier used to flatten every other bucket, so the stacked chart caps
render height at the 90th percentile and marks the clipped bucket with its real
figure. The cap is visual only: the underlying data and the tooltip always read
the true value.

### The agent node: three wrong models before the right one

The agent node is a thin billboarded ring with a small, rippling core, and
getting there took three attempts that each failed for an instructive reason.

**A lit sphere cannot be a glow.** Two versions built the core as a shaded,
noise-displaced sphere. On screen it rendered as a flat, hard-edged opaque
polygon, because a solid mesh ends at its silhouette. The reference has no
silhouette at all. The core is now a signed-distance field on a billboarded
quad, additive over black, so it fades into the dark instead of stopping.

**Saturated colour cannot be brightened past its strongest channel.** Driving a
colour far above 1.0 pins one channel and the others catch up, sliding the hue
to cyan and then to flat white. Body brightness sits near 1.0 on purpose;
bloom's threshold is 0.22, so it still glows without losing its hue.

**Magenta + cyan is pink, not white.** Three converts both from sRGB into a
linear working space where neither carries much green, so their sum is pink.
The white centre is an explicit neutral term, not an accident of addition.

**R3F does not give a material the uniforms object you pass it.** This one cost
the most. `useFrame` was faithfully mutating the object handed to
`<shaderMaterial uniforms={...}>` while the material held a separate copy — so
the node sat frozen with every line of code looking correct. Animated uniforms
must be written through a ref to the material. `AgentBlobMaterial` and
`PulseEdges` both do this, and the comment there explains why.

**Verify shaders through a real R3F Canvas.** A hand-rolled three.js harness
cannot catch a bug in how the component drives its uniforms, because the
harness drives them itself. It also lied about colour and brightness until it
was rebuilt to use the project's own three and `postprocessing` builds with the
app's bloom parameters and ACES tone mapping. Both remaining defects — the
frozen uniform and an alpha bug that stamped a black square over the starfield
behind every agent — were found by bundling the real component into a real
Canvas and reading the live scene graph.

### Colour is a hierarchy, not a set of labels

The scene is cool and quiet by default; warmth and brightness are reserved for
what wants a human. Structure recedes, identity anchors, exceptions pop. Two
real bugs fell out of stating that rule:

- **Rules wore a status colour.** `rule` was byte-identical to `escalate`, and
  since rule edges are coloured by the decision that fired them, amber
  escalation edges terminated in amber rule nodes and fused into one gold mass.
  Rules are structure, not status — they are cool steel now, and amber means
  exactly one thing.
- **Mandate status borrowed decision colours**, so an active mandate's ring was
  the exact green of an allowed action's, and changing one silently moved the
  other. It has its own values in `colors.ts`.

`tracePresence` sits beside `traceColor` so colour and weight are answered in
one place. Weight is inverted against frequency on purpose: allows are most of
the traffic, and giving each a full-strength ring made the least eventful thing
the loudest on screen.

### Node positions must not depend on a live value

`computeLayout` assigned each agent's angle from its index in the `agents`
array — which `dashboardData` orders by `trust_score`. Trust moves on nearly
every decision, so two agents a point apart swapping rank swapped their
positions on the ring at the next poll, and the graph appeared to drift. Angles
now come from a separately stable ordering. Anything positional must key off
something that does not move.

---

## 20. Wiping and regenerating a tenant

Occasionally the working tenant's history needs to be cleared without losing
its agents, rules, catalog or mandates. The order matters and the scoping
matters more.

**Back up first — code savepoints do not cover the database.** Export
`traces`, `escalations`, `alerts`, `campaigns` and `campaign_targets` for the
merchant before deleting anything, paginating the read (Supabase returns 1000
rows by default, and this tenant alone exceeds that) and cross-checking the
exported count against the server's own count so a silent truncation can never
pass for a complete backup. Write it outside the repo.

**Delete children before parents**, every statement scoped by `merchant_id`:
escalations → alerts → campaign_targets → campaigns → traces. This database
holds more than one merchant; an unscoped delete would take the other one with
it.

Two things that surprise people afterwards:

- **`agents.trust_score` is a stored column, not a derived one.** Wiping traces
  does not move it. It goes stale until the next decision triggers
  `recomputeTrust`, which recalculates from the window rather than incrementing
   — so it self-heals on the first new action and needs no manual correction.
- **A retired product cannot regain sales.** `fetchCatalog` filters
  `active = true`, and that is the only discovery path an agent has. Once its
  history is wiped, a retired product becomes deletable again and stays that
  way, because nothing can buy it. The `deleteProduct` guard fires on traces
  referencing the SKU, and there are none.

`scripts/regen.ts` paces itself at 10s per tick for a reason documented in its
own header. In practice a tick costs ~26s once the simulation's own work is
counted, so size the run by wall-clock time rather than by tick count.
