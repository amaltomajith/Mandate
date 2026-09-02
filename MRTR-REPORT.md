# MRTR counter-offers — what was done

An account of the work from the counter-offer brief through to the campaign
orchestrator UI, written against the brief's own numbering so it can be checked
rather than taken on trust.

Short version: **the spec is done except item 7, and two of item 4's four trace
types.** Both gaps are explained below rather than buried. Along the way the
MCP transport was replaced, three suites were written, and four real bugs were
found — three of them mine.

---

## Step 0 — the spike, and why it changed the plan

Written before any code, into `SPIKE.md`.

| Question | Answer |
|---|---|
| a) Protocol the server spoke | 2025-11-25, session-based, `Mcp-Session-Id` |
| b) MRTR in the installed SDK | **No.** No `InputRequiredResult`, `inputRequests`, `inputResponses`, `requestState` or `resultType` |
| c) `@ai-sdk/mcp` client | **Not installed and not used** — the client is hand-rolled |

**The false positive worth recording.** `input_required` *does* appear in v1
`@modelcontextprotocol/sdk`:

```js
export const TaskStatusSchema = z.enum(['working', 'input_required', ...]);
```

That is the pollable **tasks** feature — a different mechanism that does not
retry the original call. Grepping for the string and declaring MRTR present
would have been wrong, and would have cost a day before anything failed.

**The path existed, but as a replacement.** The blog post announcing betas was
out of date: `@modelcontextprotocol/server` and `/client` had shipped stable at
`2.0.0`. Verified by unpacking the tarball rather than trusting a changelog —
`InputRequiredResult` present with the documented shape, URL-mode elicitation
present, and `io.modelcontextprotocol/clientCapabilities` present as a `_meta`
key. That last one matters: it does **not** exist in 1.30.0, where the brief's
capability detection would have read `undefined` on every call and taken the
fallback path forever without ever erroring.

**The gap in the brief itself.** `requestState` was not mentioned. It is the
security-critical part: MRTR resumes by having the *client* echo it back
verbatim, so it is client-controlled input on POST #2. The buyer signs its own
retry legitimately, meaning Web Bot Auth's content digest covers whatever the
agent put there. **A signature proves who sent the bytes, not that they are the
bytes the server minted.** The brief's "re-run the engine" invariant protects
against a stale decision, not a forged counter-offer.

---

## The migration

`@modelcontextprotocol/sdk@1.30.0` → `@modelcontextprotocol/server@2.0.0` +
`client@2.0.0`. No compatibility layer; the monolithic package is frozen at v1.

What 2026-07-28 removed was most of what the project had been maintaining. No
`initialize` handshake, no `Mcp-Session-Id` — so `sessionStore.ts` was
**deleted** rather than left unused, the `DELETE` handler went with it, and
every message became a self-contained signed POST served by a fresh instance.

That suited this codebase unusually well: Web Bot Auth already re-verified every
request, so the session machinery was ceremony the security model never used.

**Two wire requirements found by running, not reading.** The server rejected the
first two attempts with precise errors: `Mcp-Method` must mirror the JSON-RPC
method and `Mcp-Name` must mirror `params.name`, and a request whose headers and
body disagree is refused. Neither header is signed and neither needs to be — the
body is covered by `content-digest`, so a tampered header cannot change what
executes, only produce a mismatch the server refuses outright.

The transport was migrated and **verified green before any counter-offer logic
existed** (verify-policy 14/14, verify-e2e 15/15), so a regression there would
be distinguishable from a feature bug later.

---

## The brief, item by item

### 1. Capability detection, per request — done

Read from `ctx.mcpReq.envelope["io.modelcontextprotocol/clientCapabilities"]` on
every call rather than from a session. Elicitation present → counter-offer;
absent → the same pre-cleared candidate attached as `suggestions` on the
ordinary result.

The fallback is the common path, not the exception: most MCP clients today
declare no elicitation. It is tested as a first-class case.

### 2. Model and engine kept separate — done

