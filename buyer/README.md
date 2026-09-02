# The buyer

An autonomous AI buying agent. It shops at a Mandate merchant, and it is **not
part of Mandate**.

That distinction is the point of this directory, so it is enforced rather than
asserted:

- **Its own package**, its own `node_modules`, outside any workspace. Nothing in
  the parent repo builds it, bundles it, or imports it.
- **Zero imports from `src/`.** Not the policy engine, not the Supabase client,
  not the catalog module, not the merchant's own MCP client. The transport in
  `src/transport.ts` is a *copy*, written against the protocol rather than
  shared — because a real third-party buyer would have to write its own, and if
  this one borrowed the merchant's, the isolation would be a claim instead of a
  fact.
- **Four environment variables**, none of which is a database or a payment
  credential. There is no `SUPABASE_SERVICE_ROLE_KEY` here, no
  `RAZORPAY_KEY_SECRET`, no Clerk key. If this process could reach the
  merchant's database, watching it buy something would prove nothing.
- **Products and tools are discovered over the wire.** The catalog comes from
  `GET /api/m/<slug>/catalog` and the tool list from `tools/list`. Neither is
  imported, and neither is hardcoded.

## Identity

There is no API key and no account. Under Web Bot Auth the **keypair is the
identity**: this agent signs every request with an Ed25519 private key, and the
merchant verifies it against the public half they published in their key
directory. The `keyid` it signs with *is* its agent id.

```bash
npm --prefix buyer install
npm --prefix buyer run keygen
```

That prints a private key and a public key. The private key goes in
`buyer/.env`; the public key goes to the merchant, who registers it and returns
an agent id. On this repo's own demo instance that step is:

```bash
npx tsx scripts/register-buyer.ts <base64-public-key>
```

which prints the `BUYER_AGENT_ID` to paste back. A real merchant would have
their own onboarding for this — the important part is that it is *theirs*: an
agent cannot register itself, and an unregistered key is rejected at the
signature check before any policy runs.

## Configuration

Copy `.env.example` to `.env`:

```
MANDATE_MCP_URL=http://localhost:3000/api/m/demo/mcp
BUYER_AGENT_ID=<returned by the merchant>
BUYER_PRIVATE_KEY=<from keygen — never leaves this machine>
GROQ_API_KEY=<judgement runs on a hosted model>
```

Optional: `BUYER_PERSONA`, `BUYER_BUDGET_PAISE`, `BUYER_GAP_MS`.

## Running

```bash
npm --prefix buyer start        # browse until the budget runs out
npm --prefix buyer run once     # a single purchase
```

## What it actually does

1. **Discovers** the merchant: fetches their catalog over HTTP, asks the MCP
   endpoint what tools exist.
2. **Decides** what to buy. A model reasons from a persona and a budget over
   the fetched catalog and produces a choice *and* a reason. Every SKU it names
   is grounded against the catalog — a hallucinated one is discarded, not
   repaired, because repairing it would mean guessing about someone else's
   money.
3. **Checks before committing.** `simulate_action` first, `enforce_action`
   only if it would clear. That is what simulate exists for from a buyer's
   side: a refusal found by simulating costs a round trip, a refusal found by
   enforcing costs a mark on this agent's trust score.
4. **Answers counter-offers.** When the merchant returns an `input_required`
   result mid-call, the model is given the offer, the parent purchase, and the
   remaining budget, and decides — with a one-line reason, logged. The
   merchant's `requestState` is echoed back **verbatim**: it is their sealed
   state, opaque and none of this agent's business.
5. **Handles every outcome.** Allowed, refused, escalated to a human, refused
   at the protocol layer. An escalation is not a crash — a human was asked, and
   the agent says so and moves on.

## The fallback, and why it is announced

If no model is reachable, the agent still runs: it buys the cheapest thing that
fits and declines every offer. That path is logged as
`[fallback, not a decision]`, because a deterministic rule wearing the agent's
voice would be the most misleading thing this program could print.

## What it does not do

It holds no policy configuration — no caps, no thresholds, no trust scores. It
does not know why a purchase was refused beyond the plain-language reason the
merchant chose to give it, and it cannot see anyone else's orders. Everything it
knows, it was told over a public endpoint or in a signed reply to its own
request.
