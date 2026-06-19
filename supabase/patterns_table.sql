-- Faux-ball patterns created in the PatternBuilder admin tool.
-- Each row stores a named, reusable arrangement of ball placements that
-- the CakeDesigner can apply as a decoration sticker.

create table patterns (
  id          uuid        primary key default gen_random_uuid(),
  name        text        not null,
  slug        text        not null unique,
  placements  jsonb       not null default '[]'::jsonb,
  tier_count  integer     not null default 1,
  created_at  timestamptz not null default now()
);

comment on table patterns is
  'Named faux-ball placement configurations created in the PatternBuilder admin tool.';
comment on column patterns.placements is
  'Array of ball placement objects: { id, surface, tierId, r, color, thetaOffset, rdInset?, yFromTop?, parentA?, parentB?, gapAngle?, heightOffset? }';
comment on column patterns.tier_count is
  'Number of tiers this pattern was designed for (1–4). Used as a hint in the designer.';

create index on patterns (slug);

-- ── Row-level security ────────────────────────────────────────────────────────

alter table patterns enable row level security;

-- Anyone can read patterns (the public designer fetches them unauthenticated).
create policy "patterns_public_read"
  on patterns for select
  using (true);

-- Only authenticated users (admins) can write.
create policy "patterns_admin_insert"
  on patterns for insert
  to authenticated
  with check (true);

create policy "patterns_admin_update"
  on patterns for update
  to authenticated
  using (true);

create policy "patterns_admin_delete"
  on patterns for delete
  to authenticated
  using (true);
