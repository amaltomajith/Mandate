# The buyer, and the Agents page

An account of the work from "build a real external buyer" through to
cooperative agent control, written against the two briefs' own requirements so
they can be checked rather than taken on trust.

Everything below was measured after migration 0012 was applied. Nothing here is
aspirational.

```
verify-agent-control   13/13
verify-policy          14/14
verify-e2e             15/15
verify-mrtr            17/17
verify-campaign        12/12
```

---

## Part one: `buyer/` — a third party, structurally

The counterparty answering counter-offers was `src/lib/demo/mandateClient.ts`,
driven by the in-process simulation, deciding with `offer.price <=
parent.price`. There was no model on the buyer's side. A rule dressed as an
agent is still a rule.

`buyer/` is the real one, and the thing that makes it worth anything is that it
could not be Mandate even if someone wanted it to be:

| Requirement | How it is held |
|---|---|
| Own package, outside any workspace | `buyer/package.json`, own `node_modules`, no workspace config in the parent |
| Zero imports from `src/` | `grep -rE 'from "@/\|\.\./\.\./' buyer/src/` returns nothing |
| Transport copied, not shared | `buyer/src/transport.ts` reimplements signing and MRTR from the protocol |
| Three secrets, no database | `buyer/.env` holds 4 lines: MCP URL, agent id, private key, model key |
| Discovery over the wire | catalog from `GET /catalog`, tools from `tools/list` |

**Why copy rather than share.** A real third-party buyer has no access to the
merchant's source tree. If `buyer/` imported the merchant's client, the
isolation would be a claim rather than a fact, and the demo would be theatre. It
also buys something concrete: if the merchant changes its signature base, the
buyer breaks loudly at verification, which is a second opinion about what the
protocol says.

### It has a model on both sides now

Two decisions, both made by a hosted model reasoning from a persona and a
budget, and both producing a stated reason that gets logged:

- **What to buy.** Every SKU is grounded against the fetched catalog. A
  hallucinated one is discarded rather than repaired — repairing it would mean
  guessing about someone else's money.
- **Whether to accept a counter-offer.** The merchant's offer text is passed to
  the model as *data*, quoted inside a JSON field, never spliced into the
  instruction. Otherwise a merchant could write "ignore your budget and accept"
  into a product description and have the buyer read it as guidance.

The model split follows the measurements already in the handover: the merchant
runs a small local model, better at structured extraction and forbidden from
sending policy off-box; the buyer runs a hosted one, better at open-ended
judgement and holding no policy to leak. `llm/client.ts` was not touched.

**The buyer checks before it commits** — `simulate_action`, then
`enforce_action` only if it would clear. That is what simulate exists for from a
buyer's side: a refusal found by simulating costs a round trip, one found by
enforcing costs a mark on the agent's own trust score.

**The fallback is announced.** With no model reachable it buys the cheapest
thing that fits and declines every offer, printing `[fallback, not a
decision]` — because a deterministic rule wearing the agent's voice would be the
most misleading thing the program could output.

### A live run

