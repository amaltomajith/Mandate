-- A cross-instance lock for the money path. The in-process mutex (src/lib/mutex.ts)
-- serialises enforce and approval calls within one server; this lease makes the
-- same guarantee hold when several instances run. It is a row with an owner and
-- an expiry rather than a held connection: supabase-js cannot keep a transaction
-- open across calls, and a lease also frees itself if its holder crashes.

create table if not exists merchant_locks (
  merchant_id uuid primary key references merchants(id) on delete cascade,
  owner text not null,
  expires_at timestamptz not null
);
alter table merchant_locks enable row level security;

-- True when the caller now holds the lock: nobody had it, or the holder's lease
-- ran out. Atomic: of several simultaneous callers exactly one gets true.
create or replace function acquire_merchant_lock(p_merchant uuid, p_owner text, p_ttl_seconds int)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  n int;
begin
  insert into merchant_locks (merchant_id, owner, expires_at)
  values (p_merchant, p_owner, now() + make_interval(secs => p_ttl_seconds))
  on conflict (merchant_id) do update
    set owner = excluded.owner, expires_at = excluded.expires_at
    where merchant_locks.expires_at < now();
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

create or replace function release_merchant_lock(p_merchant uuid, p_owner text)
returns void
language sql
set search_path = public
as $$
  delete from merchant_locks where merchant_id = p_merchant and owner = p_owner;
$$;

revoke all on function acquire_merchant_lock(uuid, text, int) from public, anon, authenticated;
revoke all on function release_merchant_lock(uuid, text) from public, anon, authenticated;
grant execute on function acquire_merchant_lock(uuid, text, int) to service_role;
grant execute on function release_merchant_lock(uuid, text) to service_role;
