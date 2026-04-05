-- Layer 1: Ambient Command — encounter columns + robin_actions audit table

-- New encounter columns for Robin-created encounters and disposition
alter table public.encounters
  add column if not exists created_by_robin boolean default false,
  add column if not exists disposition text,
  add column if not exists accepting_physician text,
  add column if not exists patient_name text;

-- Robin actions audit log — every autonomous write is recorded here
create table if not exists public.robin_actions (
  id                      uuid primary key default gen_random_uuid(),
  shift_id                uuid references public.shifts(id) on delete cascade,
  encounter_id            uuid references public.encounters(id) on delete cascade,
  action_type             text not null,
  raw_command             text not null,
  parsed_payload          jsonb,
  confidence              float,
  confirmed_by_physician  boolean,
  previous_state          jsonb,
  note_section_affected   text,
  created_at              timestamptz default now() not null
);

alter table public.robin_actions enable row level security;

create policy "Physicians can manage their own robin actions"
  on public.robin_actions
  for all
  using (
    shift_id in (
      select id from public.shifts
      where physician_id = auth.uid()
    )
  );
