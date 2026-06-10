// One-time backfill: GPT-suggest the craft guide (nozzles + consistency +
// technique) for every cream_piping building-block element, grounded on the
// nozzle catalog. Patterns are NOT processed — they inherit by unioning their
// parts' recs at X-Ray time.
//
// Flow is dry-run → review → commit (GPT is only ever called in the dry-run):
//
//   node scripts/backfill-craft-guide.js            # dry-run: GPT → proposals JSON
//   # …open scripts/craft-guide-proposals.json, eyeball / edit it…
//   node scripts/backfill-craft-guide.js --commit   # write the reviewed JSON to the DB
//
// Flags:
//   --commit        write the proposals JSON to element_craft_guide (no GPT call)
//   --force         (dry-run) also re-propose elements that already have a guide
//   --limit N       (dry-run) cap how many elements to process
//
// Requires env: OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, R2_PUBLIC_URL.
// Run where those are available (Render shell, or locally with env exported).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { supabase } from '../src/services/supabase.js';
import { suggestCraftGuide } from '../src/services/openai.js';

const RANKS = ['primary', 'secondary', 'alternative'];
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROPOSALS_FILE = path.join(__dirname, 'craft-guide-proposals.json');

const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const FORCE = args.includes('--force');
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  return i >= 0 ? parseInt(args[i + 1], 10) || Infinity : Infinity;
})();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function hydrateRecs(rawRecs, byId) {
  return (rawRecs ?? [])
    .map(r => {
      const n = byId.get(r.nozzle_id);
      if (!n) return null;
      let confidence = null;
      const c = Number(r.confidence);
      if (!Number.isNaN(c)) confidence = Math.min(1, Math.max(0, c));
      return { nozzle_id: n.id, brand: n.brand, number: n.number, name: n.name, rank: RANKS.includes(r.rank) ? r.rank : 'secondary', confidence };
    })
    .filter(Boolean);
}

// ── COMMIT: write the reviewed proposals JSON to the DB ─────────────────────────
async function commit() {
  if (!fs.existsSync(PROPOSALS_FILE)) {
    console.error(`No proposals file at ${PROPOSALS_FILE}. Run the dry-run first.`);
    process.exit(1);
  }
  const proposals = JSON.parse(fs.readFileSync(PROPOSALS_FILE, 'utf8'));
  const writable = proposals.filter(p => (p.nozzle_recs?.length ?? 0) > 0);
  console.log(`Committing ${writable.length} of ${proposals.length} proposals (skipping ${proposals.length - writable.length} with no nozzles)…`);

  let ok = 0;
  for (const p of writable) {
    const { error } = await supabase
      .from('element_craft_guide')
      .upsert({
        element_id:  p.element_id,
        nozzle_recs: p.nozzle_recs,
        consistency: p.consistency ?? null,
        technique:   p.technique ?? null,
        updated_at:  new Date().toISOString(),
      }, { onConflict: 'element_id' });
    if (error) { console.error(`  ✗ ${p.name} (${p.element_id}): ${error.message}`); continue; }
    ok++;
    console.log(`  ✓ ${p.name} — ${p.nozzle_recs.length} nozzle(s)`);
  }
  console.log(`\nDone. Wrote ${ok}/${writable.length}.`);
}

// ── DRY-RUN: GPT-propose, write JSON for review ─────────────────────────────────
async function dryRun() {
  // cream_piping element type
  const { data: type, error: typeErr } = await supabase
    .from('element_types').select('id').eq('slug', 'cream_piping').single();
  if (typeErr || !type) { console.error('Could not find element type "cream_piping".'); process.exit(1); }

  // Atomic building-block elements (global, active)
  const { data: elements, error: elErr } = await supabase
    .from('cake_elements')
    .select('id, name, description, thumbnail_url')
    .eq('element_type_id', type.id)
    .eq('is_active', true)
    .is('baker_id', null);
  if (elErr) { console.error(elErr.message); process.exit(1); }

  // Already-authored ids (skip unless --force)
  const { data: existing } = await supabase.from('element_craft_guide').select('element_id');
  const authored = new Set((existing ?? []).map(e => e.element_id));

  // Catalog for grounding + hydration
  const { data: catalog, error: catErr } = await supabase
    .from('nozzles').select('id, brand, number, name, category, description, is_common').eq('is_active', true);
  if (catErr) { console.error(catErr.message); process.exit(1); }
  if (!catalog?.length) { console.error('Nozzle catalog is empty — seed it first.'); process.exit(1); }
  const byId = new Map(catalog.map(n => [n.id, n]));

  const todo = elements
    .filter(el => FORCE || !authored.has(el.id))
    .filter(el => el.thumbnail_url)
    .slice(0, LIMIT);

  const skippedAuthored = elements.filter(el => !FORCE && authored.has(el.id)).length;
  const skippedNoThumb = elements.filter(el => !el.thumbnail_url).length;
  console.log(`${elements.length} cream_piping blocks · processing ${todo.length} (skipping ${skippedAuthored} already authored, ${skippedNoThumb} without a thumbnail).`);
  if (skippedNoThumb) console.log('  ⚠ elements without a thumbnail can\'t be analysed by GPT — they\'re left for manual entry.');

  const proposals = [];
  for (let i = 0; i < todo.length; i++) {
    const el = todo[i];
    const imageUrl = `${config.r2.publicUrl}/${el.thumbnail_url}`;
    process.stdout.write(`  [${i + 1}/${todo.length}] ${el.name} … `);
    try {
      const r = await suggestCraftGuide({ imageUrl, name: el.name, description: el.description, catalog });
      const nozzle_recs = hydrateRecs(r?.nozzle_recs, byId);
      const consistency = ['stiff', 'medium', 'soft'].includes(r?.consistency) ? r.consistency : null;
      const technique = r?.technique ? String(r.technique).trim() : null;
      proposals.push({ element_id: el.id, name: el.name, nozzle_recs, consistency, technique });
      const primary = nozzle_recs.find(n => n.rank === 'primary') ?? nozzle_recs[0];
      console.log(nozzle_recs.length ? `${primary.brand} ${primary.number} (+${nozzle_recs.length - 1} more)` : 'no match');
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      proposals.push({ element_id: el.id, name: el.name, nozzle_recs: [], consistency: null, technique: null, error: err.message });
    }
    await sleep(800); // be gentle on the OpenAI rate limit
  }

  fs.writeFileSync(PROPOSALS_FILE, JSON.stringify(proposals, null, 2));
  const withRecs = proposals.filter(p => p.nozzle_recs.length).length;
  console.log(`\nWrote ${proposals.length} proposals (${withRecs} with nozzles) to:\n  ${PROPOSALS_FILE}`);
  console.log('Review / edit that file, then run with --commit to write it to the DB.');
}

(COMMIT ? commit() : dryRun()).catch(err => { console.error(err); process.exit(1); });
