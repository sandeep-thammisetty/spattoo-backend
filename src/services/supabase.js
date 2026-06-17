import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';

export const supabase = createClient(config.supabase.url, config.supabase.serviceKey);

// Anon client for customer OTP auth ops (signInWithOtp / verifyOtp). Uses the
// public anon key, not the service key, and never persists a session server-side.
export const supabaseAuth = config.supabase.anonKey
  ? createClient(config.supabase.url, config.supabase.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

export async function getJob(jobId) {
  const { data, error } = await supabase
    .from('jobs')
    .select('*')
    .eq('id', jobId)
    .single();
  if (error) throw error;
  return data;
}

export async function updateJob(jobId, status, extra = {}) {
  const { error } = await supabase
    .from('jobs')
    .update({ status, updated_at: new Date().toISOString(), ...extra })
    .eq('id', jobId);
  if (error) throw error;
}
