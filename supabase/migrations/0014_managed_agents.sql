-- One simulation identity per merchant, and a way to tell it apart from a real
-- third-party agent.
--
-- The simulation could not reuse its identity across restarts on any merchant
-- the SIM_AGENT_ID env pin did not name. That pin is a single agent id and it
-- belongs to exactly one merchant, so on every other tenant the lookup missed
-- and the fallback minted a brand new agent, keypair and all, with a
-- "(HH:MM:SS)" suffix to dodge the name clash. One new agent per server
-- process, forever -- which is where "Checkout Agent (14:24:24)" and
-- "Checkout Agent (18:24:24)" came from.
--
-- Reusing a row instead needs its private key, and Mandate deliberately never
-- stores one. So the managed row's PUBLIC key is rotated on each process
-- start: same identity, same accumulated trust, fresh keypair that only the
-- running process holds.
--
-- That rotation is only ever safe on scaffolding the merchant owns, never on
-- an agent someone else runs -- rotating a third party's key would silently
-- lock them out. Hence this flag, and the fact that it defaults to false:
-- an agent registered through the dashboard is someone else's, and nothing
-- may rotate its key.
alter table agents
  add column if not exists managed boolean not null default false;

comment on column agents.managed is
  'True only for identities Mandate itself mints and signs as (the built-in traffic simulation). Its public key may be rotated on restart because the merchant owns it. NEVER set this on a third-party agent: rotating a key we do not control locks that agent out.';

-- Adopt the oldest existing simulation row per merchant, so its history and
-- trust score carry forward rather than starting again. The later duplicates
-- are deliberately left alone and unmanaged: their traces are real, signed
-- history and deleting them would be rewriting the audit log to tidy a roster.
update agents a
set managed = true
where a.name = 'Checkout Agent'
  and a.id = (
    select b.id
    from agents b
    where b.merchant_id = a.merchant_id
      and b.name = 'Checkout Agent'
    order by b.created_at asc
    limit 1
  );

-- At most one managed identity per merchant. The bug this migration exists to
-- fix was duplicate identities, so the shape of the fix is enforced here rather
-- than left to the code that writes it.
create unique index if not exists agents_one_managed_per_merchant
  on agents (merchant_id)
  where managed;
