import { Router } from 'express';
import express from 'express';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { config } from '../config.js';
import { removeBackground } from '../services/removebg.js';
import { jobQueue } from '../jobs/queue.js';

const router = Router();

function toPublicUrl(key) {
  if (!key) return null;
  return `${config.r2.publicUrl}/${key}`;
}

router.get('/element-types', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('element_types')
      .select('id, slug, name, placement_rules, sort_order, default_allowed_actions')
      .eq('is_active', true)
      .order('sort_order');

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/element-types', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('element_types')
      .select('id, slug, name, description, placement_rules, sort_order, is_active')
      .order('sort_order');

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/element-types', requireAuth, async (req, res) => {
  try {
    const { name, slug, description, placement_rules, sort_order } = req.body;
    if (!name || !slug) return res.status(400).json({ error: 'name and slug are required' });

    const { data, error } = await supabase
      .from('element_types')
      .insert({ name, slug, description: description ?? null, placement_rules: placement_rules ?? {}, sort_order: sort_order ?? 0, is_active: true })
      .select('id, slug, name, description, placement_rules, sort_order, is_active')
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/admin/element-types/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, slug, description, placement_rules, sort_order, is_active } = req.body;

    const { data, error } = await supabase
      .from('element_types')
      .update({ ...(name != null && { name }), ...(slug != null && { slug }), ...(description !== undefined && { description }), ...(placement_rules != null && { placement_rules }), ...(sort_order != null && { sort_order }), ...(is_active != null && { is_active }) })
      .eq('id', id)
      .select('id, slug, name, description, placement_rules, sort_order, is_active')
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/elements', requireAuth, async (req, res) => {
  try {
    const { element_type_id, parents_only } = req.query;

    const TAG_JOIN = 'element_tags(tags(slug))';

    if (parents_only === 'true') {
      let query = supabase
        .from('cake_elements')
        .select(`id, name, image_url, thumbnail_url, element_type_id, allowed_zones, placement_config, allowed_actions, default_color, sort_order, ${TAG_JOIN}`)
        .eq('is_active', true)
        .is('parent_id', null)
        .order('sort_order');

      if (element_type_id) query = query.eq('element_type_id', element_type_id);

      const { data, error } = await query;
      if (error) return res.status(500).json({ error: error.message });
      return res.json(data.map(({ element_tags, ...el }) => ({
        ...el,
        image_url:     toPublicUrl(el.image_url),
        thumbnail_url: toPublicUrl(el.thumbnail_url),
        tag_slugs:     (element_tags ?? []).map(r => r.tags?.slug).filter(Boolean),
      })));
    }

    let query = supabase
      .from('cake_elements')
      .select(`id, name, image_url, thumbnail_url, element_type_id, allowed_zones, placement_config, allowed_actions, default_color, sort_order, baker_id, parent_id, ${TAG_JOIN}`)
      .eq('is_active', true)
      .order('sort_order');

    if (element_type_id) query = query.eq('element_type_id', element_type_id);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const elements = data.map(({ element_tags, ...el }) => ({
      ...el,
      image_url:     toPublicUrl(el.image_url),
      thumbnail_url: toPublicUrl(el.thumbnail_url),
      tag_slugs:     (element_tags ?? []).map(r => r.tags?.slug).filter(Boolean),
    }));

    res.json(elements);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Accepts raw image bytes, strips background, returns PNG bytes
router.post(
  '/admin/remove-bg',
  requireAuth,
  express.raw({ type: '*/*', limit: '10mb' }),
  async (req, res) => {
    try {
      const pngBuffer = await removeBackground(req.body);
      res.set('Content-Type', 'image/png');
      res.send(pngBuffer);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

router.get('/admin/elements', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('cake_elements')
      .select('id, name, image_url, thumbnail_url, element_type_id, parent_id, allowed_zones, placement_config, allowed_actions, default_color, sort_order, is_active, baker_id')
      .is('baker_id', null)
      .order('sort_order');

    if (error) return res.status(500).json({ error: error.message });
    res.json(data.map(el => ({
      ...el,
      image_url:     toPublicUrl(el.image_url),
      thumbnail_url: toPublicUrl(el.thumbnail_url),
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/admin/elements/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, image_url, thumbnail_url, element_type_id, parent_id, allowed_zones, placement_config, allowed_actions, default_color, sort_order, is_active } = req.body;

    const updates = {};
    if (name            != null)      updates.name             = name;
    if (image_url       !== undefined) updates.image_url        = image_url;
    if (thumbnail_url   !== undefined) updates.thumbnail_url    = thumbnail_url;
    if (element_type_id != null)      updates.element_type_id  = element_type_id;
    if (parent_id       !== undefined) updates.parent_id        = parent_id;
    if (allowed_zones   != null)      updates.allowed_zones    = allowed_zones;
    if (placement_config!= null)      updates.placement_config = placement_config;
    if (allowed_actions != null)      updates.allowed_actions  = allowed_actions;
    if (default_color   !== undefined) updates.default_color    = default_color;
    if (sort_order      != null)      updates.sort_order       = sort_order;
    if (is_active       != null)      updates.is_active        = is_active;

    const { data, error } = await supabase
      .from('cake_elements')
      .update(updates)
      .eq('id', id)
      .select('id')
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/elements', requireAuth, async (req, res) => {
  try {
    const { name, image_url, thumbnail_url, element_type_id, parent_id, allowed_zones, placement_config, allowed_actions, default_color, sort_order } = req.body;
    if (!name || !element_type_id) {
      return res.status(400).json({ error: 'name and element_type_id are required' });
    }

    const { data, error } = await supabase
      .from('cake_elements')
      .insert({
        name,
        image_url,
        thumbnail_url,
        element_type_id,
        parent_id:        parent_id ?? null,
        allowed_zones,
        placement_config: placement_config ?? {},
        allowed_actions:  allowed_actions  ?? { resize: true, duplicate: true, color: false, delete: true },
        default_color:    default_color ?? null,
        sort_order:       sort_order ?? 0,
        baker_id:         null,
        is_active:        true,
      })
      .select('id')
      .single();

    if (error) return res.status(500).json({ error: error.message });

    if (thumbnail_url) {
      jobQueue.add('auto_tag', { entityType: 'element', entityId: data.id, thumbnailKey: thumbnail_url, name }).catch(() => {});
    }

    res.status(201).json({ id: data.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
