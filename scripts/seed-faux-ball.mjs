#!/usr/bin/env node
/**
 * Seed script — adds a "Gold Faux Ball" element to the database.
 *
 * Creates the `faux_ball` element type (if absent), uploads an SVG thumbnail
 * to R2, and inserts the element row in cake_elements.
 *
 * Usage (all env vars from the Render dashboard):
 *
 *   SUPABASE_URL=...           \
 *   SUPABASE_SERVICE_KEY=...   \
 *   R2_ENDPOINT=...            \
 *   R2_ACCESS_KEY_ID=...       \
 *   R2_SECRET_ACCESS_KEY=...   \
 *   R2_BUCKET=...              \
 *   R2_PUBLIC_URL=...          \
 *   node scripts/seed-faux-ball.mjs
 */

import { createClient }   from '@supabase/supabase-js';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

// ── Validate env ──────────────────────────────────────────────────────────────

const REQUIRED = [
  'SUPABASE_URL', 'SUPABASE_SERVICE_KEY',
  'R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET', 'R2_PUBLIC_URL',
];
const missing = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
  console.error('Missing env vars:', missing.join(', '));
  process.exit(1);
}

const {
  SUPABASE_URL, SUPABASE_SERVICE_KEY,
  R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
  R2_BUCKET, R2_PUBLIC_URL,
} = process.env;

// ── Clients ───────────────────────────────────────────────────────────────────

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const s3 = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
});

// ── Gold sphere SVG ───────────────────────────────────────────────────────────

const THUMBNAIL_KEY = 'elements/thumbnails/faux-ball-gold.svg';

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
  <defs>
    <radialGradient id="g" cx="38%" cy="32%" r="60%">
      <stop offset="0%"   stop-color="#FFF8C0"/>
      <stop offset="25%"  stop-color="#F8E88A"/>
      <stop offset="65%"  stop-color="#D4AF37"/>
      <stop offset="100%" stop-color="#7A6010"/>
    </radialGradient>
    <filter id="sh" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="4" stdDeviation="8" flood-color="rgba(0,0,0,0.4)"/>
    </filter>
  </defs>
  <!-- Sphere body -->
  <circle cx="100" cy="100" r="82" fill="url(#g)" filter="url(#sh)"/>
  <!-- Specular highlight -->
  <ellipse cx="74" cy="70" rx="20" ry="12"
    fill="rgba(255,255,255,0.38)" transform="rotate(-22 74 70)"/>
  <!-- Soft secondary sheen -->
  <ellipse cx="66" cy="78" rx="8" ry="5"
    fill="rgba(255,255,255,0.18)" transform="rotate(-22 66 78)"/>
</svg>`;

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  // 1. Upload SVG thumbnail to R2
  console.log('Uploading thumbnail…');
  await s3.send(new PutObjectCommand({
    Bucket:      R2_BUCKET,
    Key:         THUMBNAIL_KEY,
    Body:        Buffer.from(svg, 'utf8'),
    ContentType: 'image/svg+xml',
  }));
  console.log(`  ✓ ${R2_PUBLIC_URL}/${THUMBNAIL_KEY}`);

  // 2. Ensure faux_ball element type exists
  console.log('Checking element type…');
  const { data: existing } = await supabase
    .from('element_types')
    .select('id')
    .eq('slug', 'faux_ball')
    .maybeSingle();

  let elementTypeId;
  if (existing) {
    elementTypeId = existing.id;
    console.log(`  ✓ Already exists (${elementTypeId})`);
  } else {
    const { data: created, error } = await supabase
      .from('element_types')
      .insert({
        name:        'Faux Ball',
        slug:        'faux_ball',
        description: 'Procedurally rendered 3D sphere placed on the cake surface or side.',
        placement_rules: {
          zones:     ['top_surface', 'side'],
          placement: { top_surface: 'free', side: 'free' },
        },
        sort_order: 10,
        is_active:  true,
      })
      .select('id')
      .single();

    if (error) {
      console.error('  ✗ Failed to create element type:', error.message);
      process.exit(1);
    }
    elementTypeId = created.id;
    console.log(`  ✓ Created (${elementTypeId})`);
  }

  // 3. Insert element
  console.log('Inserting element…');
  const { data: el, error: elErr } = await supabase
    .from('cake_elements')
    .insert({
      name:             'Gold Faux Ball',
      element_type_id:  elementTypeId,
      parent_id:        null,
      image_url:        THUMBNAIL_KEY,
      thumbnail_url:    THUMBNAIL_KEY,
      allowed_zones:    ['top_surface', 'side'],
      placement_config: {},
      allowed_actions:  { resize: true, duplicate: true, color: true, delete: true },
      default_color:    '#D4AF37',
      sort_order:       0,
      baker_id:         null,
      is_active:        true,
    })
    .select('id, name')
    .single();

  if (elErr) {
    console.error('  ✗ Failed to insert element:', elErr.message);
    process.exit(1);
  }

  console.log(`  ✓ "${el.name}" created (${el.id})`);
  console.log('\nDone.');
}

run().catch(err => { console.error(err); process.exit(1); });
