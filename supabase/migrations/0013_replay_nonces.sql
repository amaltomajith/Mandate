-- Mandate — replay protection
--
-- The signature base already covered `created`, and the verifier already
-- rejected anything outside a ±300 second window, so a captured request could
-- never be replayed indefinitely. But five minutes is a long time to hold a
-- valid enforce_action: capture one, resend it inside the window, and the
-- merchant creates a second identical order. The signature is genuine, the
-- digest matches, and nothing in the request distinguishes the replay from the
-- original.
--
-- The offer-id unique index (0011) closes this for counter-offer retries only,
-- because only those carry an offer id. Everything else was open.
--
-- A nonce closes it generally: each signed request carries one, it is covered
-- by the signature so it cannot be swapped, and the server refuses one it has
-- already seen. Uniqueness is enforced by the index rather than by a check,
-- for the same reason as 0011 -- two concurrent replays would both pass a
-- check-then-insert.
--
-- Rows are disposable. They only matter for as long as the skew window, and
-- `expires_at` is what lets them be pruned without reasoning about which
-- request they belonged to.

create table if not exists seen_nonces (
  nonce text primary key,
  agent_id uuid references agents(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists seen_nonces_expiry_idx on seen_nonces (expires_at);

alter table seen_nonces enable row level security;
