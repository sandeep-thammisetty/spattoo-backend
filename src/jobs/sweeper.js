import { supabase } from '../services/supabase.js';
import { jobQueue } from './queue.js';

const SWEEP_INTERVAL_MS = 30_000;

async function sweep() {
  try {
    const { data: pending, error } = await supabase
      .from('notifications')
      .select('id, attempts, max_attempts')
      .eq('status', 'pending')
      .limit(50);

    if (error) throw error;

    const eligible = (pending ?? []).filter(n => n.attempts < n.max_attempts);
    if (!eligible.length) return;

    for (const n of eligible) {
      // Claim the row — extra .eq('status','pending') acts as optimistic lock
      const { error: claimErr } = await supabase
        .from('notifications')
        .update({ status: 'enqueued', attempts: n.attempts + 1 })
        .eq('id', n.id)
        .eq('status', 'pending');

      if (claimErr) {
        console.error(`[sweeper] failed to claim ${n.id}:`, claimErr.message);
        continue;
      }

      await jobQueue.add('send_notification', { notificationId: n.id }, {
        attempts:         1,
        removeOnComplete: true,
        removeOnFail:     true,
      });
    }

    console.log(`[sweeper] enqueued ${eligible.length} notification(s)`);
  } catch (err) {
    console.error('[sweeper] error:', err.message);
  }
}

export function startSweeper() {
  sweep(); // pick up anything pending from before this restart
  setInterval(sweep, SWEEP_INTERVAL_MS);
  console.log('Sweeper started');
}
