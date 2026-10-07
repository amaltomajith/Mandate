alter table threads add column if not exists meta jsonb not null default '{}'::jsonb;
alter table messages add column if not exists handled boolean not null default false;
alter table products add column if not exists compare_at_price_paise integer check (compare_at_price_paise is null or compare_at_price_paise > 0);
alter table customers add column if not exists phone text;
alter table customers add column if not exists marketing_opt_in boolean not null default false;
comment on column products.compare_at_price_paise is 'The price before a clearance discount. NULL when the product is at its normal price.';
comment on column customers.marketing_opt_in is 'The Selling agent may only contact customers who opted in.';
comment on column messages.handled is 'Inbound messages start unhandled; an agent marks them once it has acted on them.';
create index if not exists messages_unhandled_idx on messages (merchant_id, handled) where handled = false and direction = 'in';
