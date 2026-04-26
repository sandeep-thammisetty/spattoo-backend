import { config } from '../config.js';

// Accepts a URL string or a Buffer/Uint8Array of image bytes
export async function removeBackground(imageInput) {
  const form = new FormData();
  if (typeof imageInput === 'string') {
    form.append('image_url', imageInput);
  } else {
    form.append('image_file', new Blob([imageInput]), 'image.png');
  }
  form.append('size', 'auto');

  const res = await fetch('https://api.remove.bg/v1.0/removebg', {
    method: 'POST',
    headers: { 'X-Api-Key': config.removeBg.apiKey },
    body: form,
  });

  if (!res.ok) throw new Error(`remove.bg failed: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}
