import sharp from 'sharp';
import { getObjectBuffer, putObject } from './r2.js';

// Picker thumbnail spec (ASSET_OPTIMIZATION_PLAN.md §3): a small WebP served
// direct. The dimension cap is what bounds decoded GPU/CPU memory (format only
// affects download size), so ≤256px is the real lever.
const THUMB_MAX_DIM = 256;
const THUMB_QUALITY = 80;

// Generates the optimised WebP picker thumbnail from a raw thumbnail key
// (elements/thumbnails/<uid>.png) and stores it at the same uid with a .webp
// extension. Returns the new webp key, or null if there's nothing to convert.
// The raw PNG is left untouched as the source of record (thumbnail_url). Shared
// by element ingest (create/update) — same transform the back-catalog sweep used.
export async function generateWebpThumbnail(thumbnailKey, { maxDim = THUMB_MAX_DIM, quality = THUMB_QUALITY } = {}) {
  if (!thumbnailKey || !/\.png$/i.test(thumbnailKey)) return null;
  const webpKey = thumbnailKey.replace(/\.png$/i, '.webp');
  const src = await getObjectBuffer(thumbnailKey);
  const webp = await sharp(src)
    .resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality })
    .toBuffer();
  await putObject(webpKey, webp, 'image/webp');
  return webpKey;
}
