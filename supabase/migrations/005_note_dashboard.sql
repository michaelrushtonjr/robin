-- Note Dashboard: living note architecture

-- Structured note (jsonb) — one per encounter, accumulates in real time
alter table public.encounters
  add column if not exists note jsonb,
  add column if not exists note_version integer default 1;
