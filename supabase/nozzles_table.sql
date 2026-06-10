-- Piping-nozzle catalog: the vetted reference list of real decorating tips.
-- Curated only by internal admin (no baker/customer writes). Two consumers:
--   1) grounds the GPT "suggest craft guide" prompt so it picks real tip numbers
--      instead of hallucinating them;
--   2) a future baker-facing learning screen (nozzle + sample output image).
-- An element's element_craft_guide.nozzle_recs stores chosen entries denormalized
-- ({ nozzle_id, brand, number, name }), so renames here don't rewrite history.

create table nozzles (
  id               uuid        primary key default gen_random_uuid(),
  brand            text        not null,        -- Wilton, Ateco, PME, …
  number           text        not null,        -- '1M', '104', '844'
  name             text,                         -- 'Open Star', 'Petal Tip'
  category         text        not null,         -- open_star | closed_star | round | petal |
                                                 --   leaf | drop_flower | french | basketweave |
                                                 --   ruffle | writing | grass | specialty
  description      text,                         -- what it produces / typical use
  sample_image_url text,                         -- R2 key for the learning screen (nullable)
  is_common        boolean     not null default false,  -- go-to tip? biases GPT + features in learning screen
  sort_order       integer     not null default 0,
  is_active        boolean     not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (brand, number)
);

comment on table nozzles is
  'Vetted catalog of real piping tips. Grounds the GPT craft-guide suggester and feeds a future baker nozzle-learning screen. Internal-admin curated.';
comment on column nozzles.category is
  'Shape class the tip produces. Groups equivalents across brands for GPT matching and the learning screen.';
comment on column nozzles.sample_image_url is
  'R2 key of a sample-output image for the baker learning screen. Nullable; populated over time.';

create index on nozzles (category);
create index on nozzles (is_active);
create index on nozzles (is_common);

-- ── Row-level security ────────────────────────────────────────────────────────

alter table nozzles enable row level security;

-- Any authenticated user can read (admins authoring, and the future baker
-- learning screen). Not public-anon — there's no unauthenticated consumer.
create policy "nozzles_read"
  on nozzles for select
  to authenticated
  using (true);

-- Only authenticated users (admins) can write.
create policy "nozzles_insert"
  on nozzles for insert
  to authenticated
  with check (true);

create policy "nozzles_update"
  on nozzles for update
  to authenticated
  using (true);

create policy "nozzles_delete"
  on nozzles for delete
  to authenticated
  using (true);
