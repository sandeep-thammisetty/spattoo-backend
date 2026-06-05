#!/usr/bin/env node
/**
 * Backfill cake_elements.file_size for existing rows.
 *
 * New uploads record the byte size at upload time (from the browser File object),
 * but elements created before the file_size column existed have NULL. This script
 * fills them in once by issuing a signed S3 HeadObject for each asset and reading
 * ContentLength — the same R2 client/credentials the API uses to upload.
 *
 * (R2_PUBLIC_URL is the S3 API endpoint, which rejects unsigned HTTP HEAD with 400,
 *  so we must go through the signed SDK with the bucket name — not a plain fetch.)
 *
 * Run scripts/../supabase/element_file_size.sql FIRST so the column exists.
 *
 * Usage:
 *   SUPABASE_URL=...  SUPABASE_SERVICE_KEY=... \
 *   R2_ENDPOINT=...  R2_ACCESS_KEY_ID=...  R2_SECRET_ACCESS_KEY=...  R2_BUCKET=... \
 *   node scripts/backfillFileSizes.mjs
 *
 * Options (env vars):
 *   DRY_RUN=1   — print what would be written, don't update the DB
 *   FORCE=1     — re-measure every element with an image_url, even if file_size is set
 */

import { createClient } from '@supabase/supabase-js';
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_KEY;
const DRY_RUN       = process.env.DRY_RUN === '1';
const FORCE         = process.env.FORCE === '1';

const REQUIRED = [
  'SUPABASE_URL', 'SUPABASE_SERVICE_KEY',
  'R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET',
];
for (const v of REQUIRED) {
  if (!process.env[v]) { console.error(`Missing ${v}`); process.exit(1); }
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const BUCKET = process.env.R2_BUCKET;
const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

function formatBytes(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// Returns the object's ContentLength from a signed HeadObject, or null on failure.
async function measure(key) {
  if (!key) return null;
  try {
    const out = await r2.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return out.ContentLength ?? null;
  } catch (err) {
    const code = err?.$metadata?.httpStatusCode ?? err.name;
    console.warn(`  ⚠ HeadObject ${code} for ${key}`);
    return null;
  }
}

async function run() {
  console.log(`Backfilling file sizes  [dry_run=${DRY_RUN}  force=${FORCE}]\n`);

  // Only elements with an actual asset file. Procedural (3D Geometry) elements
  // have no image_url and are correctly left NULL.
  let query = supabase
    .from('cake_elements')
    .select('id, name, image_url, file_size')
    .not('image_url', 'is', null);
  if (!FORCE) query = query.is('file_size', null);

  const { data: elements, error } = await query;
  if (error) { console.error(error.message); process.exit(1); }

  console.log(`${elements.length} element(s) to measure\n`);

  let updated = 0, skipped = 0;
  for (const el of elements) {
    process.stdout.write(`  ${el.name} … `);
    const size = await measure(el.image_url);
    if (size == null) { console.log('skipped (no size)'); skipped++; continue; }

    if (DRY_RUN) {
      console.log(`[DRY] ${formatBytes(size)}`);
      updated++;
      continue;
    }

    const { error: upErr } = await supabase
      .from('cake_elements')
      .update({ file_size: size })
      .eq('id', el.id);
    if (upErr) { console.log(`error: ${upErr.message}`); skipped++; continue; }
    console.log(formatBytes(size));
    updated++;
  }

  console.log(`\nDone. ${DRY_RUN ? '(dry run) ' : ''}${updated} measured, ${skipped} skipped.`);
}

run().catch(err => { console.error(err); process.exit(1); });
