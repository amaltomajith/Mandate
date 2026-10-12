# Deploying Mandate

Two pieces, because one of them cannot be serverless.

| Piece | Where | Why |
|---|---|---|
| Web app (dashboard, Payment Wall MCP endpoint, webhooks) | Vercel, project `mandate` | Request/response, scales to zero |
| Worker (agents on a timer, WhatsApp socket) | Any always-on container host. Steps below use Fly.io | Keeps connections open and a pass can outlast a function |

The database is the Supabase project; apply `supabase/migrations/*.sql` in order (0001 to 0036).

## Web app (Vercel)

```
vercel deploy --prod --yes        # uploads the working tree; does not push to git
```

Production environment (names only): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, the Clerk keys and URLs, `MANDATE_SECRET_KEY`, `GROQ_API_KEY`,
`NEXT_PUBLIC_APP_URL` (the stable production alias, because every signed request names it as its
authority). Do **not** set `MANDATE_DEV_PREVIEW` (it opens an unauthenticated dashboard) or
`MANDATE_CLAIM_DEMO_MERCHANT`. Leave `MANDATE_OPERATOR_EMAILS` empty unless the operator should be able to
lend the server's Razorpay keys.

## Worker (Fly.io)

The worker is stateless: WhatsApp's session is stored encrypted in the database, so it needs no volume.
One small machine is enough (`fly.toml`: shared-cpu-1x, 512 MB). Other hosts work the same way, using the
`Dockerfile` and the same secrets (Railway, Render background worker, any VPS with Docker).

```powershell
# one time: install flyctl, sign up (Fly asks for a card), then
fly auth login
fly launch --no-deploy --copy-config --name mandate-worker     # keeps fly.toml; pick a free app name

# secrets: the worker needs only these. NEXT_PUBLIC_APP_URL MUST be the web app's production URL
# (not localhost), and LLM_PROVIDER=groq because there is no local model in the container.
Get-Content .env.local | Select-String '^(NEXT_PUBLIC_SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY|MANDATE_SECRET_KEY|GROQ_API_KEY)=' | ForEach-Object { $_.Line } | fly secrets import
fly secrets set NEXT_PUBLIC_APP_URL=https://mandate-amaltomajiths-projects.vercel.app LLM_PROVIDER=groq

fly deploy
fly logs                                                       # expect: "worker up" then a "merchant pass" every minute
```

Optional secrets: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
(Gmail needs the production redirect URL added in the Google console), `SEARCH_PROVIDER` +
`SEARCH_API_KEY`.

Run exactly one worker. Two would not corrupt anything (each agent run is guarded by a database lease and
heartbeat) but they would fight over the same WhatsApp session.

## Checks after deploying

- `https://<app>/login` loads; `/dev/preview` is a 404.
- `fly logs` shows `worker up` and a `merchant pass` line per merchant.
- A signed-in test merchant's Today tab shows the team "running", and the worker status is not "idle".
- A pass signed against the production URL succeeded: verified from a local worker with
  `NEXT_PUBLIC_APP_URL` set to the production alias (`--once --slug preview`).

## Known limits

- Clerk is on a development instance (a banner shows on sign-in). Move to a production instance and
  your own domain before real users.
- The container image was written but not built here (no Docker engine was running); the same code was run
  directly with `tsx` against the live app. The first `fly deploy` is the first image build.
- Rate limits are per process, so a precise global limit belongs at the platform edge.
