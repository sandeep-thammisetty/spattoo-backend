create table jobs (
  id         uuid primary key default gen_random_uuid(),
  type       text not null,
  status     text not null default 'pending', -- pending | processing | done | failed
  payload    jsonb,
  result     jsonb,
  error      text,
  baker_id   uuid references bakers(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Speed up lookups by baker and status
create index on jobs (baker_id);
create index on jobs (status);

-- Supabase Realtime — enable for the jobs table
alter publication supabase_realtime add table jobs;
