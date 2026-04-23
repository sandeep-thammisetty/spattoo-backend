import { config } from '../config.js';

export async function removeBackground(imageUrl) {
  const form = new FormData();
  form.append('image_url', imageUrl);
  form.append('size', 'auto');

  const res = await fetch('https://api.remove.bg/v1.0/removebg', {
    method: 'POST',
    headers: { 'X-Api-Key': config.removeBg.apiKey },
    body: form,
  });

  if (!res.ok) throw new Error(`remove.bg failed: ${await res.text()}`);
  const buffer = await res.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  return `data:image/png;base64,${base64}`;
}
