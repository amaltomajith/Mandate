-- Booking a payout that has gone out: the payout row and its wallet debit are one
-- transaction. They used to be two writes, so a failed debit left a payout row
-- behind, and the retry (which sees the row) concluded "already booked" and never
-- debited the wallet. Returns true when this call booked it, false when the
-- trace had already been booked (an approval retried, or a parallel duplicate).

create or replace function record_payout(
  p_merchant uuid,
  p_trace uuid,
  p_payee uuid,
  p_po uuid,
  p_amount bigint,
  p_status text,
  p_razorpay_payout_id text,
  p_simulated boolean,
  p_note text
) returns boolean
language plpgsql
set search_path = public
as $$
declare
  pid uuid;
begin
  begin
    insert into payouts (merchant_id, trace_id, payee_id, po_id, amount_paise, status, razorpay_payout_id, simulated)
    values (p_merchant, p_trace, p_payee, p_po, p_amount, p_status, p_razorpay_payout_id, p_simulated)
    returning id into pid;
  exception when unique_violation then
    return false;
  end;

  insert into wallet_entries (merchant_id, direction, amount_paise, kind, ref_type, ref_id, note, simulated)
  values (p_merchant, 'debit', p_amount, 'payout', 'payout', pid, p_note, p_simulated);
  return true;
end;
$$;

revoke all on function record_payout(uuid, uuid, uuid, uuid, bigint, text, text, boolean, text) from public, anon, authenticated;
grant execute on function record_payout(uuid, uuid, uuid, uuid, bigint, text, text, boolean, text) to service_role;
