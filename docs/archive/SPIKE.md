# SPIKE — MRTR counter-offers

Question: can Mandate answer a purchase proposal with a policy decision *and* a
counter-offer, using Multi Round-Trip Requests (SEP-2322, revision 2026-07-28)?

Answer: **yes, but it is an SDK replacement, not a feature addition.** Details
below. Nothing has been built.

---

## a) Protocol revisions

**What the server speaks today.** `@modelcontextprotocol/sdk@1.30.0`:

```
LATEST_PROTOCOL_VERSION            2025-11-25
DEFAULT_NEGOTIATED_PROTOCOL_VERSION 2025-03-26
SUPPORTED_PROTOCOL_VERSIONS        2025-11-25, 2025-06-18, 2025-03-26,
                                   2024-11-05, 2024-10-07
```

`2026-07-28` does not appear anywhere in that package. The server is
session-based Streamable HTTP: `src/lib/mcp/sessionStore.ts` holds transports
keyed by a generated `sessionId`, the route reads `mcp-session-id`, and
`MandateClient` performs an `initialize` handshake before any tool call.

## b) Does the installed SDK implement MRTR? **No.**

Searched `@modelcontextprotocol/sdk@1.30.0` for the MRTR vocabulary:

| Symbol | Present in 1.30.0 |
|---|---|
| `InputRequiredResult` | no |
| `inputRequests` | no |
| `inputResponses` | no |
| `requestState` | no |
| `resultType` | no |

**One false positive worth naming, because it would have wasted a day.** The
string `input_required` *does* appear in 1.30.0:

```js
export const TaskStatusSchema = z.enum(['working', 'input_required', 'completed', 'failed', 'cancelled']);
```

That is the **tasks** feature — a pollable async job with `tasks/get` and
`tasks/result`. It is a different mechanism with a different shape and does not
retry the original call. Grepping for `input_required` and declaring MRTR
present would have been wrong.

**What 1.30.0 actually offers instead**, both of which are the older shape the
plan explicitly rules out:

- `elicitation/create` — a *server-initiated request*, needing a held-open
  bidirectional stream. `ElicitRequestFormParamsSchema` and
  `ElicitRequestURLParamsSchema` both exist.
- `UrlElicitationRequiredError` (JSON-RPC error code `-32042`) — returns URL
  elicitations synchronously as an error response, no stream required. Closest
  thing to MRTR in v1, but it is an error, not a result, and carries no
  `requestState`, so there is no continuation.

## c) Client side

**`@ai-sdk/mcp` is not installed and is not used.** The client is
`src/lib/demo/mandateClient.ts` — hand-rolled, doing signed HTTP POSTs directly.

This is the most favourable finding in the spike. There is no third-party client
to wait on or migrate; the retry leg is ours to write.

---

## What is actually available

The blog post announcing the betas is now out of date. The split packages have
shipped **stable**:

```
@modelcontextprotocol/server   2.0.0     (was: server@beta)
@modelcontextprotocol/client   2.0.0     (was: client@beta)
@modelcontextprotocol/core     2.0.0     (transitive)
@modelcontextprotocol/sdk      1.30.0    (v1, frozen — no 2.x)
```

Verified by unpacking `@modelcontextprotocol/server@2.0.0` rather than trusting
the changelog:

```ts
interface InputRequiredResult extends Result {
  resultType: 'input_required';
  /** Embedded requests the client must fulfil before retrying. */
  inputRequests?: InputRequests;
  /** Opaque server state the client echoes back verbatim on retry. */
  requestState?: string;
}
```

Also present: `InputRequiredResultSchema`, `isInputRequiredResult`,
`InputRequiredDriver`, `InputRequiredSpec`, `InputRequiredRoundsExceeded`, and a
`HandlerResultTypeMap` that admits `InputRequiredResult` from `tools/call`,
`prompts/get` and `resources/read`. `ElicitRequestURLParamsSchema` survives, so
**URL mode exists in 2026-07-28** — item 7 of the plan is buildable as written.

`io.modelcontextprotocol/clientCapabilities` exists as a `_meta` key in 2.0.0,
so the plan's per-request capability detection is correct — **for 2.0.0 only.**
In 1.30.0 the only `_meta` key is `io.modelcontextprotocol/related-task`, so
that detection would silently read `undefined` on every call and take the
fallback path forever.

Package deps are compatible: `zod ^4.2.0` against our `^4.4.3`.

**Tasks are wire-only in 2.0.0.** From its own types: *"Task methods are
2025-11-25 wire vocabulary with no SDK runtime… the typed method surface does
not offer them."* So the tasks route is not an alternative here.

---

## What migration costs

This is a rewrite of the transport layer, not an upgrade. `@modelcontextprotocol/sdk`
has no 2.x; the split packages have **no v1 compatibility**.

| Touched | Why |
|---|---|
| `src/lib/mcp/server.ts` | `McpServer` → `createMcpHandler`; different registration API |
| `src/lib/mcp/sessionStore.ts` | **deleted** — 2026-07-28 has no `Mcp-Session-Id` |
| `src/app/api/m/[slug]/mcp/route.ts` | no session lookup, no `DELETE` handler |
| `src/lib/demo/mandateClient.ts` | no `initialize` handshake; adds the retry leg |
| `scripts/verify-e2e.ts`, `verify-policy.ts`, `bench-llm.ts` | all drive `MandateClient` |

