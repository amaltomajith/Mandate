-- Mandate — illustrative live risk score
-- A nullable, purely informational column: an amount-driven approximation
-- from the Track 02 fraud-spike detector (src/lib/risk/), computed with
-- mean-imputation for every feature that model needs but a Razorpay
-- transaction can't supply (see src/lib/risk/scoreLiveTransaction.ts for the
-- full honesty caveats). Never read by the policy engine — populated after
-- the real decision is already made, never before it.

alter table traces add column if not exists illustrative_risk_score numeric;
