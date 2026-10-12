-- Goods received. Marking an order received used to add the full ordered quantity
-- to stock and forget it. Now a receipt records what actually arrived, when, and
-- at what price, atomically with the stock change, so a short shipment, a late one
-- or a price that crept up is on the record and feeds the supplier's scorecard.

create table if not exists po_receipts (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id) on delete cascade,
  po_id uuid not null references purchase_orders(id) on delete cascade,
  vendor_id uuid not null references vendors(id) on delete cascade,
  ordered_qty integer not null check (ordered_qty > 0),
  received_qty integer not null check (received_qty >= 0),
  -- received / ordered, in basis points (10000 = everything arrived).
  fill_bps integer not null check (fill_bps between 0 and 10000),
  -- (invoice price - ordered price) over ordered price, on what arrived. Positive = dearer.
  price_drift_bps integer not null default 0,
  on_time boolean not null,
  days_late integer not null default 0 check (days_late >= 0),
  lines jsonb not null default '[]'::jsonb,
  note text,
  received_by text,
  received_at timestamptz not null default now()
);
create unique index if not exists po_receipts_po_key on po_receipts (po_id);
create index if not exists po_receipts_vendor_idx on po_receipts (merchant_id, vendor_id, received_at desc);
alter table po_receipts enable row level security;

alter table merchant_settings
  add column if not exists festival_buffer boolean not null default false;
comment on column merchant_settings.festival_buffer is 'When true, supplier lead times are lengthened around major festivals (suppliers close or slow down), so restock is triggered earlier.';

-- p_lines: [{ "product_id": uuid, "received_qty": int, "unit_price_paise": int|null }]
-- An empty list means everything arrived as ordered, at the ordered price.
create or replace function receive_purchase_order(
  p_merchant uuid,
  p_po uuid,
  p_lines jsonb,
  p_by text,
  p_note text
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  po purchase_orders%rowtype;
  l record;
  given jsonb;
  rq int;
  ip int;
  ordered_total int := 0;
  received_total int := 0;
  ordered_value numeric := 0;
  drift_value numeric := 0;
  fill int;
  drift int;
  late int := 0;
  is_on_time boolean := true;
  detail jsonb := '[]'::jsonb;
  receipt uuid;
  vname text;
begin
  select * into po from purchase_orders where id = p_po and merchant_id = p_merchant for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_order'); end if;
  if po.status = 'received' then return jsonb_build_object('ok', false, 'reason', 'already_received'); end if;
  if po.status not in ('paid', 'approved') then return jsonb_build_object('ok', false, 'reason', 'not_receivable'); end if;

  -- Every line given must be one of this order's lines.
  for given in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    if not exists (select 1 from po_lines where po_id = p_po and merchant_id = p_merchant and product_id = nullif(given ->> 'product_id', '')::uuid) then
      return jsonb_build_object('ok', false, 'reason', 'unknown_line');
    end if;
  end loop;

  for l in select product_id, sum(qty)::int as qty, max(unit_price_paise)::int as price from po_lines where po_id = p_po and merchant_id = p_merchant group by product_id loop
    select g into given from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) g where nullif(g ->> 'product_id', '')::uuid = l.product_id limit 1;
    rq := coalesce((given ->> 'received_qty')::int, l.qty);
    ip := coalesce(nullif(given ->> 'unit_price_paise', '')::int, l.price);
    if rq < 0 then return jsonb_build_object('ok', false, 'reason', 'bad_quantity'); end if;
    if rq > l.qty then return jsonb_build_object('ok', false, 'reason', 'over_received'); end if;
    if ip <= 0 then return jsonb_build_object('ok', false, 'reason', 'bad_price'); end if;

    ordered_total := ordered_total + l.qty;
    received_total := received_total + rq;
    ordered_value := ordered_value + (l.price::numeric * rq);
    drift_value := drift_value + ((ip - l.price)::numeric * rq);
    detail := detail || jsonb_build_array(jsonb_build_object('product_id', l.product_id, 'ordered_qty', l.qty, 'received_qty', rq, 'ordered_price_paise', l.price, 'invoice_price_paise', ip));

    if rq > 0 then
      update products set stock_qty = stock_qty + rq where id = l.product_id and merchant_id = p_merchant;
    end if;
  end loop;

  if ordered_total = 0 then return jsonb_build_object('ok', false, 'reason', 'empty_order'); end if;

  fill := (received_total::numeric * 10000 / ordered_total)::int;
  drift := case when ordered_value > 0 then round(drift_value * 10000 / ordered_value)::int else 0 end;
  if po.expected_at is not null and now() > po.expected_at + interval '1 day' then
    is_on_time := false;
    late := greatest(1, floor(extract(epoch from (now() - po.expected_at)) / 86400)::int);
  end if;

  update purchase_orders set status = 'received', received_at = now() where id = p_po;

  insert into po_receipts (merchant_id, po_id, vendor_id, ordered_qty, received_qty, fill_bps, price_drift_bps, on_time, days_late, lines, note, received_by)
  values (p_merchant, p_po, po.vendor_id, ordered_total, received_total, fill, drift, is_on_time, late, detail, nullif(left(coalesce(p_note, ''), 500), ''), p_by)
  returning id into receipt;

  select name into vname from vendors where id = po.vendor_id;
  if received_total < ordered_total then
    insert into alerts (merchant_id, trace_id, severity, message)
    values (p_merchant, null, 'notable', coalesce(vname, 'A supplier') || ' delivered ' || received_total || ' of ' || ordered_total || ' units ordered. The rest was not added to stock.');
  end if;
  if drift > 200 then
    insert into alerts (merchant_id, trace_id, severity, message)
    values (p_merchant, null, 'notable', coalesce(vname, 'A supplier') || ' invoiced about ' || round(drift / 100.0, 1) || '% more than the agreed price.');
  end if;

  return jsonb_build_object('ok', true, 'receipt_id', receipt, 'vendor_id', po.vendor_id, 'fill_bps', fill, 'price_drift_bps', drift, 'on_time', is_on_time, 'days_late', late);
end;
$$;

revoke all on function receive_purchase_order(uuid, uuid, jsonb, text, text) from public, anon, authenticated;
grant execute on function receive_purchase_order(uuid, uuid, jsonb, text, text) to service_role;
