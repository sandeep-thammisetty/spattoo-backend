import { getJob, updateJob } from '../../services/supabase.js';
import { identifyElements, generateElementImage } from '../../services/openai.js';
import { removeBackground } from '../../services/removebg.js';

export async function extractImage({ jobId }) {
  await updateJob(jobId, 'processing');
  try {
    const job = await getJob(jobId);
    const { cake, elements } = await identifyElements(job.payload.imageUrl);

    let done = 0;
    const results = await Promise.all(
      elements.map(async (el) => {
        try {
          const dalleUrl      = await generateElementImage(el.prompt);
          const transparentB64 = await removeBackground(dalleUrl);
          done++;
          return { element: el.element, label: el.label, color_hex: el.color_hex, position: el.position, tier: el.tier, size: el.size, url: transparentB64 };
        } catch (err) {
          console.error(`Element "${el.label}" failed:`, err.message);
          done++;
          return null;
        }
      })
    );

    await updateJob(jobId, 'done', {
      result: { cake, elements: results.filter(Boolean) },
    });
  } catch (err) {
    await updateJob(jobId, 'failed', { error: err.message });
  }
}
