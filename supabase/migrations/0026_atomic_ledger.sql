-- Money movements that used to be several separate writes are now single
-- transactions. A failure part-way used to leave a sale with no wallet credit
-- (and Razorpay's retry then saw the sale and stopped), a refunded payout that
-- was credited twice, or a payout marked paid with no debit. Each function below
-- is all-or-nothing, and the row locks make them exactly-once under parallel
-- calls. Called only by the service role.

-- ── A captured payment: sale lines, stock, wallet credit ────────────────────
-- p_rows: [{ "product_id": uuid|null, "qty": int, "amount_paise": bigint }]
-- Returns true when booked, false when this payment was already booked.
create or replace function book_captured_payment(
  p_merchant uuid,
  p_payment_id text,
  p_order_id text,
  p_source text,
  p_amount bigint,
  p_simulated boolean,
  p_note text,
  p_rows jsonb
) returns boolean
language plpgsql
set search_path = public
as $$
declare
  r jsonb;
  idx int := 0;
  total bigint := 0;
begin
  if exists (select 1 from sales where merchant_id = p_merchant and razorpay_payment_id = p_payment_id) then
    return false;
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    total := total + (r ->> 'amount_paise')::bigint;
    -- One payment id per payment; extra lines get a suffix so the unique key holds.
    -- A concurrent duplicate hits sales_payment_key and aborts this whole call.
    insert into sales (merchant_id, product_id, qty, amount_paise, source, razorpay_payment_id, razorpay_order_id)
    values (
      p_merchant,
      nullif(r ->> 'product_id', '')::uuid,
      (r ->> 'qty')::int,
      (r ->> 'amount_paise')::bigint,
      p_source,
      case when idx = 0 then p_payment_id else p_payment_id || '#' || idx end,
      p_order_id
    );
    idx := idx + 1;
  end loop;

  if total <> p_amount then
    raise exception 'sale lines (%) do not add up to the payment (%)', total, p_amount;
  end if;

  -- Guarded relative update: parallel sales of the same product cannot overwrite
  -- each other's decrement, and stock never goes below zero.
  update products p
     set stock_qty = greatest(0, p.stock_qty - s.qty), last_sold_at = now()
    from (
      select (x ->> 'product_id')::uuid as product_id, sum((x ->> 'qty')::int) as qty
        from jsonb_array_elements(p_rows) x
       where nullif(x ->> 'product_id', '') is not null
       group by 1
    ) s
   where p.id = s.product_id and p.merchant_id = p_merchant;

  if p_amount > 0 then
    insert into wallet_entries (merchant_id, direction, amount_paise, kind, ref_type, note, simulated)
    values (p_merchant, 'credit', p_amount, 'sale', 'payment', p_note, p_simulated);
  end if;
  return true;
end;
$$;

-- ── A payout's status moves forward; a failure or reversal credits back once ─
create or replace function apply_payout_status(
  p_merchant uuid,
  p_razorpay_payout_id text,
  p_status text
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  row payouts%rowtype;
  rank_old int;
  rank_new int;
begin
  select * into row from payouts
   where merchant_id = p_merchant and razorpay_payout_id = p_razorpay_payout_id
   for update;
  if not found then
    return jsonb_build_object('found', false);
  end if;

  rank_old := case row.status when 'queued' then 0 when 'processing' then 1 when 'processed' then 2 when 'failed' then 2 when 'reversed' then 3 else 0 end;
  rank_new := case p_status when 'queued' then 0 when 'processing' then 1 when 'processed' then 2 when 'failed' then 2 when 'reversed' then 3 else 0 end;
  -- Webhooks arrive out of order: a status only ever moves forward.
  if rank_new <= rank_old then
    return jsonb_build_object('found', true, 'stale', true);
  end if;

  update payouts set status = p_status where id = row.id;

  if p_status in ('failed', 'reversed') and row.status not in ('failed', 'reversed') then
    insert into wallet_entries (merchant_id, direction, amount_paise, kind, ref_type, ref_id, note)
    values (p_merchant, 'credit', row.amount_paise, 'refund', 'payout', row.id, 'Payout ' || p_status);
    if row.po_id is not null then
      update purchase_orders
         set status = 'draft', rationale = 'Payout ' || p_status || '. Check the supplier''s payment details and retry.'
       where id = row.po_id and merchant_id = p_merchant;
    end if;
    insert into alerts (merchant_id, trace_id, severity, message)
    values (p_merchant, null, 'high', 'A payout to a supplier ' || p_status || '. The amount was returned to your wallet and the order is back to draft.');
    return jsonb_build_object('found', true, 'refunded', true);
  end if;
  return jsonb_build_object('found', true, 'ok', true);
end;
$$;

-- Backstops: one refund per payout, one debit per payout, whatever the code does.
create unique index if not exists wallet_refund_once
  on wallet_entries (merchant_id, ref_id) where kind = 'refund' and ref_type = 'payout';
create unique index if not exists wallet_payout_debit_once
  on wallet_entries (merchant_id, ref_id) where kind = 'payout' and ref_type = 'payout';

-- ── The merchant says they paid by hand: claim, debit, mark the order ───────
create or replace function confirm_manual_payout(
  p_merchant uuid,
  p_payout uuid,
  p_by text,
  p_ref text
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  claimed record;
  payee_name text;
  covered bigint;
  advance bigint;
begin
  -- Claim first, conditional on `queued`: a double click or two tabs cannot debit twice.
  update payouts
     set status = 'processed', paid_at = now(), paid_ref = p_ref, confirmed_by = p_by
   where id = p_payout and merchant_id = p_merchant and manual and status = 'queued'
  returning id, amount_paise, po_id, payee_id into claimed;
  if not found then
    return jsonb_build_object('confirmed', false);
  end if;

  select display_name into payee_name from payees where id = claimed.payee_id;

  insert into wallet_entries (merchant_id, direction, amount_paise, kind, ref_type, ref_id, note, simulated)
  values (
    p_merchant, 'debit', claimed.amount_paise, 'payout', 'payout', claimed.id,
    'Paid ' || coalesce(payee_name, 'a supplier') || ' by hand' || case when p_ref is not null then ' (ref ' || p_ref || ')' else '' end,
    false
  );

  if claimed.po_id is not null then
    select advance_paise into advance from purchase_orders where id = claimed.po_id and merchant_id = p_merchant;
    select coalesce(sum(amount_paise), 0) into covered from payouts
     where merchant_id = p_merchant and po_id = claimed.po_id and status = 'processed';
    if advance is not null and covered >= advance then
      update purchase_orders set status = 'paid'
       where id = claimed.po_id and merchant_id = p_merchant
         and status in ('draft', 'quoting', 'awaiting_approval', 'approved');
    end if;
  end if;

  insert into alerts (merchant_id, trace_id, severity, message)
  values (p_merchant, null, 'info', 'You confirmed paying ' || coalesce(payee_name, 'a supplier') || '. The wallet has been updated and the supplier will be told.');
  return jsonb_build_object('confirmed', true);
end;
$$;

revoke all on function book_captured_payment(uuid, text, text, text, bigint, boolean, text, jsonb) from public, anon, authenticated;
revoke all on function apply_payout_status(uuid, text, text) from public, anon, authenticated;
revoke all on function confirm_manual_payout(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function book_captured_payment(uuid, text, text, text, bigint, boolean, text, jsonb) to service_role;
grant execute on function apply_payout_status(uuid, text, text) to service_role;
grant execute on function confirm_manual_payout(uuid, uuid, text, text) to service_role;
