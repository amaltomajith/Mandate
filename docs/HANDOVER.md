# Mandate: technical handover

Branch `pivot/coo` (about 16 local commits ahead of `master`, never pushed). This covers what was built
since the project stopped being the buildathon payment guardrail and became an autonomous store
manager. For the permanent description of the design, read `docs/ARCHITECTURE.md`; this file is the
"what exists, where, how to run it, what is verified, what is not".

## 1. What the system is

Two in-house agents run a store's buying and selling over Gmail and WhatsApp. Every price drop and
every payout passes through the **Payment Wall**, a deterministic policy gate exposed as an MCP server.
The language model only writes and reads text. Code decides amounts, quantities, suppliers, and whether
anything happens.

| Piece | Runs as | Where |
|---|---|---|
| Dashboard, server actions, Payment Wall, webhooks, OAuth routes | Next.js 16 (App Router, Turbopack) | `src/` |
| Agents, tool hub, channel drivers, scheduler | Long-running Node process (tsx) | `worker/` |
| State | Supabase Postgres (service role only, RLS on, no policies) | `supabase/migrations/` |
| Money rails | Razorpay (links, orders, refunds, webhooks), RazorpayX (payouts), or manual | `src/lib/razorpay/`, `src/lib/manualPayouts.ts` |

The worker is not serverless. It holds sockets (WhatsApp) and a timer loop.

## 2. What was built, in order

1. **Strip.** Removed the buildathon's external buyer agent, traffic simulation, campaigns, MRTR
   counter-offers and the old graph (migration `0019`). Kept: the signed-request gate, traces, escalation
   flow, policy engine.
2. **Domain schema** (`0020`): products with cost/stock/reorder/lead time; `vendors`, `payees`, `quotes`,
   `purchase_orders` + `po_lines`, `payouts`, `sales`, `wallet_entries`, `threads`, `messages`,
   `agent_runs`, `connections` (encrypted), `merchant_settings`, `customers` (opt-in), `webhook_events`.
   Follow-ups: `0021` starting float, `0022` plain unique indexes (a partial unique index cannot be an
   `ON CONFLICT` target), `0023` agent support columns, `0024` `po.confirmed_at`, `0025` manual payouts.
   Migration numbering has no `0003`. All were applied to Supabase through the MCP tool, not the CLI.
3. **Wall upgrades.** New actions `payout.create` and `price.change`; new rules; server-side fact
   resolution; per-agent permissions; write-ahead traces; per-merchant mutex; approval re-check.
4. **In-house agents** (Buying, Selling) as deterministic workflows, plus four local MCP servers and the
   tool hub.
5. **Channels:** sandbox (simulated counterparties), Gmail (REST + OAuth), WhatsApp (Baileys).
6. **Ledger and webhooks:** Razorpay webhook to sales, stock, wallet; payout failure returns money.
7. **Hardening** from an independent review: mutex, operator gate, rate limit, sender authentication,
   price grounding, SSRF ranges, input contract (`verify-hardening`).
8. **Manual payout mode** (`0025`): pay suppliers from your own bank; Mandate keeps the books.
9. **3D operations map** (kept as built): `src/components/graph/*`.
10. **Dashboard front-end rewrite** (section 9, engineering notes only).

## 3. Repository map

