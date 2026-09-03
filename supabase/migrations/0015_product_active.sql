-- Products become a managed table: a merchant can retire a SKU without
-- destroying the history that references it.
--
-- Deactivation rather than deletion is the whole point. Traces record a SKU in
-- `params.notes.sku`, and the audit trail is the product -- hard-deleting a row
-- that appears in it either orphans those traces or, with a cascade, quietly
-- destroys the record of sales that really happened. An inactive product
-- disappears from the agent-facing catalog, from counter-offer candidates and
-- from campaign planning, while every past trace still resolves to a name.
--
-- Hard delete stays available in the one case where it is safe: a product with
-- no traces at all. Nothing to orphan, nothing to lose.
alter table products
  add column if not exists active boolean not null default true;

comment on column products.active is
  'False retires a product: it leaves the public /catalog, counter-offer candidates and campaign planning, but past traces still resolve to its name. Prefer this to deletion -- traces reference SKUs, and deleting one that appears in the audit trail destroys or orphans real history.';

-- Every read that means "what can be bought right now" filters on this, so it
-- is worth an index once a catalog is more than a handful of rows.
create index if not exists products_merchant_active_idx
  on products (merchant_id, active);
