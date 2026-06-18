-- ── Baker testimonials ────────────────────────────────────────────────────────
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- Customer reviews shown on the storefront. A collection (add/remove/reorder), so kept
-- in its own table rather than on `bakers`. Non-critical: a storefront with zero reviews
-- simply hides the section.
CREATE TABLE IF NOT EXISTS baker_testimonials (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  baker_id    uuid        NOT NULL REFERENCES bakers(id) ON DELETE CASCADE,
  quote       text        NOT NULL,
  author      text,
  occasion    text,
  sort_order  integer     NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS baker_testimonials_baker_idx
  ON baker_testimonials(baker_id, sort_order);
