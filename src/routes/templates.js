import { Router } from 'express';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { config } from '../config.js';

const router = Router();

function toPublicUrl(key) {
  if (!key) return null;
  return `${config.r2.publicUrl}/${key}`;
}

router.get('/templates', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('cake_templates')
      .select('id, name, shape, tier_count, offering, design, thumbnail_url, sort_order')
      .eq('is_active', true)
      .order('sort_order');

    if (error) return res.status(500).json({ error: error.message });

    const templates = data.map(t => ({
      ...t,
      thumbnail_url: toPublicUrl(t.thumbnail_url),
    }));

    res.json(templates);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/templates/:id', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('cake_templates')
      .select('id, name, shape, tier_count, offering, design, thumbnail_url, sort_order')
      .eq('id', req.params.id)
      .eq('is_active', true)
      .single();

    if (error) return res.status(404).json({ error: 'Template not found' });
    res.json({ ...data, thumbnail_url: toPublicUrl(data.thumbnail_url) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/templates', requireAuth, async (req, res) => {
  try {
    const { name, shape, tier_count, offering, design, thumbnail_url, sort_order } = req.body;
    if (!name || !design) {
      return res.status(400).json({ error: 'name and design are required' });
    }

    const { data, error } = await supabase
      .from('cake_templates')
      .insert({
        name,
        shape:         shape ?? 'round',
        tier_count:    tier_count ?? 1,
        offering:      offering ?? 'standard',
        design,
        thumbnail_url,
        sort_order:    sort_order ?? 0,
        is_active:     true,
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
