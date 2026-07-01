import { getObjectBuffer, putObject } from '../../services/r2.js';
import { removeBackground } from '../../services/removebg.js';
import { supabase } from '../../services/supabase.js';
import { jobQueue } from '../queue.js';

// Enqueue a background-removal job for a baker's logo. No-op unless both ids are present. Single
// chokepoint so every place that sets a logo (create + profile update) uses the same job name.
export function enqueueLogoBgRemoval(bakerId, logoKey) {
  if (!bakerId || !logoKey) return;
  return jobQueue.add('remove_logo_bg', { bakerId, logoKey });
}

// Fetch the uploaded logo, strip its background via remove.bg, store the transparent PNG in R2, and
// point bakers.logo_transparent_key at it. On ANY failure we leave the column null so the storefront
// simply falls back to the original logo — a bad cutout or a remove.bg outage never breaks the logo.
export async function removeLogoBg({ bakerId, logoKey }) {
  if (!bakerId || !logoKey) return;
  try {
    const input = await getObjectBuffer(logoKey);
    const cutout = await removeBackground(input);
    const transparentKey = `${logoKey.replace(/\.[^./]+$/, '')}-nobg.png`;
    await putObject(transparentKey, cutout, 'image/png');
    const { error } = await supabase
      .from('bakers')
      .update({ logo_transparent_key: transparentKey })
      .eq('id', bakerId);
    if (error) throw new Error(error.message);
  } catch (err) {
    console.error(`remove_logo_bg failed for baker ${bakerId}:`, err.message);
  }
}
