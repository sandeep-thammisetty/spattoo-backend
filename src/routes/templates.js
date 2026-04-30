import { Router } from 'express';
import { supabase } from '../services/supabase.js';
import { requireAuth, attachBakerContext } from '../middleware/auth.js';
import { config } from '../config.js';

const router = Router();

function toPublicUrl(key) {
  if (!key) return null;
  return `${config.r2.publicUrl}/${key}`;
}

const TEMPLATE_FIELDS = 'id, name, shape, tier_count, type, offering, baker_id, parent_template_id, design, thumbnail_url, sort_order, is_active';

router.get('/templates', requireAuth, attachBakerContext, async (req, res) => {
  try {
    const { type } = req.query;

    let query = supabase
      .from('cake_templates')
      .select(TEMPLATE_FIELDS)
      .eq('is_active', true)
      .order('sort_order');

    if (type) query = query.eq('type', type);

    if (req.bakerId) {
      // Baker: global templates + their own
      query = query.or(`baker_id.is.null,baker_id.eq.${req.bakerId}`);
    } else {
      // Admin: optionally scope to a baker's view via ?baker_id=X
      const scopedId = req.query.baker_id;
      if (scopedId) {
        query = query.or(`baker_id.is.null,baker_id.eq.${scopedId}`);
      }
      // No baker_id param → admin sees all templates unfiltered
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    res.json(data.map(t => ({ ...t, thumbnail_url: toPublicUrl(t.thumbnail_url) })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/templates', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('cake_templates')
      .select(TEMPLATE_FIELDS)
      .order('sort_order');

    if (error) return res.status(500).json({ error: error.message });
    res.json(data.map(t => ({ ...t, thumbnail_url: toPublicUrl(t.thumbnail_url) })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/templates/:id', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('cake_templates')
      .select(TEMPLATE_FIELDS)
      .eq('id', req.params.id)
      .single();

    if (error) return res.status(404).json({ error: 'Template not found' });
    res.json({ ...data, thumbnail_url: toPublicUrl(data.thumbnail_url) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/templates', requireAuth, async (req, res) => {
  try {
    const { name, shape, tier_count, type, offering, baker_id, parent_template_id, design, thumbnail_url, sort_order } = req.body;
    if (!name || !design) {
      return res.status(400).json({ error: 'name and design are required' });
    }

    const { data, error } = await supabase
      .from('cake_templates')
      .insert({
        name,
        shape:              shape ?? 'round',
        tier_count:         tier_count ?? 1,
        type:               type ?? 'basic',
        offering:           offering ?? 'standard',
        baker_id:           baker_id ?? null,
        parent_template_id: parent_template_id ?? null,
        design,
        thumbnail_url:      thumbnail_url ?? null,
        sort_order:         sort_order ?? 0,
        is_active:          true,
      })
      .select('id')
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json({ id: data.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/admin/templates/:id', requireAuth, async (req, res) => {
  try {
    const allowed = ['name', 'shape', 'tier_count', 'type', 'offering', 'design', 'thumbnail_url', 'sort_order', 'is_active'];
    const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));

    const { error } = await supabase
      .from('cake_templates')
      .update(updates)
      .eq('id', req.params.id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/admin/templates/:id', requireAuth, async (req, res) => {
  try {
    const { error } = await supabase
      .from('cake_templates')
      .delete()
      .eq('id', req.params.id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
