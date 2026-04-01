-- Robin Phase 1 Schema
-- Physicians, Shifts, Encounters with Row Level Security

-- Physicians profile (extends auth.users)
create table public.physicians (
  id uuid references auth.users on delete cascade primary key,
  display_name text not null,
  specialty text not null default 'Emergency Medicine',
  settings jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.physicians enable row level security;

create policy "Physicians can view own profile"
  on public.physicians for select
  using (auth.uid() = id);

create policy "Physicians can update own profile"
  on public.physicians for update
  using (auth.uid() = id);

create policy "Physicians can insert own profile"
  on public.physicians for insert
  with check (auth.uid() = id);

-- Auto-create physician profile on signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.physicians (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', new.email));
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Shifts
create table public.shifts (
  id uuid primary key default gen_random_uuid(),
  physician_id uuid references public.physicians(id) on delete cascade not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  status text not null default 'active' check (status in ('active', 'completed')),
  summary jsonb,
  created_at timestamptz not null default now()
);

alter table public.shifts enable row level security;

create policy "Physicians can view own shifts"
  on public.shifts for select
  using (auth.uid() = physician_id);

create policy "Physicians can insert own shifts"
  on public.shifts for insert
  with check (auth.uid() = physician_id);

create policy "Physicians can update own shifts"
  on public.shifts for update
  using (auth.uid() = physician_id);

-- Encounters
create table public.encounters (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid references public.shifts(id) on delete cascade not null,
  room text,
  chief_complaint text,
  status text not null default 'active' check (status in ('active', 'documenting', 'completed')),
  transcript text default '',
  generated_note text default '',
  mdm_data jsonb default '{}',
  ehr_mode text not null default 'epic' check (ehr_mode in ('epic', 'cerner')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.encounters enable row level security;

-- Encounters policies join through shifts to verify physician ownership
create policy "Physicians can view own encounters"
  on public.encounters for select
  using (
    exists (
      select 1 from public.shifts
      where shifts.id = encounters.shift_id
      and shifts.physician_id = auth.uid()
    )
  );

create policy "Physicians can insert own encounters"
  on public.encounters for insert
  with check (
    exists (
      select 1 from public.shifts
      where shifts.id = encounters.shift_id
      and shifts.physician_id = auth.uid()
    )
  );

create policy "Physicians can update own encounters"
  on public.encounters for update
  using (
    exists (
      select 1 from public.shifts
      where shifts.id = encounters.shift_id
      and shifts.physician_id = auth.uid()
    )
  );

-- Indexes
create index idx_shifts_physician on public.shifts(physician_id);
create index idx_shifts_status on public.shifts(status);
create index idx_encounters_shift on public.encounters(shift_id);
create index idx_encounters_status on public.encounters(status);
