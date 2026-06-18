import { Router } from 'express';
import { supabase } from '../services/supabase.js';
import { getTask } from '../services/meshy.js';
import { finalizeOrUpdate } from './meshy.js';

const router = Router();

// ── POST /webhooks/meshy ──────────────────────────────────────────────────────
// Meshy's webhook is ACCOUNT-GLOBAL (one HTTPS URL configured in the Meshy dashboard);
// it POSTs the task object on completion. There is no documented signature, so we do NOT
// trust the body: we read only the task id from it, then RE-FETCH the authoritative task
// via the API before finalizing. Always return 200 so Meshy doesn't retry-spam.
// Raw-body mounting happens in server.js (before express.json()).
router.post('/webhooks/meshy', async (req, res) => {
  try {
    const payload = JSON.parse(req.body.toString());
    const taskId = payload?.id ?? payload?.task_id ?? payload?.result;
    if (!taskId) return res.json({ ok: true });

    const { data: row } = await supabase
      .from('meshy_generations').select('*').eq('meshy_task_id', taskId).maybeSingle();
    if (!row) return res.json({ ok: true });

    // Verify by re-fetching — don't act on the unsigned webhook body directly.
    const task = await getTask(taskId);
    await finalizeOrUpdate(row, task);

    res.json({ ok: true });
  } catch (err) {
    console.error('Meshy webhook error:', err.message);
    res.json({ ok: true }); // swallow — never trigger Meshy redelivery
  }
});

export default router;
