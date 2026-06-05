-- Byte size of each element's primary asset (GLB / 2D image).
-- Captured at upload time from the browser File object (no R2 round-trip) so the
-- Manage Elements screen can flag oversized files that need optimizing.
-- Procedural elements (3D Geometry) have no file → stays NULL.
-- Existing rows are backfilled once via scripts/backfillFileSizes.mjs (HEAD on R2).

ALTER TABLE cake_elements
  ADD COLUMN IF NOT EXISTS file_size bigint;
