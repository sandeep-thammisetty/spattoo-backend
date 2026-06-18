// Backfill the inspiration-matching index over all existing elements:
//   - generates a `description` (comma-separated keywords) for any element missing one
//   - stores a text embedding of name + description for KNN retrieval
// Run once after applying migrations/010_element_embeddings.sql:
//   node scripts/backfill-element-index.mjs
import 'dotenv/config';
import { supabase } from '../src/services/supabase.js';
import { reindexElement } from '../src/services/elementIndex.js';

const { data: els, error } = await supabase
  .from('cake_elements')
  .select('id, name, description')
  .order('created_at', { ascending: true });
if (error) { console.error('load failed:', error.message); process.exit(1); }

console.log(`Indexing ${els.length} elements…\n`);
let ok = 0, gen = 0, fail = 0;
for (const el of els) {
  try {
    const { generatedDescription } = await reindexElement(el.id);
    ok++; if (generatedDescription) gen++;
    console.log(`  ✓ ${el.name}${generatedDescription ? '  (description generated)' : ''}`);
  } catch (e) {
    fail++; console.log(`  ✗ ${el.name}: ${e.message}`);
  }
}
console.log(`\nDone — embedded ${ok}, descriptions generated ${gen}, failed ${fail}.`);
process.exit(fail ? 1 : 0);