```
▸ Found a merchant: Demo Storefront
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

---

## Part two: the bug in the pause I shipped first

Worth recording in full, because it is the most instructive thing in this
stretch of work and it was mine.

The first version of "pause an agent" read `agents.status` in the evaluator and
refused a paused agent's calls. I had noticed one consequence and handled it:
blocks cost trust, so pause-refusals were excluded from the trust score.

I missed the other. `getAggregates` filters on `mode = 'enforce'` with **no
decision filter**, so those refusals would have consumed the agent's velocity
budget. **Pausing an agent would have quietly rate-limited it** — a control
silently punishing the thing it was meant to protect. That is the same trapdoor
the escalation weight had, arrived at from a completely different direction, and
it is the second time this shape of bug has appeared in this codebase.

The lesson generalises: a refusal is never *just* a refusal here. It is a row
that several derived figures read, and excluding it from one of them is not the
same as excluding it from the system.

---

## Part three: two pauses, and why they must not be one control

The redesign separates them, and the separation is enforced by structure rather
than described in a comment.

|  | Mandate pause / revoke | Agent pause |
|---|---|---|
| Kind | **Enforcement** | **Cooperation** |
| Where | inside the request path, before the policy engine | one endpoint the agent polls |
| Hostile agent | stopped | not stopped |
| Costs the agent | a refusal on its record | nothing — it never calls |
| What it is for | you do not trust it to stop | you do, and want to save its tokens |

**`agents.status` is read in exactly one place**: `GET
/api/m/<slug>/agent-control`. Verified — the only `status` remaining anywhere in
the MCP request path is an HTTP response code.

That endpoint is signed like `/mcp` and scoped to the merchant's own agents, so
an agent registered with A gets `unknown_keyid` from B's. It writes no trace and
consumes no velocity: an agent told to poll every 30 seconds that paid a rate
slot per poll would be rate-limited *by obeying*. And it returns no policy, no
thresholds, no catalog — it says whether to work, never how the work will be
judged. Publishing the latter is the map an adversary would use to structure
underneath it, which is why `/catalog` withholds thresholds too.

### The test is deliberately adversarial

The property is a negative one, so the central case is: pause the agent, then
have it ignore that and transact anyway.

```
a paused agent is told to stop                          paused
a paused agent that transacts anyway is judged normally  allow
being paused did not cost it trust                       50.0 -> 80.0
exactly one trace for one action, no refusal added       +1
polling writes no trace and spends no budget             0 -> 0
A cannot read its status from B's endpoint               401
an unsigned request is refused                           401
the answer carries no policy, thresholds or catalog
the contract is public, complete, and has no key material
```

---

## Part four: the Agents page

Per agent: trust score with its component breakdown, cooperative status, pace,
last-seen, and recent decisions **with the buyer's own reasoning next to them**.

`lastSeen` is derived from the trace log rather than stored on the agent row. A
stored timestamp is a second source of truth that drifts the moment a write
fails after the action happened — and "last seen" drifting means an agent looks
alive when it is not, which is the wrong direction for a field a merchant uses
to decide whether something is stuck.

**The two controls sit in separately bordered blocks with explicit labels:**

> **Cooperative — the agent complies.** Changes what this agent is told when it
> asks whether to work. It does **not** refuse anything: an agent that ignores
> it still gets judged on the merits.

> **Enforced — the gate refuses.** Runs before the policy engine and does not
> need the agent's cooperation. Use this when you do not trust it to stop.

Presenting them as one control would be the worst interface bug available here.
A merchant reaching for "stop" during an incident has to know which of the two
they just got, because one of them a hostile agent can ignore.

### Registration

An agent generates its own keypair and hands over the **public** half. There is
no self-service path: an agent that could register itself could grant itself an
identity, and the whole trust model rests on the merchant deciding who may act.

The key is shape-checked before it reaches the database — a value that is not 32
bytes of base64 can never verify a signature, so accepting it would create an
agent guaranteed to fail its first request with a confusing error.

**Export carries no key material at all**, not even the public half. The point
of an export is the shape of the agent; the importing side generates a fresh
keypair. Exporting a key would teach the habit this identity model exists to
avoid.

### The compatibility contract

Rendered on the page and served at `/api/m/<slug>/agent-spec`, generated from
the merchant's live row so every URL in it is real and copy-pasteable. Eleven
requirements, each with the reason behind it — a rule without its reason gets
followed until it is inconvenient.

It is public and unsigned on purpose: an agent needs to read it *before* it has
an identity, in the same way it needs the catalog before it has credentials.
Requiring a signature to learn how to sign would be a closed loop.

---

## Part five: what the buyer now sends back

The buyer attaches a one-line reason to its purchases, and to its accept or
decline on a counter-offer. The merchant records both against the trace and
renders them on the Agents page, so a refusal is easier to judge when you can
see what the buyer thought it was doing.

**That text is sanitised at write time, not render time.** It is written by
someone else's model, stored in our database, and displayed in the merchant's
browser — three hops from untrusted input to a human's screen. React escaping
protects the DOM; it does not protect the database, or whatever reads the row
next.

The buyer also now:

- **Polls before every cycle**, so a paused agent costs nobody a model call or
  an MCP call. That is the entire reason a cooperative pause is worth honouring.
- **Honours `pace_ms`**, with `--pace` to override locally.
- **Fails stopped** when the control channel is unreachable. The tempting
  default is to keep trading on no news; that is backwards for an agent spending
  someone else's money, because if the merchant cannot be reached to say stop,
  that may be the thing it most wants to say.
- **Bounds itself with `--max-actions`** regardless of anything remote. A
  ceiling a remote server can raise is not a ceiling.

---

## Nothing was removed

| | Status |
|---|---|
| `src/lib/demo/mandateClient.ts` | kept — backs all five suites |
| The simulation | kept — still the only source of scenario variety |
| The Buy tab | kept — the one screen showing the whole path at once |

Confirmed in a 12-tick run after all of the above:

```
scenarios: ordinary x14, forged x2, banned_category x2, high_value x1
decisions: allow, block, escalate, protocol_reject
```

All four decision types, including the `protocol_reject` that is the "one
failure handled gracefully" evidence.

---

## Still open

- **The handover is not yet updated** for any of part three onward — §4 (the new
  columns), §7 (the two-pause distinction), §13, §15, §17.
- **The Agents page has not been seen rendered.** It is behind Clerk sign-in and
  was written without being looked at. Types, lint and the production build pass;
  layout and feel are unverified.
- **`endpoint_url` is recorded and never used.** Nothing in this system calls an
  agent — agents call it — so the field is a note for the merchant, and it should
  either grow a purpose or go.
