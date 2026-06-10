-- Baker "craft guide" sidecar for piping elements, consumed by the X-Ray
-- order-help feature. Kept OUT of cake_elements.placement_config on purpose:
-- placement_config is a hot path (parsed every time an element is built on the
-- canvas), whereas craft-guide data is cold (read only when a baker opens X-Ray
-- on one order). One row per atomic piping building block; a piping_pattern
-- inherits its nozzles by unioning the rows of its constituent blocks.

create table element_craft_guide (
  element_id   uuid        primary key references cake_elements(id) on delete cascade,
  nozzle_recs  jsonb       not null default '[]'::jsonb,
  consistency  text,
  technique    text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table element_craft_guide is
  'Baker how-to-make-it metadata for piping elements, read by the X-Ray order-help feature. Sidecar to cake_elements so the canvas hot path never loads it.';
comment on column element_craft_guide.nozzle_recs is
  'Recommended piping tips across brands: [{ brand, number, name }]. A pattern element unions the recs of its building-block parts.';
comment on column element_craft_guide.consistency is
  'Recommended buttercream consistency for this piping: stiff | medium | soft.';
comment on column element_craft_guide.technique is
  'One-line technique tip (tip angle, pressure, pull-away).';

-- ── Row-level security ────────────────────────────────────────────────────────

alter table element_craft_guide enable row level security;

-- Anyone authenticated can read (bakers viewing X-Ray, admins authoring).
create policy "element_craft_guide_read"
  on element_craft_guide for select
  to authenticated
  using (true);

-- Only authenticated users (admins) can write.
create policy "element_craft_guide_insert"
  on element_craft_guide for insert
  to authenticated
  with check (true);

create policy "element_craft_guide_update"
  on element_craft_guide for update
  to authenticated
  using (true);

create policy "element_craft_guide_delete"
  on element_craft_guide for delete
  to authenticated
  using (true);
