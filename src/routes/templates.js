import { Router } from 'express';
import { supabase } from '../services/supabase.js';
import { requireAuth, attachBakerContext } from '../middleware/auth.js';
import { requireCapability } from '../middleware/rbac.js';
import { scopeCatalogRead } from '../lib/tenantScope.js';
import { config } from '../config.js';
import { jobQueue } from '../jobs/queue.js';

const router = Router();

function toPublicUrl(key) {
  if (!key) return null;
  return `${config.r2.publicUrl}/${key}`;
}

const TEMPLATE_FIELDS = 'id, name, shape, tier_count, type, offering, baker_id, parent_template_id, design, thumbnail_url, sort_order, is_active';
const TEMPLATE_FILTER_JOIN = 'template_tags(tags(slug)), cake_template_attrs(min_weight_kg, min_age, max_age)';

function withTagsAndAttrs({ template_tags, cake_template_attrs, ...t }) {
  const rawAttrs = cake_template_attrs;
  const attrs = Array.isArray(rawAttrs) ? (rawAttrs[0] ?? null) : (rawAttrs ?? null);
  return {
    ...t,
    tag_slugs: (template_tags ?? []).map(r => r.tags?.slug).filter(Boolean),
    attrs,
  };
}

router.get('/templates', requireAuth, requireCapability('design:create'), attachBakerContext, async (req, res) => {
  try {
    const { type } = req.query;

    let query = supabase
      .from('cake_templates')
      .select(`${TEMPLATE_FIELDS}, ${TEMPLATE_FILTER_JOIN}`)
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

    res.json(data.map(t => withTagsAndAttrs({ ...t, thumbnail_url: toPublicUrl(t.thumbnail_url) })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/templates', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('cake_templates')
      .select(`${TEMPLATE_FIELDS}, ${TEMPLATE_FILTER_JOIN}`)
      .order('sort_order');

    if (error) return res.status(500).json({ error: error.message });
    res.json(data.map(t => withTagsAndAttrs({ ...t, thumbnail_url: toPublicUrl(t.thumbnail_url) })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/templates/:id', requireAuth, requireCapability('design:create'), async (req, res) => {
  try {
    // SEC-7: scope by tenant — a baker/customer may read only GLOBAL templates or their own.
    // Without this, any design:create caller could read another baker's private template by id.
    const { data, error } = await scopeCatalogRead(
      supabase
        .from('cake_templates')
        .select(`${TEMPLATE_FIELDS}, ${TEMPLATE_FILTER_JOIN}`)
        .eq('id', req.params.id),
      req,
    ).single();

    if (error) return res.status(404).json({ error: 'Template not found' });
    res.json(withTagsAndAttrs({ ...data, thumbnail_url: toPublicUrl(data.thumbnail_url) }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/templates', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
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

    if (thumbnail_url) {
      jobQueue.add('auto_tag', { entityType: 'template', entityId: data.id, thumbnailKey: thumbnail_url, name }).catch(() => {});
    }

    res.status(201).json({ id: data.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/admin/templates/:id', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
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

router.delete('/admin/templates/:id', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
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