```
src/app/                    dashboard, landing, auth, dev preview, API routes
  api/m/[slug]/mcp          the Payment Wall (MCP over HTTP, signed)
  api/m/[slug]/wba-directory  the merchant's public signing keys
  api/webhooks/razorpay/[slug]
  api/connections/gmail/{start,callback}
  api/export/audit          CSV of traces
  dev/preview               unauthenticated dashboard for local inspection
src/lib/policy/             pure rule engine, types, guardrails (settings to rules), seed, audit
src/lib/mcp/                wall server, schemas, facts, trace helpers, tools/actionEvaluator
src/lib/webBotAuth/         Ed25519 sign / verify / canonical / keys
src/lib/razorpay/           client, actions (the only place money moves), payouts, payees, sandbox
src/lib/                    approvals, ledger, manualPayouts, sales, inventory, secrets, settings,
                            workspace, sample, mutex, operator, rateLimit, oauthState, reset, cooData
src/lib/actions/            server actions used by the dashboard (inventory, suppliers, team,
                            connections, manualPayouts, escalations, policy, settings, agents)
worker/src/                 index (loop), tick, runner (locking), session (tool hub + wall client)
  agents/                   buying, selling, quotes (reply parsing), messages (safe rewording)
  mcp/                      store, purchasing, channels, research, shared
  channels/                 types, service (routing + consent), sandbox, gmail, whatsapp, phone, drivers
  sandbox/counterparties.ts simulated suppliers and buyers
  shims/server-only.ts      lets shared src/ code import "server-only" under tsx
scripts/                    verify-*.ts suites, provision, make-preview, lib/ (loadEnv, mandateClient)
supabase/migrations/        0001 to 0025
docs/                       ARCHITECTURE.md, HANDOVER.md, archive/ (buildathon docs)
```

## 4. The Payment Wall

Request path (`src/app/api/m/[slug]/mcp`, `src/lib/mcp/`):

1. Verify the signature (Ed25519 over method, path, authority, body digest, RFC 9421 style), ±300 s
   window, single-use nonce (`seen_nonces`). Failure is recorded as `protocol_reject` against the merchant
   whose URL was hit, never against the claimed agent.
2. Tenant comes from the verified agent row, never from the request.
3. Hard stops: retired agent refused; paused agent or team switched off is blocked and traced; role
   check (`AGENT_PERMISSIONS` in `tools/actionEvaluator.ts`: Selling cannot propose a payout, Buying
   cannot change a price).
4. Facts from the database (`facts.ts`): payee status, product cost, sale margin, PO and its unpaid
   advance, whether a refund targets a recorded sale. The agent cannot supply them.
5. Policy (`policy/engine.ts`, pure). First match wins: `category_block` → `whitelisted_payee` →
   `catalog_scope` → `cap` → `payout_budget` → `min_margin_floor` → `velocity` → `trust_floor` →
   `step_up`; no match is allow.
6. Write-ahead trace, then execute, then update the trace.
7. Execute (`razorpay/actions.ts`). Payouts use the trace id as idempotency key; `payouts.trace_id` is
   unique.

Hard checks outside the rule list: a payout must name an open PO for that payee's supplier and fit in
its unpaid advance; a refund must be of a recorded sale; currency is the literal `INR` in the input schema.

Fail-closed on purpose: unresolvable payee blocks; unknown cost escalates (never skips).

**Actions:** `order.create`, `refund.create`, `payment_link.create`, `payout.create`, `price.change`.
Price change moves no money but gives some away, so it is gated; unscoped spend rules (caps, velocity,
step-up) do not apply to it, only rules that name it (margin floor).

**Approvals** (`src/lib/approvals.ts`): atomic claim `pending → approved`, then execute, release the
claim on failure. Before executing, the limit rules are re-run (a payee revoked since still blocks it).

**Concurrency:** enforce calls AND approvals run one at a time per merchant under `withMerchantLock` (`src/lib/merchantLock.ts`): the in-process mutex (`mutex.ts`) orders callers inside a process, and a database lease (`merchant_locks`, `acquire_merchant_lock`, migration 0027, expires on its own) orders instances against each other.
This is correct for one app instance only (see section 10).

**Guardrails UI to rules:** six numbers in `merchant_settings` (max single payout, approval threshold,
min margin bps, weekly budget, budget % of revenue, starting float) plus `require_approved_vendors`.
`updateGuardrails` (`actions/team.ts`) rewrites the matching rules through `policy/guardrails.ts`.

## 5. Agents

Both run through `worker/src/runner.ts`: take the run lock (`agent_runs` partial unique index, one
`running` row per merchant and kind), open a session (tool hub + signing wall client), run the
workflow, record steps, close.

**Buying** (`agents/buying.ts`): read replies into quotes; settle POs (confirm paid ones, retry ones
waiting for payment details); for each product needing restock: discover suppliers if none approved
(candidates only), request quotes from approved ones, choose the cheapest sane quote, size the order to
the budget, draft the PO, propose the advance, and tell the supplier only once the payment is real.

