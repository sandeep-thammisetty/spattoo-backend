-- Cake textures: the DB-authored config for cream "style" finishes (wave / swirl / rustic …).
-- This is the placement_config analog for the cake base — the designer's in-code registry
-- (spattoo-core/src/designer/creamStyles.js) is the SEED/fallback; rows here override it and can add
-- new variants without a code change. `algorithm` is a KEY into the code's displacement strategies
-- (the data↔code seam) — a brand-new look still needs a new strategy in code, but tuning any existing
-- one (params, ranges, which are user-facing, label) is pure config here.
--
--   config.params: [{ key, label, min, max, step, default, user }]
--     default — the value the geometry uses; user=true → surfaced in the customer designer.

create table cake_textures (
  id         uuid        primary key default gen_random_uuid(),
  key        text        not null unique,            -- style value, e.g. 'wave'
  label      text        not null,                   -- picker label
  algorithm  text        not null,                   -- code strategy key, e.g. 'wave' | 'swirl' | 'rustic'
  config     jsonb       not null default '{}'::jsonb,
  is_active  boolean     not null default true,
  sort_order integer     not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index cake_textures_active_idx on cake_textures(is_active, sort_order);

alter table cake_textures enable row level security;
create policy "cake_textures_read"  on cake_textures for select to authenticated using (true);
create policy "cake_textures_write" on cake_textures for all    to authenticated using (true) with check (true);
