-- Voice-to-paper. A price a supplier gives in a voice note is only a draft: the
-- quote is recorded but not used to choose a supplier until the supplier has
-- confirmed it in writing.
alter table quotes
  add column if not exists via_voice boolean not null default false,
  add column if not exists voice_confirmed_at timestamptz;
