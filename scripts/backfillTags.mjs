#!/usr/bin/env node
/**
 * Backfill AI tags for all existing elements and templates.
 *
 * Fetches every element/template that has a thumbnail but no tags yet,
 * calls GPT-4o Vision with the controlled vocabulary, and inserts into
 * element_tags / template_tags.
 *
 * Usage:
 *   SUPABASE_URL=...  SUPABASE_SERVICE_KEY=...  OPENAI_API_KEY=...  R2_PUBLIC_URL=... \
 *   node scripts/backfillTags.mjs
 *
 * Options (env vars):
 *   ENTITY=elements   — only process elements (default: both)
 *   ENTITY=templates  — only process templates
 *   DRY_RUN=1         — print what would be tagged, don't write
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_KEY;
const OPENAI_KEY    = process.env.OPENAI_API_KEY;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;
const DRY_RUN       = process.env.DRY_RUN === '1';
const ENTITY        = process.env.ENTITY ?? 'both'; // 'elements' | 'templates' | 'both'

for (const v of ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'OPENAI_API_KEY', 'R2_PUBLIC_URL']) {
  if (!process.env[v]) { console.error(`Missing ${v}`); process.exit(1); }
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

function toPublicUrl(key) {
  if (!key) return null;
  if (key.startsWith('http')) return key;
  return `${R2_PUBLIC_URL}/${key}`;
}

async function fetchTags() {
  const { data, error } = await supabase
    .from('tags')
    .select('id, name, slug, category')
    .eq('ai_assignable', true)
    .eq('is_active', true);
  if (error) throw new Error(error.message);
  return data;
}

async function callGPT(imageUrl, name, vocabText) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageUrl } },
          { type: 'text', text:
            `You are a cake decoration expert. Analyse this image of "${name}".\n` +
            `Assign tags ONLY from this vocabulary:\n${vocabText}\n\n` +
            `Return ONLY a JSON array: [{"slug":"...","confidence":0.0-1.0}]\n` +
            `Only include tags with confidence >= 0.75. Be conservative.`
          },
        ],
      }],
    }),
  });
  if (!res.ok) throw new Error(`GPT-4o error: ${await res.text()}`);
  const data = await res.json();
  const raw  = data.choices[0].message.content.trim().replace(/^```[a-z]*\n?/i,'').replace(/\n?```$/i,'');
  return JSON.parse(raw);
}

async function tagEntity(entityType, entityId, thumbnailKey, name, tags) {
  const imageUrl = toPublicUrl(thumbnailKey);
  if (!imageUrl) return 0;

  const vocabByCategory = tags.reduce((acc, t) => {
    (acc[t.category] ??= []).push(t.slug);
    return acc;
  }, {});
  const vocabText = Object.entries(vocabByCategory)
    .map(([cat, slugs]) => `${cat}: ${slugs.join(', ')}`)
    .join('\n');

  let results;
  try {
    results = await callGPT(imageUrl, name, vocabText);
  } catch (err) {
    console.warn(`  ⚠ GPT failed for "${name}": ${err.message}`);
    return 0;
  }

  const slugToTag = Object.fromEntries(tags.map(t => [t.slug, t]));
  const rows = results
    .filter(r => r.slug && slugToTag[r.slug] && r.confidence >= 0.75)
    .map(r => ({
      ...(entityType === 'element' ? { element_id: entityId } : { template_id: entityId }),
      tag_id:     slugToTag[r.slug].id,
      source:     'ai',
      confidence: Math.min(1, r.confidence),
    }));

  if (rows.length === 0) return 0;

  if (DRY_RUN) {
    console.log(`  [DRY] would assign: ${rows.map(r => slugToTag[Object.keys(r).find(k=>k.endsWith('tag_id')) || 'tag_id']?.slug ?? r.tag_id).join(', ')}`);
    return rows.length;
  }

  const table = entityType === 'element' ? 'element_tags' : 'template_tags';
  const { error } = await supabase.from(table).upsert(rows, {
    onConflict: entityType === 'element' ? 'element_id,tag_id' : 'template_id,tag_id',
    ignoreDuplicates: true,
  });
  if (error) { console.warn(`  ⚠ DB error for "${name}": ${error.message}`); return 0; }
  return rows.length;
}

async function run() {
  console.log(`Backfilling tags  [entity=${ENTITY}  dry_run=${DRY_RUN}]\n`);

  const tags = await fetchTags();
  if (!tags.length) {
    console.error('No AI-assignable tags found. Run tags_system.sql migration first.');
    process.exit(1);
  }
  console.log(`Loaded ${tags.length} AI-assignable tags.\n`);

  let totalTagged = 0;

  if (ENTITY === 'elements' || ENTITY === 'both') {
    // Fetch elements that have a thumbnail but no tags yet
    const { data: elements } = await supabase
      .from('cake_elements')
      .select('id, name, thumbnail_url')
      .not('thumbnail_url', 'is', null)
      .eq('is_active', true);

    const { data: tagged } = await supabase
      .from('element_tags')
      .select('element_id');
    const alreadyTagged = new Set((tagged ?? []).map(r => r.element_id));

    const toProcess = (elements ?? []).filter(el => !alreadyTagged.has(el.id));
    console.log(`Elements: ${toProcess.length} to tag (${alreadyTagged.size} already have tags)\n`);

    for (const el of toProcess) {
      process.stdout.write(`  ${el.name} … `);
      const n = await tagEntity('element', el.id, el.thumbnail_url, el.name, tags);
      console.log(`${n} tag(s)`);
      totalTagged += n;
      await new Promise(r => setTimeout(r, 500)); // gentle rate limit
    }
  }

  if (ENTITY === 'templates' || ENTITY === 'both') {
    const { data: templates } = await supabase
      .from('cake_templates')
      .select('id, name, thumbnail_url')
      .not('thumbnail_url', 'is', null)
      .eq('is_active', true);

    const { data: tagged } = await supabase
      .from('template_tags')
      .select('template_id');
    const alreadyTagged = new Set((tagged ?? []).map(r => r.template_id));

    const toProcess = (templates ?? []).filter(t => !alreadyTagged.has(t.id));
    console.log(`\nTemplates: ${toProcess.length} to tag (${alreadyTagged.size} already have tags)\n`);

    for (const t of toProcess) {
      process.stdout.write(`  ${t.name} … `);
      const n = await tagEntity('template', t.id, t.thumbnail_url, t.name, tags);
      console.log(`${n} tag(s)`);
      totalTagged += n;
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log(`\nDone. ${DRY_RUN ? '(dry run) ' : ''}Total tags assigned: ${totalTagged}`);
}

run().catch(err => { console.error(err); process.exit(1); });
