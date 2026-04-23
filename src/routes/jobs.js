import { Router } from 'express';
import { supabase } from '../services/supabase.js';
import { jobQueue } from '../jobs/queue.js';

const router = Router();

router.post('/jobs/extract', async (req, res) => {
  try {
    const { imageUrl, bakerId } = req.body;
    if (!imageUrl || !bakerId) {
      return res.status(400).json({ error: 'imageUrl and bakerId are required' });
    }

    const { data: job, error } = await supabase
      .from('jobs')
      .insert({ type: 'extract_image', payload: { imageUrl }, baker_id: bakerId })
      .select('id')
      .single();

    if (error) return res.status(500).json({ error: error.message });

    await jobQueue.add('extract_image', { jobId: job.id });
    res.json({ jobId: job.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
