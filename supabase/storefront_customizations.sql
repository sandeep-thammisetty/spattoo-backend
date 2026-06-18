-- ── Storefront customizations ─────────────────────────────────────────────────
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- A small map of baker-editable storefront TEXT (section headings + the hero tagline),
-- e.g. { "hero_tagline": "...", "creations_heading": "...", "story_heading": "...",
-- "reviews_heading": "..." }. Empty/missing keys fall back to built-in defaults in the
-- storefront component. Public-facing, so kept separate from the private `settings` blob.
ALTER TABLE bakers ADD COLUMN IF NOT EXISTS storefront_customizations jsonb NOT NULL DEFAULT '{}'::jsonb;
