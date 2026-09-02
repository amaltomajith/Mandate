-- Mandate — the counter-offer re-entry guard
--
-- MRTR resumes by retrying the ORIGINAL tools/call. The retry is a fresh signed
-- POST, which is exactly what makes the protocol safe — but it also means the
-- retry can be sent twice. Two identical, individually valid retries would
-- otherwise execute the same logical purchase twice.
--
-- A check-then-execute guard in application code loses that race: two retries
-- arriving together both read "not yet consumed" before either writes. So the
-- guard is a uniqueness constraint, which the database resolves atomically no
-- matter how many instances are serving.
--
-- Each counter-offer mints an `offerId` into its sealed requestState. The
-- executing trace carries it. A second retry echoing the same state collides
-- here and is refused as a replay rather than becoming a second order.
--
-- Partial, on `params->>'offer_id'`, so it constrains only traces that carry
-- one: ordinary actions have no offer id and are entirely unaffected. Scoped by
-- merchant like everything else, though the offer id is a uuid and would not
-- collide across tenants anyway — the scope is there so the index matches how
-- every other query reads this table.

create unique index if not exists traces_offer_id_key
  on traces (merchant_id, (params ->> 'offer_id'))
  where params ->> 'offer_id' is not null;
