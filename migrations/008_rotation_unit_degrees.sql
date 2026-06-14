-- Migrate placement_config.rotation from RADIANS (legacy, un-flagged) to DEGREES + rotation_unit:'deg'.
--
-- Background: the cake designer's facing offset (placement_config.rotation) is now authored and
-- stored in DEGREES, tagged with rotation_unit:'deg', and read in spattoo-core via
-- facingOffsetRadians() (see spattoo-core/src/designer/PLACEMENT_CONFIG.md). Legacy rows wrote the
-- value in radians with no unit. The admin AddElement/ManageElements screens already write deg+flag
-- after the Phase-2 change; this migration brings existing rows onto the same convention.
--
-- Render-neutral: degToRad3(deg) equals the original radians modulo 2π, and the designer only feeds
-- the value into rotation matrices (2π-invariant), so the on-cake orientation does not change.
-- Inspection (2026-06-14) found exactly two rows carrying a rotation, both [-π/2, π, 0] rad
-- (the unicorn eyes); the query below is general so any other un-flagged row is handled too.

-- ── 1. PREVIEW — run this first and eyeball the rows that will change ──────────────────────────
-- SELECT id, name,
--        placement_config->'rotation'      AS rotation_before,
--        placement_config->'rotation_unit' AS unit_before
-- FROM cake_elements
-- WHERE jsonb_typeof(placement_config->'rotation') = 'array'
--   AND placement_config->'rotation_unit' IS NULL;

-- ── 2. MIGRATE — radians → degrees (normalized to [0,360), rounded) + rotation_unit:'deg' ──────
-- Idempotent: only touches array rotations that are not already unit-tagged. Array order is
-- preserved via WITH ORDINALITY.
UPDATE cake_elements AS ce
SET placement_config = ce.placement_config || jsonb_build_object(
      'rotation', conv.deg_rotation,
      'rotation_unit', 'deg'
    )
FROM (
  SELECT c.id,
         jsonb_agg(
           round(((((e.val_text::numeric * 180.0 / pi()::numeric) % 360) + 360) % 360))::int
           ORDER BY e.ord
         ) AS deg_rotation
  FROM cake_elements c
  CROSS JOIN LATERAL jsonb_array_elements_text(c.placement_config->'rotation')
    WITH ORDINALITY AS e(val_text, ord)
  WHERE jsonb_typeof(c.placement_config->'rotation') = 'array'
    AND c.placement_config->'rotation_unit' IS NULL
  GROUP BY c.id
) AS conv
WHERE ce.id = conv.id;

-- ── 3. VERIFY — after migrating, this should return zero rows ──────────────────────────────────
-- SELECT id, name FROM cake_elements
-- WHERE jsonb_typeof(placement_config->'rotation') = 'array'
--   AND placement_config->'rotation_unit' IS NULL;
