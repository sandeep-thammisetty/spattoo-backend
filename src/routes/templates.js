import { Router } from 'express';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.get('/templates', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('cake_templates')
      .select('id, name, shape, tier_count, offering, design, thumbnail_url, sort_order')
      .eq('is_active', true)
      .order('sort_order');

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
