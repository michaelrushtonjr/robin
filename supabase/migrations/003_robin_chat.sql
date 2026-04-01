-- Robin chat messages, persisted per shift
create table if not exists public.robin_messages (
  id uuid default gen_random_uuid() primary key,
  shift_id uuid references public.shifts(id) on delete cascade not null,
  role text check (role in ('user', 'assistant')) not null,
  content text not null,
  created_at timestamptz default now() not null
);

alter table public.robin_messages enable row level security;

create policy "Physicians can manage their own robin messages"
  on public.robin_messages
  for all
  using (
    shift_id in (
      select id from public.shifts
      where physician_id = auth.uid()
    )
  );

-- Physician preferences — persists across shifts
alter table public.physicians
  add column if not exists robin_preferences jsonb default '{}';

-- Per-shift Robin memory (running observations Robin builds during shift)
alter table public.shifts
  add column if not exists robin_memory jsonb default '{}';