`src/lib/mcp/counterOffer.ts`. The model picks candidates from the live catalog
and stays in the `public` egress class. The engine decides which clear, by
calling `evaluatePolicy` directly with rules and aggregates the caller already
fetched. No policy data reaches any model, and the egress classification in
`llm/client.ts` was not widened.

Every candidate SKU is grounded against the real catalog, and only candidates
that *currently* clear are offered — proposing something that would be refused
on acceptance wastes a round trip and teaches a buyer that this merchant's
offers cannot be trusted.

A failed or empty counter-offer returns `null` and never fails the parent.

### 3. Delete the 30% dice — done

Gone. It made the attach rate a constant someone chose rather than a
measurement, and made the agent decline good complements at random, which is a
coin rather than judgement.

### 4. New trace types — **two of four**

| Type | Status |
|---|---|
| `input_required` | done — `params.mrtr`, `mode: simulate` |
| `counter_declined` | done — same shape |
| `counter_accepted` | **implicit**: the child is an ordinary trace with `parent_trace_id`, so attribution works, but there is no explicit marker |
| `elicitation_timeout` | **not built** |

On the last one: MRTR has no timeout from the server's side, because the server
never holds a connection. An unanswered offer is simply a POST #2 that never
arrives, and there is nothing to record at the moment it does not happen. This
should have been said when it was found rather than quietly omitted.

**A deliberate deviation.** These live in `params`, not as values of `decision`.
`decision` means what the engine said; `counter_declined` is the outcome of an
offer, not a policy verdict. Adding them to `decision` would have silently
reshaped every panel deriving from it — revenue, orders, trust, the graph. The
markers are stamped **after** the caller's params so a buyer cannot forge one,
which matters most for `offer_id`: a forgeable one would let anyone collide it
deliberately and block someone else's purchase.

### 5. Aggregate and trust correctness — done, by a different route

The brief asked for `input_required` to be excluded from velocity and trust,
with direct assertions. That property is obtained structurally instead: **POST
#1 evaluates the parent in `simulate` mode**, and simulate traces are already
excluded from both.

Two consequences worth stating. There is no filter for a future change to
forget. And "POST #1 executes nothing" stops being a rule anyone has to
remember — there is no code path from the offer branch to `executeRealAction`.

The assertions are still there, on the trace count itself rather than on a
downstream decision that could be right by accident.

### 6. An accepted offer can still be refused — done

The child is a full action evaluated by the same engine on the retry. It can be
blocked or escalated while the parent executes. Tested, and the test had to be
rewritten to reach the path at all — see below.

### 7. URL-mode for payment handoff — **not built**

`ElicitRequestURLParams` was verified present in the 2026-07-28 schema and
recorded in the spike. It was then never implemented. `payment_link.create`
still returns its `short_url` in the ordinary result rather than through a
URL-mode elicitation.

The safety half of the item holds — nothing anywhere requests payment details,
credentials or PII, and no form mode is used for anything sensitive. But the
handoff the brief asked for does not exist.

### 8. Untrusted text — done

The counter-offer reason is stripped of structural characters (`<>{}` backticks,
brackets, backslashes, newlines) and bounded to 160 characters before it reaches
a buyer agent's context. Catalog copy is merchant-editable and the pitch is
model-written, which makes this a path from two soft sources into a third
party's prompt.

### 9. Tests — done, in a different file

All nine cases, plus controls, in `scripts/verify-mrtr.ts` rather than appended
to `verify-e2e.ts`. That was a judgement call: `verify-e2e` is the tenant
isolation suite and this is a different subject. The brief named a file; this
did not follow it.

**17/17.** Two of them passed for the wrong reason on the first run — see below.

---

## The security work the brief did not ask for

`requestState` is sealed with the SDK's own codec:

- **HMAC** with a key from the environment. Not generated per process: a
  per-process key works only while one process serves both posts, and breaks
  *intermittently* once a second instance exists, which is worse than breaking
  outright.
- **Ten-minute TTL**, long enough for a human in the loop and short enough that
  a captured state stops being useful.
- **Bound to the agent** it was offered to, so A's state replayed by B fails
  there as well as at the signature — two independent layers.