**Web Bot Auth is unaffected and, if anything, fits better.** The signature
covers `@method`, `@path`, `@authority` and a content digest of the body. MRTR's
retry is a separate HTTP POST with a different body, so it gets its own
signature naturally — no replay window, and item 9's "replay A's inputResponses
against B" test fails at verification exactly as the plan expects. Dropping
`initialize` removes a round trip that was being signed for no benefit.

---

## Gaps in the plan, in the order they would bite

**1. `requestState` is missing from the plan, and it is the security-critical
part.** The plan describes the retry as "same params plus inputResponses". The
actual mechanism is an opaque blob the server emits and *the client echoes back
verbatim*. That means it arrives as **client-controlled input on POST #2**.

If the counter-offer's SKU and price ride in `requestState`, a buyer agent can
edit them before echoing. The signature does not save you — the agent signs its
own retry legitimately, so the digest covers the *tampered* value. Anything in
`requestState` must be either re-derived server-side or integrity-protected
(HMAC with a server secret) before it is trusted. This is the same class as the
"attribute by claimed keyid" trap already avoided elsewhere in this codebase.

The plan's invariant — re-run the engine on POST #2 — protects against a *stale*
decision. It does not protect against a *forged* counter-offer.

**2. "No re-entry can reach `executeRealAction` twice" needs a stateless
mechanism.** With sessions gone there is nowhere natural to keep a per-purchase
flag. The honest options are an idempotency key derived from the signed request,
or a uniqueness constraint on the trace. Worth deciding before building, because
"add a guard" is not a design.

**3. Trace types.** `traces.decision` is a Postgres enum-ish check constraint
(`allow`/`block`/`escalate`/`protocol_reject`). The four new states in item 4
are not decisions in the same sense — `counter_declined` is an *outcome of an
offer*, not a policy verdict. Recommend they live in a separate column or in
`params.notes`, so `decision` keeps meaning "what the engine said" and every
existing derivation (`revenue.ts`, `orders.ts`, trust) keeps working untouched.
Adding them to `decision` would silently reshape every panel.

**4. Item 5 is right and is the subtlest thing here.** `getAggregates` counts
`mode = 'enforce'` traces with no decision filter, so an `input_required` trace
*would* consume a velocity slot and quietly halve every rate limit. Same for
trust: `computeTrustScore` reads escalations, and a counter-offer is not
misbehaviour. Both need explicit assertions, not comments.

**5. Item 3, deleting the 30% dice, is a clean win** and is independent of all
of this. It could ship today against the current SDK.

---

## Recommendation

**The design is sound and I would build it. The question is whether to build it
now.**

Against: the deadline is 3 days out. This replaces the transport every existing
test drives, on a `2.0.0` release that is days old, to reach a spec revision
finalised on 2026-07-28. If the migration goes sideways on day 2, the fallback
is a savepoint tag and a lost day.

For: `simulate_action` already pre-clears candidates for free, `crossSell`
already grounds SKUs against the catalog, `parent_trace_id` already carries
attribution, and Web Bot Auth already re-verifies every POST. **The invariant
the plan is most worried about — re-run the engine, do not cache — is already
how `enforce_action` behaves.** Most of this is wiring, not new mechanism.

Three ways to take it:

1. **Full MRTR migration.** Highest value, highest risk. Roughly: transport
   swap, then counter-offers, then the nine tests.
2. **Counter-offers on the current SDK, MRTR-shaped.** Return candidates as a
   `suggestions` array on the normal tool result — item 1's fallback path,
   which the plan already requires building. Buyer accepts by calling
   `enforce_action` again with `forkFrom`. No SDK change, no session removal,
   and it is genuinely the same product behaviour minus the protocol niceties.
   Ships in hours, and the MRTR path drops in on top later.
3. **Item 3 only** (delete the dice), and spend the remaining days on the
   orchestrator UI.

My recommendation is **(2) now, (1) after the deadline** — with one caveat I
want on the record: option 2 does not let you say "implements MCP 2026-07-28",
and if that specific claim is what makes the submission stand out, that changes
the calculus and (1) becomes worth the risk.

---

## Separate note: replacing the Buy tab and the simulation

Not part of this spike, flagged because the plan mentions both.

The Buy tab's conversational checkout is the clearest demonstration of "a
merchant transactable by an AI buyer end to end" that exists in the product — a
human types a sentence and a signed, policy-gated purchase happens. Replacing it
with a buyer agent is a strict improvement *if* the agent is visible; replacing
it with something headless would remove the only place a judge can watch the
whole path happen in one screen. Worth keeping the surface even if the driver
behind it changes.

The simulation is what gives the dashboard a pulse and what makes the rate
limiter demonstrable at Stress speed. If a buyer agent replaces it, it needs to
keep generating the same variety — ordinary, high-value, banned category,
forged — or the graph goes quiet and `protocol_reject` stops appearing, which is
the "one failure handled gracefully" evidence the brief asks for.
