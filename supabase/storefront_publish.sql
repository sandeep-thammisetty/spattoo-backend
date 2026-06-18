-- ── Storefront publish status ─────────────────────────────────────────────────
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- A storefront is a DRAFT until the baker clicks Publish. While unpublished:
--   • the public page (GET /storefront/:slug) does not render, and
--   • the baker cannot invite customers.
-- The baker still edits + previews freely in the customiser; Publish flips this flag.
ALTER TABLE bakers ADD COLUMN IF NOT EXISTS storefront_published boolean NOT NULL DEFAULT false;

-- Convenience for the current test baker (pre-production) so its storefront stays live.
UPDATE bakers SET storefront_published = true WHERE slug = 'feelings-flavours';
