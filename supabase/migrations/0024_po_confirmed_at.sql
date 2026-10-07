alter table purchase_orders add column if not exists confirmed_at timestamptz;
comment on column purchase_orders.confirmed_at is 'When the supplier was told the order is confirmed and paid. NULL until the Buying agent has sent that message, so it is sent exactly once even if a human approves the payout later.';
