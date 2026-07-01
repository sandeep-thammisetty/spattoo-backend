import sharp from 'sharp';
import { getObjectBuffer, putObject, deleteObject } from '../../services/r2.js';
import { supabase } from '../../services/supabase.js';
import { jobQueue } from '../queue.js';

// Enqueue a WebP-optimisation job for a just-uploaded gallery photo. No-op without both ids.
export function enqueueOptimizePhoto(photoId, key) {
  if (!photoId || !key) return;
  return jobQueue.add('optimize_photo', { photoId, key });
}

// Re-encode an uploaded gallery photo to a web-optimised WebP (EXIF-oriented, resized, quality-
// capped, metadata stripped), point the row at the new key, and delete the original. On ANY failure
// we leave the original in place — a conversion error never breaks the photo.
export async function optimizePhoto({ photoId, key }) {
  if (!photoId || !key || /\.webp$/i.test(key)) return;   // missing, or already WebP
  try {
    const input = await getObjectBuffer(key);
    const webp = await sharp(input)
      .rotate()                                                       // honour EXIF orientation (phone photos)
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
    const newKey = `${key.replace(/\.[^./]+$/, '')}.webp`;
    await putObject(newKey, webp, 'image/webp');
    const { error } = await supabase
      .from('baker_storefront_photos')
      .update({ storage_key: newKey })
      .eq('id', photoId);
    if (error) throw new Error(error.message);
    if (newKey !== key) await deleteObject(key);                     // drop the original (now replaced)
  } catch (err) {
    console.error(`optimize_photo failed for photo ${photoId}:`, err.message);
  }
}
