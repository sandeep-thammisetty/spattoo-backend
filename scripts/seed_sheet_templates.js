// Seed/refresh the global sheet & square cake templates in cake_templates.
//
// These give the designer rectangular starting points so piping and decorations can be
// used on sheet cakes. Each is a single rectangular tier; `design` matches what
// useCakeDesign.loadDesign() reads (shape/width/depth/height on the tier). World-unit
// sizes follow constants.js SHEET_SIZES (inch × 0.12), so a half sheet's long side
// (~2.16) reads at roughly the round bottom tier's footprint (diameter 2.4).
//
// The `shape` COLUMN uses the admin enum ('rectangle' | 'square'); the tier's geometry
// kind in `design` is 'rect' for both. Scope is limited to these 5 named GLOBAL rows
// (baker_id IS NULL): existing ones are updated in place, missing ones inserted. It does
// not touch any other template, and never deletes.
//
// Run: node scripts/seed_sheet_templates.js   (uses SUPABASE_SERVICE_KEY from .env)

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const CAKE_COLOR = '#f5b8c8';
const HEIGHT = 0.85;   // shorter than a round tier (1.45) — reads like a sheet cake

const design = (width, depth) => ({
  tiers: [
    { color: CAKE_COLOR, topPiping: null, bottomPiping: null, shape: 'rect', width, depth, height: HEIGHT },
  ],
  texts: [],
  stickers: [],
  topper: null,
});

// name, world width (long, X) × depth (short, Z), admin shape enum, sort order
const TEMPLATES = [
  { name: 'Quarter Sheet',  width: 1.56, depth: 1.08, shape: 'rectangle', sort_order: 1 },
  { name: 'Half Sheet',     width: 2.16, depth: 1.56, shape: 'rectangle', sort_order: 2 },
  { name: 'Full Sheet',     width: 3.12, depth: 2.16, shape: 'rectangle', sort_order: 3 },
  { name: 'Square (8")',    width: 0.96, depth: 0.96, shape: 'square',    sort_order: 4 },
  { name: 'Square (12")',   width: 1.44, depth: 1.44, shape: 'square',    sort_order: 5 },
];

async function run() {
  const names = TEMPLATES.map(t => t.name);

  // Look up which of OUR named global rows already exist (so we update vs insert).
  const { data: existing, error: selErr } = await supabase
    .from('cake_templates')
    .select('id, name')
    .is('baker_id', null)
    .in('name', names);
  if (selErr) { console.error('lookup failed:', selErr.message); process.exit(1); }

  const idByName = new Map((existing ?? []).map(r => [r.name, r.id]));

  for (const t of TEMPLATES) {
    const row = {
      shape:      t.shape,
      tier_count: 1,
      offering:   'standard',
      design:     design(t.width, t.depth),
      sort_order: t.sort_order,
      is_active:  true,
    };
    if (idByName.has(t.name)) {
      const { error } = await supabase.from('cake_templates').update(row).eq('id', idByName.get(t.name));
      if (error) { console.error(`update ${t.name} failed:`, error.message); process.exit(1); }
      console.log(`  ↻ updated ${t.name} (${t.shape})`);
    } else {
      const { error } = await supabase.from('cake_templates').insert({ name: t.name, baker_id: null, ...row });
      if (error) { console.error(`insert ${t.name} failed:`, error.message); process.exit(1); }
      console.log(`  + inserted ${t.name} (${t.shape})`);
    }
  }
  console.log('Done.');
}

run();
