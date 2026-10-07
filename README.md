# Mandate

**An autonomous store manager that can never spend what it shouldn't.**

Mandate sells your slow-moving stock to fund restocking your bestsellers. Two in-house agents do the
work: a **Selling agent** that clears dead stock and haggles with buyers, and a **Buying agent** that
finds suppliers, gets quotes, orders and pays. They talk to real suppliers and customers over **Gmail
and WhatsApp**, and every price drop and every payout passes through a **Payment Wall**: a
deterministic guardrail, written in code, that no message, mistake or clever prompt can talk its way
past.

```
        Selling agent                    Payment Wall                      Buying agent
   find dead stock, mark it     checks every rupee against your      spot a bestseller running out,
   down within your margin,  ─►  own records, in code:           ◄─  get quotes, pick the best,
   haggle, send a pay link       approved payee? margin? budget?      draft the order, propose the
          │                      cap? needs a human?                  advance (sized to what sales
          ▼                              │                           have actually funded)
   sales ─► wallet ─► restock budget ◄───┘
```

## What a merchant gets

- **Today**: cash, runway, what is stuck, what your team did, and everything waiting for your approval,
  plus a live 3D map of the business with the Payment Wall at its centre.
- **Inventory**: stock, sales pace, days of stock left, unit cost and margin, with CSV import.
- **Suppliers**: researched candidates to approve, payment details (approved by a person only),
  quotes, purchase orders.
- **Sales**: sales, supplier payouts and the wallet.
- **Guardrails**: six limits in rupees and percent. No rule types, no JSON.
- **Activity**: every action and the rule that decided it, and every message sent in your name.
- **Team**: pause one agent or switch the whole team off (enforced at the wall), or run in **dry-run**.
- **Connections**: Gmail, WhatsApp, Razorpay, RazorpayX, web search, and the sandbox/live switch.

## How it is built

| Part | What it is |
|---|---|
| **Dashboard + Payment Wall** | Next.js 16 (App Router), Clerk, Supabase (Postgres). The wall is an MCP server at `/api/m/<slug>/mcp`: requests are Ed25519-signed (RFC 9421 style), nonce-protected, and every decision leaves a trace. |
| **Worker** (`worker/`) | A long-running Node process that lets each merchant's agents act on a timer. Not for serverless: it holds connections (WhatsApp keeps a socket open). |
| **MCP servers** (`worker/src/mcp/`) | `store`, `purchasing`, `channels`, `research`, mounted behind one tool hub with per-agent allow-lists. The wall is reached with the official MCP client and a signing `fetch`. |
| **Agents** (`worker/src/agents/`) | Deterministic workflows over those tools. The language model **writes and reads text**; it never chooses an amount, a quantity or a supplier. |
| **Channels** (`worker/src/channels/`) | Sandbox (simulated counterparties), Gmail (REST + OAuth), WhatsApp (Baileys). Real channels exist only in live mode with a connection. |

More in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Quick start

You need Node 20+, a Supabase project, a Clerk application, and (optionally) Ollama or a Groq key.

```bash
npm install
cp .env.example .env.local        # fill in Supabase, Clerk, and MANDATE_SECRET_KEY
```

1. **Database.** Apply `supabase/migrations/*.sql` in order in the Supabase SQL editor (the
   sequence has no `0003`; that is expected). Or use the Supabase CLI.
2. **Secrets key.** `MANDATE_SECRET_KEY` encrypts everything sensitive at rest. Generate one with
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Losing it makes
   stored secrets unrecoverable, by design.
3. **Run the app:** `npm run dev` (uses `scripts/dev.mjs`, which adds your corporate CA from
   `MANDATE_CA_CERT` if you are behind a TLS-inspecting proxy).
4. **Sign up.** Your account is provisioned on first sign-in: starting rules, a catalog, the two
   agents with generated keys, settings and guardrails.
5. **Load the sample store** from the Today tab (or `npm run provision -- --slug <yours> --sample`).
6. **Run the worker** in a second terminal: `npm run worker` (`-- --once` for a single pass).

Out of the box everything is a **sandbox**: simulated suppliers and buyers, sandbox payment links and
a sandbox payout executor. Nothing real is contacted or paid, and everything simulated says so.

### Language model

Agents use the model for wording and for reading messy replies. Set `LLM_PROVIDER=groq` with
`GROQ_API_KEY`, or run Ollama locally (`LOCAL_LLM_MODEL`, default `granite4`). With none reachable
the agents still run on plain templates.

## Going live

Connect things under **Connections**, then press **Go live**. Until then nothing real is contacted.

- **Razorpay**: paste a key pair (it is verified before it is kept), and point Razorpay's webhook at
  `<APP_URL>/api/webhooks/razorpay/<your-slug>`. Captured payments then book the sale, stock and
  wallet; payout failures return the money to the wallet.
- **RazorpayX**: add your account number. Supplier bank/UPI details are sent to Razorpay and only the
  last digits are kept here. Without RazorpayX, payouts use the labelled sandbox executor.
- **Gmail**: set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (redirect URI
  `<APP_URL>/api/connections/gmail/callback`), then connect. Scopes: read and send only.
- **WhatsApp**: enable it, run the worker, and scan the QR shown under Connections with a
  **dedicated number**. WhatsApp can restrict numbers that automate messaging; see the notes below.
- **Search**: works with no key (a free search); a Brave or Tavily key gives better results.

