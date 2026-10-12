-- Khata: selling on credit to regular customers, and collecting it.
--
-- Credit is extended by the merchant, never by an agent: the only write path is
-- the SQL functions below, which enforce a per-customer limit and a total
-- exposure cap under a row lock, so two sales at once cannot both slip under a
-- limit. An agent only reminds; it cannot lend.
--
-- A credit sale takes stock off the shelf and is recorded in credit_entries, but it
-- is NOT money: it is not wallet money and is not revenue for the payout budget
-- until the customer pays. Its sales rows carry a `credit_` payment id (like the
-- `sample_` ones) so every revenue total can leave them out; the cash, when it
-- arrives, is booked as a wallet credit plus a revenue row with a `khatapay_` id.

alter table customers
  add column if not exists credit_limit_paise bigint not null default 0 check (credit_limit_paise >= 0),
  add column if not exists credit_terms_days integer not null default 15 check (credit_terms_days between 1 and 180);

alter table merchant_settings
  add column if not exists credit_exposure_cap_paise bigint not null default 5000000 check (credit_exposure_cap_paise >= 0);

-- Append-only. A customer's balance is sale - payment - writeoff.
create table if not exists credit_entries (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  kind text not null check (kind in ('sale', 'payment', 'writeoff')),
  amount_paise bigint not null check (amount_paise > 0),
  note text,
  due_at timestamptz,
  ref text,
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists credit_entries_customer_idx on credit_entries (merchant_id, customer_id, created_at);
-- A retry with the same ref is the same entry, not a second one.
create unique index if not exists credit_entries_ref on credit_entries (merchant_id, ref) where ref is not null;

create table if not exists credit_reminders (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  message text not null,
  created_at timestamptz not null default now()
);
create index if not exists credit_reminders_idx on credit_reminders (merchant_id, customer_id, created_at desc);

alter table credit_entries enable row level security;
alter table credit_reminders enable row level security;

-- What a customer owes right now.
create or replace function credit_balance(p_merchant uuid, p_customer uuid) returns bigint
language sql stable set search_path = public as $$
  select coalesce(sum(case when kind = 'sale' then amount_paise else -amount_paise end), 0)::bigint
    from credit_entries where merchant_id = p_merchant and customer_id = p_customer;
$$;

-- ── Sell on credit ──────────────────────────────────────────────────────────
-- p_rows: [{ "product_id": uuid, "qty": int, "amount_paise": bigint }]
-- Returns { ok, entry_id, duplicate?, reason?, owed_paise? }.
create or replace function extend_credit(
  p_merchant uuid,
  p_customer uuid,
  p_rows jsonb,
  p_note text,
  p_ref text,
  p_by text
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  cust customers%rowtype;
  total bigint := 0;
  owed bigint;
  exposure bigint;
  cap bigint;
  r jsonb;
  idx int := 0;
  entry uuid;
  have int;
begin
  -- Lock the customer, then the merchant's settings row (the exposure cap is shared
  -- by every customer): two credit sales racing are serialised here.
  select * into cust from customers where id = p_customer and merchant_id = p_merchant for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_customer'); end if;
  select credit_exposure_cap_paise into cap from merchant_settings where merchant_id = p_merchant for update;

  if p_ref is not null then
    select id into entry from credit_entries where merchant_id = p_merchant and ref = p_ref;
    if found then return jsonb_build_object('ok', true, 'duplicate', true, 'entry_id', entry); end if;
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    total := total + (r ->> 'amount_paise')::bigint;
  end loop;
  if total <= 0 then return jsonb_build_object('ok', false, 'reason', 'empty'); end if;

  owed := credit_balance(p_merchant, p_customer);
  if cust.credit_limit_paise <= 0 then return jsonb_build_object('ok', false, 'reason', 'no_credit', 'owed_paise', owed); end if;
  if owed + total > cust.credit_limit_paise then
    return jsonb_build_object('ok', false, 'reason', 'over_limit', 'owed_paise', owed, 'limit_paise', cust.credit_limit_paise);
  end if;

  select coalesce(sum(case when kind = 'sale' then amount_paise else -amount_paise end), 0)::bigint into exposure
    from credit_entries where merchant_id = p_merchant;
  if exposure + total > coalesce(cap, 0) then
    return jsonb_build_object('ok', false, 'reason', 'over_exposure', 'exposure_paise', exposure, 'cap_paise', cap);
  end if;

  -- Stock: every line must be on the shelf, checked under the same transaction.
  for r in select * from jsonb_array_elements(p_rows) loop
    select stock_qty into have from products where id = (r ->> 'product_id')::uuid and merchant_id = p_merchant for update;
    if not found or have < (r ->> 'qty')::int then
      return jsonb_build_object('ok', false, 'reason', 'out_of_stock');
    end if;
  end loop;

  insert into credit_entries (merchant_id, customer_id, kind, amount_paise, note, due_at, ref, created_by)
  values (p_merchant, p_customer, 'sale', total, p_note, now() + make_interval(days => cust.credit_terms_days), p_ref, p_by)
  returning id into entry;

  for r in select * from jsonb_array_elements(p_rows) loop
    insert into sales (merchant_id, product_id, qty, amount_paise, source, razorpay_payment_id)
    values (p_merchant, (r ->> 'product_id')::uuid, (r ->> 'qty')::int, (r ->> 'amount_paise')::bigint, 'manual',
            'credit_' || entry::text || case when idx = 0 then '' else '#' || idx end);
    update products set stock_qty = stock_qty - (r ->> 'qty')::int, last_sold_at = now()
     where id = (r ->> 'product_id')::uuid and merchant_id = p_merchant;
    idx := idx + 1;
  end loop;

  return jsonb_build_object('ok', true, 'entry_id', entry, 'owed_paise', owed + total);
end;
$$;

-- ── The customer pays (all or part) ─────────────────────────────────────────
create or replace function record_credit_payment(
  p_merchant uuid,
  p_customer uuid,
  p_amount bigint,
  p_note text,
  p_ref text,
  p_by text,
  p_simulated boolean
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  owed bigint;
  entry uuid;
begin
  perform 1 from customers where id = p_customer and merchant_id = p_merchant for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_customer'); end if;
  if p_amount is null or p_amount <= 0 then return jsonb_build_object('ok', false, 'reason', 'empty'); end if;

  if p_ref is not null then
    select id into entry from credit_entries where merchant_id = p_merchant and ref = p_ref;
    if found then return jsonb_build_object('ok', true, 'duplicate', true, 'entry_id', entry); end if;
  end if;

  owed := credit_balance(p_merchant, p_customer);
  if p_amount > owed then return jsonb_build_object('ok', false, 'reason', 'more_than_owed', 'owed_paise', owed); end if;

  insert into credit_entries (merchant_id, customer_id, kind, amount_paise, note, ref, created_by)
  values (p_merchant, p_customer, 'payment', p_amount, p_note, p_ref, p_by) returning id into entry;

  insert into wallet_entries (merchant_id, direction, amount_paise, kind, ref_type, ref_id, note, simulated)
  values (p_merchant, 'credit', p_amount, 'sale', 'khata', entry, coalesce(p_note, 'Credit payment received'), p_simulated);

  -- Revenue is counted when the cash arrives. No product, so units are not counted twice.
  insert into sales (merchant_id, product_id, qty, amount_paise, source, razorpay_payment_id)
  values (p_merchant, null, 1, p_amount, 'manual', 'khatapay_' || entry::text);

  return jsonb_build_object('ok', true, 'entry_id', entry, 'owed_paise', owed - p_amount);
end;
$$;

-- ── Give up on an amount ────────────────────────────────────────────────────
create or replace function write_off_credit(
  p_merchant uuid,
  p_customer uuid,
  p_amount bigint,
  p_note text,
  p_ref text,
  p_by text
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  owed bigint;
  entry uuid;
begin
  perform 1 from customers where id = p_customer and merchant_id = p_merchant for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_customer'); end if;
  if p_ref is not null then
    select id into entry from credit_entries where merchant_id = p_merchant and ref = p_ref;
    if found then return jsonb_build_object('ok', true, 'duplicate', true, 'entry_id', entry); end if;
  end if;
  owed := credit_balance(p_merchant, p_customer);
  if p_amount is null or p_amount <= 0 or p_amount > owed then return jsonb_build_object('ok', false, 'reason', 'more_than_owed', 'owed_paise', owed); end if;
  insert into credit_entries (merchant_id, customer_id, kind, amount_paise, note, ref, created_by)
  values (p_merchant, p_customer, 'writeoff', p_amount, p_note, p_ref, p_by) returning id into entry;
  return jsonb_build_object('ok', true, 'entry_id', entry, 'owed_paise', owed - p_amount);
end;
$$;
