-- What an accountant needs to turn Mandate's records into GST returns: an HSN
-- code and a GST rate per product, and a GSTIN per supplier. All optional; the
-- exports flag whatever is missing instead of guessing it.
alter table products
  add column if not exists hsn_code text check (hsn_code is null or hsn_code ~ '^([0-9]{4}|[0-9]{6}|[0-9]{8})$'),
  add column if not exists gst_rate_bps integer check (gst_rate_bps is null or gst_rate_bps between 0 and 4000);
comment on column products.gst_rate_bps is 'GST rate in basis points (1800 = 18%). Null = not set yet; selling prices are treated as GST-inclusive.';

alter table vendors
  add column if not exists gstin text check (gstin is null or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$');