Even sealed, the payload is treated as a hint: the offered product is
re-derived from the catalog by SKU, so a stale or chosen price cannot reach a
policy decision. The seal only has to stop substitution.

**The re-entry guard is a uniqueness constraint, not a check** (migration 0011).
Two concurrent retries would both pass a check-then-execute guard. Each offer
mints an `offerId`, the executing trace carries it, and a partial unique index
turns a replay into an insert conflict the database resolves atomically.

---

## Four bugs found by running the code

**Three of these are mine.** Recording them because each is the same failure
mode in a different costume, and that pattern is more useful than the individual
fixes.

### The counter-offer path was used by nothing

Built, tested 17/17, and every one of the four `MandateClient` call sites
constructed without declaring elicitation. The round trip had never fired
outside its own test suite. A capability nobody exercises is indistinguishable
from one that does not work.

Fixed by enabling it in the simulation — which also meant **deleting the
client-side upsell it used to run**. That block asked the model for a
complement, probed the engine itself, and enforced a second order, putting the
merchant's growth logic inside the buyer. A real third-party buying agent would
not carry a merchant's cross-sell reasoning around with it. Under MRTR the
merchant offers and the buyer decides, which is the right way round.

The buyer answers with a rule, not a dice roll — it accepts a complement costing
no more than what it already came for. Putting a probability back on the buyer's
side would have been the same mistake the 30% dice was, wearing the other hat.
First live run:

```
bought USB-C Hub  ₹1,299   offered Keyboard ₹4,499   declined
bought Yoga Mat   ₹1,199   offered Keyboard ₹4,499   declined
bought Keyboard   ₹4,499   offered Mouse      ₹899   ACCEPTED
```

### The campaign orchestrator silently wrote nothing

`campaign_targets` gained a `NOT NULL merchant_id` when the instance became
multi-tenant. The insert predated that and was never updated — and because **the
error was not checked**, it failed silently. Offers went out with live Razorpay
links and left no record of who had received them.

Worse than losing the record: the budget is derived from those rows, so the
campaign would have undercounted what it had already given away and kept
spending. A budget that silently does not bind is worse than no budget.

### A campaign nobody matched could be approved

Found from a screenshot of the running dashboard: a campaign showing `0 offered`
and an untouched budget, sitting in the list looking as though it had failed
rather than as though it had never been possible.

Now refused in the server action, not only in the UI — a disabled button is a
suggestion, the action is the boundary. The count is re-taken at launch rather
than trusted from the preview, because order history moves and what gets
approved has to be what is true now. The message distinguishes "no audience"
from "an audience this instance cannot see", because those are different
problems with different fixes.

### Two tests that passed for the wrong reason

Both are the failure this project keeps meeting: **a test satisfied by the path
never executing.**

*"An accepted offer that breaches a cap is refused while the parent executes"*
passed while producing **no offer at all**. Capping at the parent's price means
every dearer complement fails pre-clearing, so nothing was offered — and "the
child did not clear" is trivially true when there is no child. The path is only
reachable when state moves between the posts.

*"The same offer id can never execute twice"* asserted only that one trace
carried an offer id, which also holds if the replay quietly took some other path
and wrote nothing. It now inspects the replay's own outcome.

A third, in the campaign suite: *"one offer per customer"* would have passed on
zero targets — `0 === 0` — which is how the silent-write bug survived its first
test run.

---

## Where things stand

```
verify-mrtr      17/17   counter-offers, tested against the invariant
verify-campaign  12/12   orchestrator, live Razorpay test mode
verify-policy    14/14   every rule type, both directions
verify-e2e       15/15   tenant isolation
bench-llm        56/56   model contracts, fully local
next build       pass
```

Handover updated: §2 gained the round-trip diagram and the `requestState`
reasoning, §4 the trace-state table, §10 lost the 30% description, and §13, §14,
§16 and §17 gained the new env var, the MRTR suite, four limitations and three
reversals.

**Still open:** item 7 (URL-mode), item 4's two missing trace types, and the
orchestrator UI's untested rendering — the dashboard is behind Clerk sign-in and
was written without being seen.
