import { supabase } from '../services/supabase.js';
import { jobQueue } from './queue.js';

// Backstop only. The primary dispatch is the immediate enqueue in insertNotification;
// this sweep just RECOVERS rows that failed to enqueue (e.g. Redis was down). So it
// runs infrequently and ignores brand-new rows (they're being enqueued right now) —
// only rows stuck 'pending' past the grace window are genuinely orphaned.
const SWEEP_INTERVAL_MS = 120_000;   // 2 min — recovery cadence, not the hot path
const BACKSTOP_GRACE_MS = 60_000;    // give immediate enqueue time before we step in

async function sweep() {
  try {
    const cutoff = new Date(Date.now() - BACKSTOP_GRACE_MS).toISOString();
    const { data: pending, error } = await supabase
      .from('notifications')
      .select('id, attempts, max_attempts')
      .eq('status', 'pending')
      .lt('created_at', cutoff)
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
