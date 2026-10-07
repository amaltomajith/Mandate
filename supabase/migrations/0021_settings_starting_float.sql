alter table merchant_settings
  add column if not exists starting_float_paise bigint not null default 2500000 check (starting_float_paise >= 0);
comment on column merchant_settings.starting_float_paise is
  'Payout allowance that exists before any sales do. The payout budget is this plus a share of revenue, capped by the weekly ceiling.';