**Selling** (`agents/selling.ts`): answer buyers (read the message, `evaluate_offer`, counter / decline /
close with a payment link); walk dead stock down a 10/20/30/40% ladder from the original price, never
under the margin floor, with a cooldown; notify opted-in customers.

Model usage (`worker/src/lib/llm.ts`; Groq or local Ollama; falls back to templates when neither is
reachable):

- `agents/messages.ts`: rewording is rejected unless every fact is kept and no rupee amount appears that
  the template lacked.
- `agents/quotes.ts`: a parsed price must literally appear in the supplier's text and pass plausibility
  and margin checks.
- Inbound text is wrapped as untrusted data. A request to change payment details raises a high alert
  and changes nothing.

**Tool surface** (MCP servers in `worker/src/mcp/`, allow-listed per agent in `session.ts`; workflow
code is held to the same list):

| Server | Tools |
|---|---|
| store | `get_inventory`, `list_dead_stock`, `get_cash_position`, `evaluate_offer`, `list_customers` |
| purchasing | `list_vendors`, `add_vendor_candidate`, `list_quotes`, `list_purchase_orders` |
| channels | `send_message_to_vendor`, `send_message_to_customer`, `list_unhandled_messages`, `read_thread`, `mark_handled` |
| research | `web_search`, `fetch_page` (SSRF-guarded: validates the address the socket connects to, re-checks redirects) |
| wall | `simulate_action`, `enforce_action`, `explain`, `draft_policy` |

No local server can move money or create a payee. `payees` is written only by dashboard server actions,
backed by a CHECK that an `active` payee has a recorded human approval.

MCP SDK: `@modelcontextprotocol/server` and `client` 2.3.1, protocol `2026-07-28`; the client needs the
`mcp-protocol-version` header. The worker links its in-process servers with `InMemoryTransport` and
reaches the wall with a signing `fetch`.

## 6. Money

- **Wallet** is the sum of append-only `wallet_entries`; there is no stored balance.
- **Sales** come from the Razorpay webhook (`api/webhooks/razorpay/[slug]`): HMAC check, then
  `webhook_events` event-id ledger for idempotency, then sale + stock decrement + wallet credit.
  Out-of-order events are handled; payout failure or reversal credits the wallet back.
- **Payout budget**: payouts per week ≤ starting float + share of real sales, and ≤ a hard ceiling.
  Sample-store data never funds anything. A queued manual payout already counts against the budget.
- **Payout modes** (`merchant_settings.payout_mode`):
  - `auto`: RazorpayX (`razorpay/payouts.ts`: contacts, fund accounts, payouts). Without a RazorpayX
    connection, a labelled sandbox executor is used and no money moves.
  - `manual`: the wall allows, `queueManualPayout` creates a `payouts` row with `status='queued'`,
    `manual=true`. The PO becomes `approved`, not `paid`. The merchant pays from their own bank (details
    shown via `getPayoutInstructions`, UPI link and QR via `qrcode`) and confirms with
    `confirmManualPayout`: the row is claimed `queued → processed` conditionally (double click or two tabs
    cannot double-debit), the wallet is debited once, the PO becomes `paid` once the advance is covered,
    and only then does the Buying agent tell the supplier. `cancelManualPayout` releases the reservation
    and returns the PO to draft. The UTR/reference is recorded but never verified (Mandate cannot see the
    bank). Full payment details are stored encrypted in manual mode and decrypted in exactly one place,
    for the signed-in merchant, for a payout still waiting whose payee is still active.
- **Sandbox vs live** (`channel_mode`): sandbox by default (simulated counterparties, labelled sandbox
  payment links and payouts, real contacts refused). Live needs the merchant to press the button and a
  real connection for each channel.

## 7. Channels

`worker/src/channels/service.ts` routes by channel and enforces consent: only approved suppliers and
opted-in customers are contacted.

- **Gmail**: REST + merchant OAuth (`api/connections/gmail/*`); scopes `gmail.readonly`, `gmail.send`.
  Refresh token encrypted in `connections`. Only mail that Gmail authenticated (DKIM or DMARC pass) is
  filed as a supplier's. `findPart` prefers `text/plain`. Header values are stripped of line breaks.
