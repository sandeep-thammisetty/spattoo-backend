-- ── Storefront media ──────────────────────────────────────────────────────────
-- Run once in the Supabase SQL editor. Safe to re-run.

-- Baker portrait for the storefront "Our story" section. Single, stable, 1:1 with the
-- baker (like logo_url/story) — so it lives on bakers, not its own table.
ALTER TABLE bakers ADD COLUMN IF NOT EXISTS portrait_url text;

-- Gallery photos for the storefront slideshow. A growing, frequently-edited COLLECTION,
-- and non-critical (the storefront is valid with zero photos) — so it's kept OUT of the
-- bakers table in its own table, one row per photo, explicitly ordered.
CREATE TABLE IF NOT EXISTS baker_storefront_photos (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  baker_id    uuid        NOT NULL REFERENCES bakers(id) ON DELETE CASCADE,
  storage_key text        NOT NULL,                     -- R2 key under storefront/gallery/
  caption     text,
  sort_order  integer     NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS baker_storefront_photos_baker_idx
  ON baker_storefront_photos(baker_id, sort_order);
