import { config } from '../config.js';

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