- **WhatsApp (Baileys 7 rc)**: dedicated number; load it with a dynamic `import()` (tsx CJS cannot
  resolve its dependency otherwise); session persisted encrypted; QR pairing surfaced to the dashboard;
  human-paced sending.
- **Sandbox**: `sandbox/counterparties.ts` simulates suppliers and buyers on the same code paths.

## 8. Security and secrets

- `MANDATE_SECRET_KEY` (32 bytes base64) encrypts Gmail, Razorpay, WhatsApp secrets and agent signing
  keys, AES-256-GCM (`src/lib/secrets.ts`). Losing it makes stored secrets unrecoverable.
- RLS on, no policies: only the service role touches tables; every query is scoped by a server-resolved
  merchant.
- Server Razorpay/RazorpayX keys are offered only to `MANDATE_OPERATOR_EMAILS`.
- The full threat table is in `docs/ARCHITECTURE.md`.

## 9. Dashboard front-end engineering notes

Presentation only; no backend change. Contracts that matter:

- Shell: `src/components/dashboard/DashboardTabs.tsx` takes the same data props as before plus optional
  `topRight` and `railFooter` slots. Server-created elements passed into those slots (and `map`) need an
  explicit `key`, or React logs "Each child in a list should have a unique key".
- `ActiveTabContext` and the `<div hidden>` Today wrapper keep the WebGL map mounted across tabs. Do not
  turn Today into conditional rendering.
- `LiveRefresher` calls `router.refresh()` every 4 s. Entrance animations must run on mount only and
  lists need stable keys, or they replay or reset client state.
- Shared primitives keep their names: `Panel`, `EmptyState`, buttons, `Icons` (`ui.tsx`, server-safe);
  `useRunner`, `ErrorLine`, `Stat`, `Pill`, `Field`, `Table`, `inputClass`, `rupees`, `rupeesShort`
  (`kit.tsx`). New: `motion.tsx` (`Drawer`, `ConfirmSheet`, `Segmented`, `Sparkline`, `AnimatedNumber`,
  `ProgressRing`, `Reveal`, `Skeleton`), `trend.ts` (series anchored to the newest data point, not the
  clock, so server and browser agree).
- New dependencies: `motion`, `@phosphor-icons/react`.
- `reactStrictMode: false` in `next.config.ts`: Strict Mode's dev-only remount made react-three-fiber
  log "Attempted to synchronously unmount a root" over a hundred times a session.
- `/dev/preview?slug=<slug>` renders the dashboard without Clerk; it 404s in production and unless
  `MANDATE_DEV_PREVIEW=1`. `npm run preview:seed` creates the `preview` merchant with sample activity.
- Not yet restyled: `AgentTrustPanel`, `PolicyRulesPanel`, `PolicyHealthPanel`, `SettingsPanel`,
  `AlertsBell`, `AlertToasts`, `dashboard/loading.tsx`.

## 10. Running it

```
npm install
cp .env.example .env.local     # Supabase, Clerk, MANDATE_SECRET_KEY, NEXT_PUBLIC_APP_URL
# apply supabase/migrations/*.sql in order
npm run dev                    # scripts/dev.mjs; app must be on the URL in NEXT_PUBLIC_APP_URL
npm run worker                 # second terminal; -- --once, -- --slug <slug>; worker:dry for dry-run
```

`NEXT_PUBLIC_APP_URL` is the signing authority, so the worker and the app must agree on it exactly
(`http://localhost:3000` locally; a second dev server on 3001 breaks signatures).

