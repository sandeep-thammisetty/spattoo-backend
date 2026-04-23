import { Router } from 'express';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.get('/elements', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('cake_elements')
      .select('id, name, image_url, thumbnail_url, element_type_id, allowed_zones, sort_order, baker_id, parent_id')
      .eq('is_active', true)
      .order('sort_order');

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/elements', requireAuth, async (req, res) => {
  try {
    const { name, image_url, thumbnail_url, element_type_id, allowed_zones, sort_order } = req.body;
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
        allowed_zones,
        sort_order: sort_order ?? 0,
        baker_id: null,
        is_active: true,
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
