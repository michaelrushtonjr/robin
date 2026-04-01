-- Add age and gender to encounters for patient identification
alter table public.encounters
  add column if not exists age integer,
  add column if not exists gender text check (gender in ('M', 'F', 'X', 'Unknown'));
