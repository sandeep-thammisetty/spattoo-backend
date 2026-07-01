import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/rbac.js';
import { suggestCraftGuide } from '../services/openai.js';

const router = Router();

const CRAFT_FIELDS = 'element_id, nozzle_recs, consistency, technique, updated_at';
const CONSISTENCIES = ['stiff', 'medium', 'soft'];
const RANKS = ['primary', 'secondary', 'alternative'];

// Validate + normalize a nozzle_recs payload into
// [{ nozzle_id, brand, number, name, rank, confidence }].
//   nozzle_id  — optional link to the nozzles catalog (null for free-typed recs)
//   rank       — presentation tier; defaults to 'primary'
//   confidence — optional GPT match score, clamped to 0..1 (null when unset)
// Returns { ok: true, value } or { ok: false, error }.
function normalizeNozzleRecs(input) {
  if (input == null) return { ok: true, value: [] };
  if (!Array.isArray(input)) return { ok: false, error: 'nozzle_recs must be an array' };

  const value = [];
  for (const rec of input) {
    if (!rec || typeof rec !== 'object') {
      return { ok: false, error: 'each nozzle rec must be an object' };
    }
    const brand = String(rec.brand ?? '').trim();
    const number = String(rec.number ?? '').trim();
    const name = String(rec.name ?? '').trim();
    if (!brand || !number) {
      return { ok: false, error: 'each nozzle rec needs a brand and a number' };
    }

    const nozzle_id = rec.nozzle_id ? String(rec.nozzle_id) : null;
    const rank = RANKS.includes(rec.rank) ? rec.rank : 'primary';
    let confidence = null;
    if (rec.confidence != null && rec.confidence !== '') {
      const n = Number(rec.confidence);
      if (!Number.isNaN(n)) confidence = Math.min(1, Math.max(0, n));
    }

    value.push({ nozzle_id, brand, number, name, rank, confidence });
  }
  return { ok: true, value };
}

// ── Read (any authenticated user — bakers viewing X-Ray, admins authoring) ─────

// GET /api/craft-guide?element_ids=id1,id2,...
// Batch fetch craft guides for a set of element ids. X-Ray collects the piping
// element ids from an order's design and asks for all of them at once.
router.get('/craft-guide', requireAuth, requireCapability('design:create'), async (req, res) => {
  try {
    const raw = req.query.element_ids;
    if (!raw) return res.json([]);

    const ids = String(raw)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) return res.json([]);

    const { data, error } = await supabase
      .from('element_craft_guide')
      .select(CRAFT_FIELDS)
      .in('element_id', ids);

    if (error) return serverError(req, res, error);
    res.json(data);
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── Admin ─────────────────────────────────────────────────────────────────────

// POST /api/admin/craft-guide/suggest
// GPT-suggest a craft guide from an element image, grounded on the nozzle catalog.
// Body: { imageBase64, mimeType } (pre-upload, e.g. AddElement) OR { image_url }
//       (e.g. backfill), plus optional { name, description }.
// Returns { nozzle_recs: [{ nozzle_id, brand, number, name, rank, confidence }],
//           consistency, technique } — recs hydrated from the catalog by id, so
// GPT can't introduce a tip number that isn't real.
router.post('/admin/craft-guide/suggest', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { imageBase64, mimeType, image_url, name, description } = req.body;
    const imageUrl = image_url || (imageBase64 && mimeType ? `data:${mimeType};base64,${imageBase64}` : null);
    if (!imageUrl) {
      return res.status(400).json({ error: 'image_url, or imageBase64 + mimeType, is required' });
    }

    const { data: catalog, error: catErr } = await supabase
      .from('nozzles')
      .select('id, brand, number, name, category, description, is_common')
      .eq('is_active', true);
    if (catErr) return serverError(req, res, catErr);
    if (!catalog?.length) return res.status(400).json({ error: 'nozzle catalog is empty — seed it first' });

    const result = await suggestCraftGuide({ imageUrl, name, description, catalog });

    // Hydrate facts from the catalog by id; drop anything GPT returned that
    // isn't a real catalog entry.
    const byId = new Map(catalog.map(n => [n.id, n]));
    const nozzle_recs = (result?.nozzle_recs ?? [])
      .map(r => {
        const n = byId.get(r.nozzle_id);
        if (!n) return null;
        let confidence = null;
        const c = Number(r.confidence);
        if (!Number.isNaN(c)) confidence = Math.min(1, Math.max(0, c));
        return {
          nozzle_id: n.id,
          brand: n.brand,
          number: n.number,
          name: n.name,
          rank: RANKS.includes(r.rank) ? r.rank : 'secondary',
          confidence,
        };
      })
      .filter(Boolean);

    const consistency = CONSISTENCIES.includes(result?.consistency) ? result.consistency : null;
    const technique = result?.technique ? String(result.technique).trim() : null;

    res.json({ nozzle_recs, consistency, technique });
  } catch (err) {
    console.error('craft-guide suggest error:', err.message);
    serverError(req, res, err);
  }
});

// GET /api/admin/craft-guide/:elementId
// Single fetch for the authoring editor. Returns null if not yet authored.
router.get('/admin/craft-guide/:elementId', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('element_craft_guide')
      .select(CRAFT_FIELDS)
      .eq('element_id', req.params.elementId)
      .maybeSingle();

    if (error) return serverError(req, res, error);
    res.json(data); // null when no row exists yet
  } catch (err) {
    serverError(req, res, err);
  }
});

// PUT /api/admin/craft-guide/:elementId
// Upsert the craft guide for one element. Body: { nozzle_recs, consistency, technique }
router.put('/admin/craft-guide/:elementId', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { elementId } = req.params;
    const { consistency, technique } = req.body;

    const recs = normalizeNozzleRecs(req.body.nozzle_recs);
    if (!recs.ok) return res.status(400).json({ error: recs.error });

    if (consistency != null && consistency !== '' && !CONSISTENCIES.includes(consistency)) {
      return res.status(400).json({ error: `consistency must be one of ${CONSISTENCIES.join(', ')}` });
    }

    const { data, error } = await supabase
      .from('element_craft_guide')
      .upsert(
        {
          element_id:  elementId,
          nozzle_recs: recs.value,
          consistency: consistency || null,
          technique:   technique?.trim() || null,
          updated_at:  new Date().toISOString(),
        },
        { onConflict: 'element_id' },
      )
      .select(CRAFT_FIELDS)
      .single();

    if (error) {
      const status = error.code === '23503' ? 404 : 500; // 23503 = FK violation (unknown element)
      return res.status(status).json({ error: error.message });
    }

    res.json(data);
  } catch (err) {
    serverError(req, res, err);
  }
});

export default router;
