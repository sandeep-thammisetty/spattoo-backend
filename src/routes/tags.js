import { Router } from 'express';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { jobQueue } from '../jobs/queue.js';

const router = Router();

// ── Tags vocabulary ───────────────────────────────────────────────────────────

router.get('/tags', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('tags')
      .select('id, name, slug, category, ai_assignable, sort_order')
      .eq('is_active', true)
      .order('category')
      .order('sort_order');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/tags', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('tags')
      .select('id, name, slug, category, ai_assignable, sort_order, is_active, created_at')
      .order('category')
      .order('sort_order');
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/tags', requireAuth, async (req, res) => {
  try {
    const { name, slug, category, ai_assignable = false, sort_order = 0 } = req.body;
    if (!name || !slug || !category) {
      return res.status(400).json({ error: 'name, slug and category are required' });
    }
    const { data, error } = await supabase
      .from('tags')
      .insert({ name, slug, category, ai_assignable, sort_order, is_active: true })
      .select('id, name, slug, category, ai_assignable, sort_order, is_active')
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/admin/tags/:id', requireAuth, async (req, res) => {
  try {
    const allowed = ['name', 'slug', 'category', 'ai_assignable', 'sort_order', 'is_active'];
    const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
    const { data, error } = await supabase
      .from('tags')
      .update(updates)
      .eq('id', req.params.id)
      .select('id, name, slug, category, ai_assignable, sort_order, is_active')
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/admin/tags/:id', requireAuth, async (req, res) => {
  try {
    // Check for existing usage before deleting
    const [{ count: ec }, { count: tc }] = await Promise.all([
      supabase.from('element_tags').select('*', { count: 'exact', head: true }).eq('tag_id', req.params.id),
      supabase.from('template_tags').select('*', { count: 'exact', head: true }).eq('tag_id', req.params.id),
    ]);
    if ((ec ?? 0) + (tc ?? 0) > 0) {
      return res.status(409).json({ error: `Tag is used by ${ec} element(s) and ${tc} template(s). Remove usages first.` });
    }
    const { error } = await supabase.from('tags').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Element tags ──────────────────────────────────────────────────────────────

router.get('/admin/elements/:id/tags', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('element_tags')
      .select('tag_id, source, confidence, tags(id, name, slug, category)')
      .eq('element_id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Replace all tags for an element
router.put('/admin/elements/:id/tags', requireAuth, async (req, res) => {
  try {
    const { tagIds = [] } = req.body;
    const elementId = req.params.id;
    await supabase.from('element_tags').delete().eq('element_id', elementId);
    if (tagIds.length > 0) {
      const rows = tagIds.map(tag_id => ({ element_id: elementId, tag_id, source: 'manual', confidence: null }));
      const { error } = await supabase.from('element_tags').insert(rows);
      if (error) return res.status(500).json({ error: error.message });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Re-run AI tagging for an element
router.post('/admin/elements/:id/retag', requireAuth, async (req, res) => {
  try {
    const { data: el, error } = await supabase
      .from('cake_elements')
      .select('id, name, thumbnail_url')
      .eq('id', req.params.id)
      .single();
    if (error) return res.status(404).json({ error: 'Element not found' });
    if (!el.thumbnail_url) return res.status(400).json({ error: 'Element has no thumbnail to analyse' });

    await jobQueue.add('auto_tag', { entityType: 'element', entityId: el.id, thumbnailKey: el.thumbnail_url, name: el.name });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Template tags ─────────────────────────────────────────────────────────────

router.get('/admin/templates/:id/tags', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('template_tags')
      .select('tag_id, source, confidence, tags(id, name, slug, category)')
      .eq('template_id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/admin/templates/:id/tags', requireAuth, async (req, res) => {
  try {
    const { tagIds = [] } = req.body;
    const templateId = req.params.id;
    await supabase.from('template_tags').delete().eq('template_id', templateId);
    if (tagIds.length > 0) {
      const rows = tagIds.map(tag_id => ({ template_id: templateId, tag_id, source: 'manual', confidence: null }));
      const { error } = await supabase.from('template_tags').insert(rows);
      if (error) return res.status(500).json({ error: error.message });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/templates/:id/retag', requireAuth, async (req, res) => {
  try {
    const { data: tmpl, error } = await supabase
      .from('cake_templates')
      .select('id, name, thumbnail_url')
      .eq('id', req.params.id)
      .single();
    if (error) return res.status(404).json({ error: 'Template not found' });
    if (!tmpl.thumbnail_url) return res.status(400).json({ error: 'Template has no thumbnail to analyse' });

    await jobQueue.add('auto_tag', { entityType: 'template', entityId: tmpl.id, thumbnailKey: tmpl.thumbnail_url, name: tmpl.name });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Template attrs ────────────────────────────────────────────────────────────

router.get('/admin/templates/:id/attrs', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('cake_template_attrs')
      .select('min_weight_kg, min_age, max_age')
      .eq('template_id', req.params.id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data ?? {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/admin/templates/:id/attrs', requireAuth, async (req, res) => {
  try {
    const { min_weight_kg, min_age, max_age } = req.body;
    const attrs = {
      template_id:   req.params.id,
      min_weight_kg: min_weight_kg ?? null,
      min_age:       min_age       ?? null,
      max_age:       max_age       ?? null,
      updated_at:    new Date().toISOString(),
    };
    const { error } = await supabase
      .from('cake_template_attrs')
      .upsert(attrs, { onConflict: 'template_id' });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
