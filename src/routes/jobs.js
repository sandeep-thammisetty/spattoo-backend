import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { supabase } from '../services/supabase.js';
import { jobQueue } from '../jobs/queue.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/rbac.js';

const router = Router();

router.post('/jobs/extract', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { imageUrl } = req.body;
    if (!imageUrl) {
      return res.status(400).json({ error: 'imageUrl is required' });
    }

    const { data: job, error } = await supabase
      .from('jobs')
      .insert({ type: 'extract_image', payload: { imageUrl }, baker_id: req.user.id })
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
