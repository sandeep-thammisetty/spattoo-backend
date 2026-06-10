import { config } from '../config.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function identifyElements(imageUrl) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.openai.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageUrl } },
          {
            type: 'text',
            text: `You are a professional cake decorator. Carefully analyse this cake image.
Return ONLY a JSON object, no explanation:
{
  "cake": {
    "tiers": <1|2|3>,
    "frosting_type": "<buttercream|fondant|naked|ganache>",
    "frosting_color": "<hex colour of the main frosting>",
    "has_drip": <true|false>,
    "drip_color": "<hex colour of drip, or null>"
  },
  "elements": [
    {
      "element": "<rose|leaf|drip|topper|macaron|other>",
      "label": "<short name>",
      "color_hex": "<dominant hex colour>",
      "material": "<buttercream|fondant|acrylic|sugar|chocolate|other>",
      "tier": "<top|bottom>",
      "position": "<topper|top-front-left|top-front-center|top-front-right|top-back-left|top-back-center|top-back-right|top-center|side-front-left|side-front-center|side-front-right|side-left|side-right>",
      "size": "<small|medium|large>",
      "prompt": "<rich DALL-E prompt. If buttercream: 'piped buttercream rosette using a 1M piping tip, swirled creamy texture'. If fondant: 'hand-sculpted smooth fondant, matte finish'. Include exact colors, bloom count, leaves. End with: transparent background, no shadows, soft studio lighting, photorealistic product photo, no hands, no cake>"
    }
  ]
}
Rules:
- Max 5 elements
- Each element gets its OWN entry even if there are multiple of the same type at different positions
- Ignore cake base, board, plain frosting, sprinkles, pearls
- Toppers are always position "topper", tier "top"`,
          },
        ],
      }],
    }),
  });

  if (!res.ok) throw new Error(`GPT-4o failed: ${await res.text()}`);
  const data = await res.json();
  const raw  = data.choices[0].message.content.trim();
  const json = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  return JSON.parse(json);
}

// Suggest the "craft guide" for a piping element — which real nozzle(s) made it,
// plus buttercream consistency and a technique tip. GROUNDED on the nozzle
// catalog: GPT may only return catalog `id`s, never invented tip numbers. The
// caller hydrates brand/number/name from the DB by id, so model transcription
// errors can't produce a wrong tip.
//   args: { imageUrl, name, description, catalog: [{ id, brand, number, name, category, description, is_common }] }
//   returns: { nozzle_recs: [{ nozzle_id, rank, confidence }], consistency, technique }
export async function suggestCraftGuide({ imageUrl, name, description, catalog }) {
  // Keep the catalog payload lean — name + category already encode the shape,
  // and gpt-4o knows these tips. Dropping the long descriptions roughly halves
  // the per-call token count (it ships on every request → matters for TPM limits).
  const compactCatalog = (catalog ?? []).map(n => ({
    id: n.id,
    brand: n.brand,
    number: n.number,
    name: n.name,
    category: n.category,
    common: !!n.is_common,
  }));

  const prompt = `You are a master cake decorator. Identify which piping nozzle(s) most likely produced the piped buttercream/cream decoration in this image.

You are given the element's name and search keywords (written by our team) and a CATALOG of real nozzles. Choose ONLY from the catalog.

Element name: ${name || '(none)'}
Keywords: ${description || '(none)'}

CATALOG (choose by "id" — never invent tips):
${JSON.stringify(compactCatalog)}

Rules:
- LOOK AT THE SURFACE TEXTURE FIRST, it decides the tip family:
  - Smooth, ridge-free surfaces (a round dome, a smooth peak/kiss, a plain rope or bead) = ROUND / PLAIN tips (e.g. Wilton 12, 1A, 2A; Ateco 80x). A smooth dome or peak is NEVER a star tip.
  - Grooves, ribs, flutes or sharp points running along the shape = STAR / FRENCH tips (e.g. 1M, 18, French).
  - Petal-like ribbons/ruffles = PETAL tips; vein-down leaves = LEAF tips.
- We do NOT know the real cake size, so DO NOT commit to one exact tip size. Recommend the SHAPE plus a SIZE RANGE:
  1. Decide the single best SHAPE (category) for this piping.
  2. For that shape, return the 2-3 catalog tips that span the plausible SIZE range for what you see (size-appropriate — a big dollop → large rounds like 1A and 2A, NOT a tiny #5; a fine bead → small rounds). Mark ALL of these rank "primary" — they are equally-valid size options; the baker picks the size that fits their cake.
  3. If a genuinely DIFFERENT shape is also plausible, add 1-2 of those as rank "secondary" (or "alternative"), again with size options if relevant.
- confidence = 0.0 to 1.0 reflects how sure you are of the SHAPE (so the size variants of one shape share a similar confidence). Do NOT lower confidence just because the exact size is unknown — that's expected.
- Within a shape/size band, prefer tips with "common": true.
- Only include tips that genuinely could have made this shape. Fewer good matches beat many weak ones.
- Also give the buttercream consistency this piping needs (stiff | medium | soft) and ONE short technique tip (tip angle, pressure, motion).

Return ONLY valid JSON, no explanation:
{
  "nozzle_recs": [{ "nozzle_id": "<catalog id>", "rank": "primary|secondary|alternative", "confidence": 0.0 }],
  "consistency": "stiff|medium|soft",
  "technique": "<one short sentence>"
}`;

  const payload = JSON.stringify({
    model: 'gpt-4o',
    max_tokens: 450,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: imageUrl, detail: 'low' } },
        { type: 'text', text: prompt },
      ],
    }],
  });

  // Retry on 429 (rate limit), honouring the "try again in Xs" hint so a batch
  // backfill self-throttles under the TPM cap instead of failing.
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
      body: payload,
    });
    if (res.ok) break;
    const text = await res.text();
    if (res.status === 429 && attempt < 6) {
      const m = text.match(/try again in ([\d.]+)s/);
      const waitMs = m ? Math.ceil(parseFloat(m[1]) * 1000) + 750 : 6000 * (attempt + 1);
      await sleep(waitMs);
      continue;
    }
    throw new Error(`GPT-4o craft-guide failed: ${text}`);
  }
  const data = await res.json();
  const raw  = data.choices[0].message.content.trim();
  const json = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  return JSON.parse(json);
}

export async function generateElementImage(prompt) {
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.openai.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'dall-e-3',
      prompt: prompt + ' Pure white background, no shadows, no hands, no cake, isolated decoration only. Photorealistic, soft studio lighting, product photography.',
      n: 1,
      size: '1024x1024',
      quality: 'standard',
      response_format: 'url',
    }),
  });

  if (!res.ok) throw new Error(`DALL-E failed: ${await res.text()}`);
  const data = await res.json();
  return data.data[0].url;
}
