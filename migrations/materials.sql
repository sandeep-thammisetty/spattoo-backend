-- Materials: the DB-authored overlay for the cake-body frosting MATERIAL axis (buttercream / whipped /
-- fondant). The material's bespoke PHYSICS (MeshPhysical recipe, grain, edge) stays a code SEED in
-- spattoo-core/src/designer/frostings.js — a shader recipe can't live in a row. This table overlays the
-- CONFIGURABLE parts keyed by `key`: the ordered list of styles the material offers (+ label, enabled).
--
-- MATERIAL IS THE PARENT of the material→style relationship. `config.styles` is an ORDERED array of
-- cake_textures.key values — a direct lookup (the designer resolves only a material's own listed keys,
-- never scans all styles → scales to many styles). `smooth` is the IMPLICIT, always-first default for
-- every material and is NEVER stored here; an empty array = "smooth only" (fondant today).
--
-- Why an array column, not a join table: the hot access pattern is one-directional & ordered
-- (material → its styles, in display order). An array gives native ordering + single-row reads with no
-- join. The only downside — a dropped style leaving a dangling key — is neutralised on READ: the
-- designer filters to keys that resolve to a loaded (active) texture, and textures are soft-deleted
-- (is_active=false), so a key never truly dangles. A join table's bidirectional/FK benefits are wasted
-- here (the reverse "which materials offer style X" query is rare, the set is tiny). Revisit a join
-- table only if the pairing gains its own attributes or that reverse query becomes hot.
--
--   config.styles: ['wave','swirl','rustic']   -- ordered cake_textures keys; smooth implicit/first

create table materials (
  id         uuid        primary key default gen_random_uuid(),
  key        text        not null unique,            -- frosting material key: 'buttercream' | 'whipped' | 'fondant'
  label      text        not null,                   -- picker label
  config     jsonb       not null default '{}'::jsonb,
  is_active  boolean     not null default true,
  sort_order integer     not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index materials_active_idx on materials(is_active, sort_order);

alter table materials enable row level security;
create policy "materials_read"  on materials for select to authenticated using (true);
create policy "materials_write" on materials for all    to authenticated using (true) with check (true);

-- Seed mirrors today's hardcoded behaviour (frostings.js capabilities.styles): cream materials offer
-- every non-smooth style; fondant offers none (smooth only).
insert into materials (key, label, config, sort_order) values
  ('buttercream', 'Buttercream', '{"styles":["wave","swirl","rustic"]}'::jsonb, 0),
  ('whipped',     'Whipped',     '{"styles":["wave","swirl","rustic"]}'::jsonb, 1),
  ('fondant',     'Fondant',     '{"styles":[]}'::jsonb,                         2);
