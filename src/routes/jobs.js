import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { supabase } from '../services/supabase.js';
import { jobQueue } from '../jobs/queue.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/rbac.js';

const router = Router();

// SEC-15: under the `/api/admin` boundary (mounted at `/api`) so `requireAdmin` backstops it,
// consistent with sibling catalog-admin routes. Per-route capability guard kept on top.
router.post('/admin/jobs/extract', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { imageUrl } = req.body;
    if (!imageUrl) {
      return res.status(400).json({ error: 'imageUrl is required' });
    }

    // SEC-13: this is an internal admin catalog job with no owning baker; `baker_id` references
    // bakers(id) (a UUID), so writing the auth-user id was both wrong and FK-invalid. A global
    // (baker-less) catalog job is baker_id NULL — matching the `baker_id IS NULL = global` convention.
    const { data: job, error } = await supabase
      .from('jobs')
      .insert({ type: 'extract_image', payload: { imageUrl }, baker_id: null })
      .select('id')
      .single();

    if (error) return serverError(req, res, error);

    await jobQueue.add('extract_image', { jobId: job.id });
    res.json({ jobId: job.id });
  } catch (err) {
    serverError(req, res, err);
  }
});

export default router;
