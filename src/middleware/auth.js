import { supabase } from '../services/supabase.js';

export async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });

  req.user = user;
  next();
}

// Resolves whether the caller is a baker app-user or an admin.
// Sets req.bakerId (string) for baker users, null for admins.
// Must run after requireAuth.
export async function attachBakerContext(req, res, next) {
  const { data } = await supabase
    .from('baker_appusers')
    .select('baker_id')
    .eq('auth_user_id', req.user.id)
    .maybeSingle();

  req.bakerId = data?.baker_id ?? null;
  next();
}
