alter table merchant_settings
  add column if not exists payout_mode text not null default 'auto' check (payout_mode in ('auto', 'manual'));
comment on column merchant_settings.payout_mode is 'auto: pay suppliers through RazorpayX (or the labelled sandbox executor). manual: an approved payout becomes a task for the merchant to pay from their own bank and confirm.';

alter table payouts
  add column if not exists manual boolean not null default false,
  add column if not exists paid_ref text,
  add column if not exists paid_at timestamptz,
  add column if not exists confirmed_by text;
comment on column payouts.manual is 'True when the merchant pays this from their own bank and confirms it. The wallet is debited when they confirm, not when it is queued.';

alter table payees
  add column if not exists details_enc text;
comment on column payees.details_enc is 'Manual-payout payees only: the full account or UPI details, AES-GCM encrypted. Shown only to the signed-in merchant, to pay by hand. Null for RazorpayX payees, whose details live at Razorpay.';
