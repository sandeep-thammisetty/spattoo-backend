import { Router } from 'express';
import express from 'express';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { config } from '../config.js';
import { removeBackground } from '../services/removebg.js';

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

router.get('/elements', requireAuth, async (req, res) => {
  try {
    const { element_type_id, parents_only } = req.query;

    if (parents_only === 'true') {
      let query = supabase
        .from('cake_elements')
        .select('id, name, image_url, thumbnail_url, element_type_id, sort_order')
        .eq('is_active', true)
        .is('parent_id', null)
        .order('sort_order');

      if (element_type_id) query = query.eq('element_type_id', element_type_id);

      const { data, error } = await query;
      if (error) return res.status(500).json({ error: error.message });
      return res.json(data.map(el => ({
        ...el,
        image_url:     toPublicUrl(el.image_url),
        thumbnail_url: toPublicUrl(el.thumbnail_url),
      })));
    }

    let query = supabase
      .from('cake_elements')
      .select('id, name, image_url, thumbnail_url, element_type_id, allowed_zones, sort_order, baker_id, parent_id')
      .eq('is_active', true)
      .order('sort_order');

    if (element_type_id) query = query.eq('element_type_id', element_type_id);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const elements = data.map(el => ({
      ...el,
      image_url:     toPublicUrl(el.image_url),
      thumbnail_url: toPublicUrl(el.thumbnail_url),
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

router.post('/admin/elements', requireAuth, async (req, res) => {
  try {
    const { name, image_url, thumbnail_url, element_type_id, parent_id, allowed_zones, sort_order } = req.body;
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
        parent_id:  parent_id ?? null,
        allowed_zones,
        sort_order: sort_order ?? 0,
        baker_id:   null,
        is_active:  true,
      })
      .select('id')
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json({ id: data.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
