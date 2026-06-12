#!/usr/bin/env node
/**
 * Backfill placement_config for existing "hero" elements (toppers, top&side decor).
 *
 * The designer's placement STYLE is config-driven, never inferred from element type
 * (spattoo-core INVARIANTS.md rule #4). Until now the `single_per_slot` flag (and the
 * topper's stand/hug/facing defaults) were SYNTHESIZED at load time by a type→config
 * map in CakeDesigner.loadElementsIfNeeded. Admin can now set `single_per_slot`
 * directly, so we bake the same values onto the existing rows once. After this runs,
 * that load-time map fires on nothing — it degrades to a pure safety net.
 *
 * Mirrors the load-time backfill EXACTLY (merge-not-clobber: any value already on the
 * row wins), so behavior in the designer is unchanged for every existing element.
 *
 * NOTE on rotation: the topper facing `[0, -π/2, 0]` is RADIANS — that's what the
 * sticker path reads (THREE.Euler(...)). It is a global facing constant, not a
 * per-element value, so it stays owned by the load-time backfill too; we write it here
 * only to keep already-migrated rows self-describing. (Admin's front-view tool writes
 * this field in DEGREES — a separate, pre-existing mismatch; do not "fix" it by
 * re-orienting toppers until that's reconciled and visually verified.)
 *
 * Usage:
 *   SUPABASE_URL=...  SUPABASE_SERVICE_KEY=...  node scripts/backfillHeroPlacement.mjs
 *
 * Options (env vars):
 *   DRY_RUN=1   — print what would change, don't write
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const DRY_RUN      = process.env.DRY_RUN === '1';

for (const v of ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY']) {
  if (!process.env[v]) { console.error(`Missing ${v}`); process.exit(1); }
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const TOPPER_FACING = [0, -Math.PI / 2, 0];   // radians — matches the sticker path + load-time backfill

// Defaults to merge UNDER the row's own config (existing keys always win), per type slug.
// Keep these identical to CakeDesigner.loadElementsIfNeeded.
const DEFAULTS = {
  topper:           { single_per_slot: true, top_surface: 'stand', side: 'hug', rotation: TOPPER_FACING },
  top_side_decors:  { single_per_slot: true },
};

function shallowEqual(a, b) {
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(k => JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

async function run() {
  console.log(`Backfilling hero placement_config  [dry_run=${DRY_RUN}]\n`);

  const { data: types, error: tErr } = await supabase
    .from('element_types')
    .select('id, slug')
    .in('slug', Object.keys(DEFAULTS));
  if (tErr) { console.error(tErr.message); process.exit(1); }

  const slugById = new Map(types.map(t => [t.id, t.slug]));
  if (slugById.size === 0) { console.log('No topper/top_side_decors element types found — nothing to do.'); return; }

  const { data: elements, error: eErr } = await supabase
    .from('cake_elements')
    .select('id, name, element_type_id, allowed_zones, placement_config')
    .in('element_type_id', [...slugById.keys()]);
  if (eErr) { console.error(eErr.message); process.exit(1); }

  console.log(`${elements.length} hero element(s) to check\n`);

  let updated = 0, unchanged = 0;
  for (const el of elements) {
    const slug = slugById.get(el.element_type_id);
    const existing = el.placement_config ?? {};
    // Defaults merge UNDER existing — existing values always win (mirrors the `...r.placement_config` spread).
    const nextConfig = { ...DEFAULTS[slug], ...existing };
    // Toppers with no zones get top_surface (mirrors the load-time backfill).
    const nextZones = (slug === 'topper' && !(el.allowed_zones?.length)) ? ['top_surface'] : el.allowed_zones;

    const configChanged = !shallowEqual(nextConfig, existing);
    const zonesChanged   = JSON.stringify(nextZones) !== JSON.stringify(el.allowed_zones);
    if (!configChanged && !zonesChanged) { unchanged++; continue; }

    const patch = { placement_config: nextConfig };
    if (zonesChanged) patch.allowed_zones = nextZones;

    if (DRY_RUN) {
      console.log(`  [DRY] ${slug.padEnd(16)} ${el.name}`);
      console.log(`        single_per_slot=${nextConfig.single_per_slot}` +
        (zonesChanged ? `  zones=${JSON.stringify(nextZones)}` : ''));
      updated++;
      continue;
    }

    const { error: upErr } = await supabase.from('cake_elements').update(patch).eq('id', el.id);
    if (upErr) { console.log(`  error: ${el.name}: ${upErr.message}`); continue; }
    console.log(`  ✓ ${slug.padEnd(16)} ${el.name}`);
    updated++;
  }

  console.log(`\nDone. ${DRY_RUN ? '(dry run) ' : ''}${updated} ${DRY_RUN ? 'would change' : 'updated'}, ${unchanged} already correct.`);
}

run().catch(err => { console.error(err); process.exit(1); });