Env: Supabase (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`),
Clerk keys and URLs, `MANDATE_SECRET_KEY`, optional `RAZORPAY_KEY_ID/SECRET/WEBHOOK_SECRET`,
`RAZORPAYX_ACCOUNT_NUMBER`, `MANDATE_OPERATOR_EMAILS`, `LLM_PROVIDER` + `GROQ_API_KEY` or
`OLLAMA_URL` + `LOCAL_LLM_MODEL`, `MANDATE_MERCHANT_SLUG`,
`GOOGLE_CLIENT_ID/SECRET`, `SEARCH_PROVIDER` + `SEARCH_API_KEY`, `MANDATE_DEV_PREVIEW`,
`MANDATE_CA_CERT` (TLS-intercepting networks). `worker/` resolves `server-only` through a tsconfig
`paths` shim.

## 11. Verification

```
npm run verify:offline    # database only
npm run verify:online     # needs npm run dev on :3000; makes real model calls (minutes)
npm run verify            # typecheck + lint + everything
```

| Suite | Checks | Covers |
|---|---|---|
| verify-engine | 30 | every rule, fail-closed cases, priority |
| verify-hardening | 58 | mutex, operator gate, rate limits (wall and dashboard actions), mail sender authentication (DKIM alignment), price grounding, SSRF, input contract, dashboard action input schemas |
| verify-inventory | 15 | velocity, runway, dead stock, floor price |
| verify-channels | 43 | Gmail parsing, header safety and a stubbed Gmail (429 retry, no refetch), phone matching, consent, a failed record never re-sends, SSRF refusals |
| verify-reset | 31 | clears exactly one tenant |
| verify-ledger | 34 | sale booking, payout failure refund, payout booking and manual confirm are atomic and exactly-once under parallel calls; no encrypted payee details in dashboard data; config change log |
| verify-concurrency | 10 | the cross-instance lease; parallel enforce and parallel approvals never overspend one budget |
| verify-wall | 43 | signatures, replay, payee/margin/budget/caps, PO and refund ownership, currency, kill switches, dry run, idempotency |
| verify-worker | 19 | heartbeat vs reaping, prompt shutdown, merchant backoff, worker pulse, log lines (needs the app running) |
| verify-manual | 30 | queue, wallet moves only on confirm, double-confirm and cross-tenant refused, cancel releases budget |
| verify-buying | 35 | quote to order to approval to payout to confirmation; hostile and unprofitable suppliers |
| verify-selling | 28 | clearance ladder, opt-in only, haggling, links, a buyer pushing the price to Rs 1 |
| verify-webhook | 18 | signature, idempotency, sales, payout failures, out-of-order events |
| verify-loop | 13 | slow stock funds the restock end to end |

**Total: 407 checks** (offline 221, online 186). All passing on 2026-10-12 after the hardening pass in
section 14, together with `tsc` (app and worker), `eslint`, `next build` and `npm audit` (0 vulnerabilities).
`.github/workflows/ci.yml` runs typecheck and lint always, and `verify:offline` when the `TEST_SUPABASE_*`
secrets are set; the online suites stay manual (they need a running app and make real model calls).

## 12. Known limits and unverified areas

- **Locking across instances** is a lease row with a 90 s expiry: a holder that crashes mid-evaluation
  blocks that merchant's money path for up to that long, then the lease frees itself. A single evaluation
  that legitimately runs longer than the lease (a very slow RazorpayX call) could in theory be overlapped;
  the payout idempotency key and the unique indexes make that safe for money, but it is the one place the
  guarantee is time-based rather than absolute.
- **Single worker.** Each agent run is guarded by the `agent_runs` unique index plus a heartbeat; two
  workers cannot run the same agent for one merchant at once, but nothing coordinates which worker
  holds a WhatsApp session.
- **Rate limits are per process** (`src/lib/rateLimit.ts`). Fine as a brake on one instance; a precise
  global limit belongs at the platform edge.
- **Gmail and RazorpayX are implemented but unexercised against live accounts.** Parsing, safety and
  consent rules are tested; the network calls follow the providers' documented APIs. RazorpayX needs a
  registered business account (not available during development, hence manual payout mode).
- **WhatsApp:** pairing was verified up to a QR from WhatsApp's servers; a full scan, send and receive
  needs a real phone and number. Baileys is unofficial; use a dedicated number.
- **Manual payouts:** the reference is not verified against any bank.
- **Free-tier Supabase pauses after a week idle** ("fetch failed" on the dashboard); restore the project.
  Worker polling keeps an active account awake.
- **Windows:** git needs `-c safe.directory='*'` here; in shell scripts avoid apostrophes in heredocs
  (use files).
- Nothing has been pushed from `pivot/coo`.

## 13. Next steps, if continuing

1. Live-test Gmail (OAuth client is configured locally) and WhatsApp with a real number.
2. Decide hosting: the app anywhere Next runs; the worker needs a long-lived process.
3. Responsive and reduced-motion checks on a real phone; a skeleton for each tab's first paint.
4. Error reporting (Sentry or similar) behind the existing structured logs.
5. Reconciliation for a real payout that went out but could not be booked (it is retried three times, and
   the failure is logged with the payout id, but there is no background sweep yet).

## 14. Hardening pass (2026-10-12)

Every item began as a failing test that reproduced the problem; claims from the audits that did not
reproduce were not changed.

| Problem (reproduced) | Fix | Where |
|---|---|---|
| Three parallel sales left stock at 7 instead of 1 (lost updates); a failure after the sale insert lost the wallet credit for good because the retry saw the sale | `book_captured_payment`: sale lines, guarded stock decrement and wallet credit in one transaction | migration 0026, `src/lib/sales.ts` |
| A failed and a reversed payout event arriving together could both credit the wallet | `apply_payout_status`: row lock, forward-only status, one refund; unique index backstops | 0026, webhook route |
| Manual confirm claimed the payout, then debited separately | `confirm_manual_payout`: one transaction | 0026, `src/lib/manualPayouts.ts` |
| Four simultaneous approvals paid 48,000 rupees against a 25,000 budget | approvals run under the same per-merchant lock as enforce | `src/lib/approvals.ts` |
| The lock only worked inside one process | database lease `acquire_merchant_lock` / `release_merchant_lock` | 0027, `src/lib/merchantLock.ts` |
| A payout row could exist without its debit, and the retry then called it "already booked" | `record_payout`: row + debit in one transaction, bounded retry after the money has gone out | 0028, `src/lib/ledger.ts` |
| A DKIM pass from any domain authenticated a spoofed From | DKIM counts only when its domain aligns with the From domain; `dmarc=pass` alone is enough | `worker/src/channels/gmail.ts` |
| `payees.details_enc` (ciphertext) was sent to the browser | explicit column list, blanked in the returned object | `src/lib/cooData.ts` |
| Server actions trusted TypeScript types and had unbounded text | zod schemas (ids, enums, lengths, formats), a per-user action rate limit, an export rate limit and a truncation header | `src/lib/actions/schemas.ts`, `authGuard.ts`, `rateLimit.ts` |
| No record of who changed a limit or switched the team off | `config_events` + a Changes view on Activity; every setting change goes through one logged path | 0029, `src/lib/configLog.ts`, `actions/team.ts` |
| A slow legitimate run was reaped after a fixed 10 minutes; shutdown waited out the sleep; a failing merchant retried at full speed; the dashboard guessed worker health | heartbeats, abortable sleep with a second-signal exit, exponential backoff per merchant, a `worker_status` pulse | 0030, `worker/src/{runner,lifecycle,index,tick}.ts` |
| A failed message record after a successful send made the call fail, so a retry sent the email twice | bounded retry on the record; the send is reported as done and the gap logged | `worker/src/channels/service.ts` |
| Gmail polling re-downloaded every body each tick and failed on a 429 | retry with `Retry-After`; messages are skipped once the service acknowledges them | `gmail.ts`, `types.ts` |
| The 3D map's drei `<Html>` labels logged "unmount a root" a dozen times a load (dev only) | one exact message filtered in dev; Strict Mode turned off for the map | `GraphCanvas.tsx`, `next.config.ts` |

Front end: error, global-error and not-found pages (this Next version passes `retry`, not `reset`), a
loading skeleton that matches the rail layout, Settings reachable on phones, a focus trap and
`aria-labelledby` on dialogs, arrow keys on the segmented control, `aria-live` on toasts, `aria-expanded`
on the alerts bell, a skip link, `--muted-2` raised to AA contrast, the refresher paused while the tab is
hidden, and `optimizePackageImports` for icons and motion. A Supabase query is lazy: it is only sent when
awaited or `.then`-ed, which is why the worker heartbeat uses `.then(...)`.
