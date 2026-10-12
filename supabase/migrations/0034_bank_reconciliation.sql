-- Bank-statement reconciliation. A merchant uploads a CSV from their bank; each
-- line is kept once (a re-upload adds nothing) and, when it can be tied to a
-- payout the merchant confirmed or a customer payment they recorded, says so.
-- Mandate never trusts the merchant's own "I paid" for the money's whereabouts
-- once the bank has spoken: a payout is either verified, or flagged.

create table if not exists bank_statement_rows (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id) on delete cascade,
  -- Hash of the line's own content plus its occurrence, so the same statement
  -- uploaded twice is one set of rows, while two genuine identical lines on one
  -- day stay two.
  row_key text not null,
  posted_on date not null,
  description text not null default '',
  debit_paise bigint not null default 0 check (debit_paise >= 0),
  credit_paise bigint not null default 0 check (credit_paise >= 0),
  ref text,
  -- What the line was tied to, if anything.
  matched_kind text check (matched_kind in ('payout', 'credit_payment')),
  matched_id uuid,
  match_strength text check (match_strength in ('reference', 'amount')),
  created_at timestamptz not null default now()
);
create unique index if not exists bank_rows_key on bank_statement_rows (merchant_id, row_key);
create index if not exists bank_rows_merchant_date on bank_statement_rows (merchant_id, posted_on desc);
alter table bank_statement_rows enable row level security;

alter table payouts
  add column if not exists bank_verified_at timestamptz,
  add column if not exists bank_row_id uuid references bank_statement_rows(id) on delete set null;
comment on column payouts.bank_verified_at is 'Set when a bank statement line matched this manual payout. Null means the merchant said they paid but no statement has shown it yet.';
