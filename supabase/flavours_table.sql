create table if not exists flavours (
  id          uuid        primary key default gen_random_uuid(),
  name        text        not null,
  description text,
  sort_order  integer     not null default 0,
  is_active   boolean     not null default true,
  created_at  timestamptz not null default now()
);

create unique index if not exists flavours_name_key on flavours (lower(name));