## What the Payment Wall enforces

All of this is in code, evaluated from the merchant's own records. See `src/lib/policy/engine.ts`.

| Guardrail | Behaviour |
|---|---|
| Approved payees only | A payout to an unapproved, pending, revoked or unknown payee is **blocked** (fails closed). |
| Margin floor | A sale or price drop under the floor is blocked; an **unknown cost escalates**, it is never skipped. |
| Self-funded budget | Payouts per week ≤ starting float + a share of real sales, and ≤ a hard ceiling. |
| Single-payout and per-payee daily caps | Absolute. |
| Approval threshold | At or above it, the payout waits for a person, who sees who, what for, and why. |
| Least privilege | The Selling agent cannot even propose a payout; the Buying agent cannot change a price. |
| Kill switches | Pausing an agent or the team, and dry-run, are enforced at the wall. |
| Approval re-check | Approving an escalation re-runs the *limit* rules, so a payee revoked since still blocks it. |
| Payouts need an order | A payout must name a purchase order that exists, belongs to that supplier, is still open, and has at least that much advance unpaid. A second payment against a settled order is refused. |
| Refunds need a sale | A refund must be of a payment this business actually recorded. |
| Rupees only | Any other currency is rejected at the schema, since every limit is written in rupees. |

Agents never see cost prices, bank details, or the merchant's floor. Negotiation goes through an
oracle (`evaluate_offer`) that returns accept, counter or decline without revealing the number behind it.

## Verification

```bash
npm run verify:offline    # engine, inventory maths, channels, reset  (database only)
npm run verify:online     # wall, buying, selling, webhook, closed loop  (needs `npm run dev`)
npm run verify            # typecheck + lint + everything
```

| Suite | Checks |
|---|---|
| `verify-engine` | 30: every rule, including fail-closed cases and priority |
| `verify-hardening` | 36: findings from the independent security review (mutex, operator gate, rate limit, sender authentication, price grounding, SSRF ranges, input contract) |
| `verify-inventory` | 15: velocity, runway, dead stock, floor price |
| `verify-channels` | 36: Gmail parsing and header-injection safety, phone matching, who may be contacted, SSRF refusals |
| `verify-reset` | 31: clears exactly one tenant, keeps what it promises |
| `verify-wall` | 43: signatures, replay, payee/margin/budget/caps, purchase-order and refund ownership checks, currency, kill switches, dry-run, idempotency |
| `verify-buying` | 35: quote → order → approval → payout → confirmation; hostile and unprofitable suppliers |
| `verify-selling` | 28: clearance ladder, opt-in only, haggling, payment links, a buyer trying to talk the price to ₹1 |
| `verify-webhook` | 18: signature, idempotency, sales, payout failures, out-of-order events |
| `verify-loop` | 13: slow stock funds the restock, end to end |

**Total: 285 checks.** The online suites make real model calls and take several minutes.

## Honest notes

- **Baileys is unofficial.** It speaks WhatsApp Web's protocol. Use a dedicated number, expect that
  WhatsApp may restrict it, and treat email as the dependable channel. Pairing was verified against
  WhatsApp's servers (a QR is issued); a full scan, send and receive needs a real phone and number
  and has not been exercised.
- **Gmail and RazorpayX are implemented but unexercised against live accounts** (no credentials were
  available during development). Their parsing, safety and consent rules are tested; the network
  calls follow the providers' documented APIs. RazorpayX also needs a registered business account.
- **The sandbox is not a stub.** It exercises the same code paths, but its suppliers and buyers are
  simulated, and its payment links go nowhere. Everything it produces is labelled.
- **Free-tier Supabase pauses after a week idle.** If the dashboard reports "fetch failed", restore the
  project. The worker's polling keeps an active account awake.
- **Single worker, single app instance.** The run lock is per agent in the database, and enforce
  calls are serialised per merchant *within one server process*, which closes the window where two
  concurrent requests read the same "spent so far". A deployment with several app instances and
  external agents calling in parallel would need a Postgres advisory lock to make that guarantee
  across instances. The in-house agents are serialised regardless.
- **Server keys are the operator's.** "Use this server's Razorpay keys" is offered only to emails in
  `MANDATE_OPERATOR_EMAILS`. Leave it empty on a deployment with more than one merchant.
- **Supplier email must be authenticated.** A message is only filed as a supplier's if Gmail reports
  DKIM or DMARC pass for it; a forged "from" header is ignored.

## Layout

```
src/app/                 dashboard, landing, auth, MCP route, webhooks, OAuth routes
src/lib/policy/          the rule engine (pure), guardrails, audit, seed
src/lib/mcp/             the Payment Wall's MCP server and evaluator
src/lib/razorpay/        Razorpay client, payouts (RazorpayX), sandbox objects, payee registration
src/lib/                 inventory maths, ledger, sales, approvals, settings, secrets, sample store
src/components/          dashboard tabs; graph/ is the 3D map
worker/src/              runner, tick loop, session; mcp/, agents/, channels/, sandbox/
supabase/migrations/     schema, applied in order
scripts/                 verification suites, provisioning, preview seeding
docs/                    ARCHITECTURE.md; archive/ holds the original buildathon docs
```

`/dev/preview?slug=<slug>` renders the dashboard without signing in, for inspecting the UI. It is a
404 in production and unless `MANDATE_DEV_PREVIEW=1` is set.
