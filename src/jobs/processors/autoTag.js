import { supabase } from '../../services/supabase.js';
import { config } from '../../config.js';

function toPublicUrl(key) {
  if (!key) return null;
  if (key.startsWith('http')) return key;
  return `${config.r2.publicUrl}/${key}`;
}

async function callVisionApi(imageUrl, tags) {
  const byCategory = tags.reduce((acc, t) => {
    (acc[t.category] ??= []).push(t.slug);
    return acc;
  }, {});

  const vocabText = Object.entries(byCategory)
    .map(([cat, slugs]) => `${cat}: ${slugs.join(', ')}`)
    .join('\n');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.openai.apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      model:      'gpt-4o',
      max_tokens: 400,
      messages: [{
        role:    'user',
        content: [
          { type: 'image_url', image_url: { url: imageUrl } },
          {
            type: 'text',
            text: `You are a cake decoration expert. Analyse this image (item name: "${vocabText.name ?? 'unknown'}").
Assign tags from ONLY this controlled vocabulary — do not invent new tags:

${vocabText}

Return ONLY a JSON array. Each item: {"slug": "<slug>", "confidence": <0.0-1.0>}
Only include tags with confidence >= 0.75.
Be conservative — fewer accurate tags beat many guesses.`,
          },
        ],
      }],
    }),
  });

  if (!res.ok) throw new Error(`GPT-4o failed: ${await res.text()}`);
  const data   = await res.json();
  const raw    = data.choices[0].message.content.trim();
  const json   = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  return JSON.parse(json);
}

export async function autoTag({ entityType, entityId, thumbnailKey, name }) {
  try {
    // Fetch all AI-assignable tags
    const { data: tags, error: tagsErr } = await supabase
      .from('tags')
      .select('id, name, slug, category')
      .eq('ai_assignable', true)
      .eq('is_active', true);

    if (tagsErr || !tags?.length) return;

    const imageUrl = toPublicUrl(thumbnailKey);
    if (!imageUrl) return;

    // Build vocabulary with item name injected
    const tagsWithName = tags.map(t => t);
    const vocabByCategory = tags.reduce((acc, t) => {
      (acc[t.category] ??= []).push(t.slug);
      return acc;
    }, {});
    const vocabText = Object.entries(vocabByCategory)
      .map(([cat, slugs]) => `${cat}: ${slugs.join(', ')}`)
      .join('\n');

    // Call GPT-4o Vision
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.openai.apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        model:      'gpt-4o',
        max_tokens: 400,
        messages: [{
          role:    'user',
          content: [
            { type: 'image_url', image_url: { url: imageUrl } },
            {
              type: 'text',
              text: `You are a cake decoration expert. Analyse this image of a cake decoration item named "${name}".
Assign tags from ONLY this controlled vocabulary — do not invent new tags:

${vocabText}

Return ONLY a JSON array. Each item: {"slug": "<slug>", "confidence": <0.0-1.0>}
Only include tags with confidence >= 0.75. Be conservative.`,
            },
          ],
        }],
      }),
    });

    if (!res.ok) throw new Error(`GPT-4o failed: ${await res.text()}`);
    const gptData  = await res.json();
    const raw      = gptData.choices[0].message.content.trim();
    const jsonStr  = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    const results  = JSON.parse(jsonStr);

    if (!Array.isArray(results) || results.length === 0) return;

    // Map slugs back to tag IDs
    const slugToTag = Object.fromEntries(tags.map(t => [t.slug, t]));
    const rows = results
      .filter(r => r.slug && slugToTag[r.slug])
      .map(r => ({
        ...(entityType === 'element'
          ? { element_id: entityId }
          : { template_id: entityId }),
        tag_id:     slugToTag[r.slug].id,
        source:     'ai',
        confidence: Math.min(1, Math.max(0, r.confidence ?? 0.8)),
      }));

    if (rows.length === 0) return;

    const table = entityType === 'element' ? 'element_tags' : 'template_tags';
    // Upsert so re-tagging doesn't duplicate; preserve manual tags (they'll conflict and skip)
    await supabase.from(table).upsert(rows, { onConflict: entityType === 'element' ? 'element_id,tag_id' : 'template_id,tag_id', ignoreDuplicates: true });

    console.log(`auto_tag: ${entityType} ${entityId} → ${rows.length} tags assigned`);
  } catch (err) {
    console.error(`auto_tag failed for ${entityType} ${entityId}:`, err.message);
  }
}
