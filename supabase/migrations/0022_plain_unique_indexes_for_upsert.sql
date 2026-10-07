-- PostgREST upserts (on_conflict=<columns>) cannot target a partial unique index.
-- These were partial ("where x is not null"); plain unique indexes behave the same
-- for our purposes, because Postgres treats NULLs as distinct in a unique index.
drop index if exists payouts_trace_key;
create unique index payouts_trace_key on payouts (trace_id);
drop index if exists sales_payment_key;
create unique index sales_payment_key on sales (merchant_id, razorpay_payment_id);
drop index if exists threads_external_key;
create unique index threads_external_key on threads (merchant_id, channel, external_thread_id);
drop index if exists messages_external_key;
create unique index messages_external_key on messages (merchant_id, thread_id, external_id);
