import { Router } from 'express';
import { randomBytes } from 'crypto';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { config } from '../config.js';

function toPublicUrl(key) {
  if (!key) return null;
  return `${config.r2.publicUrl}/${key}`;
}

const router = Router();

router.post('/admin/bakers', requireAuth, async (req, res) => {
  try {
    const {
      name, slug, email, tagline,
      instagram_handle, website_url,
      primary_color, accent_color, logo_url,
      subscription_tier, trial_ends_at,
      currency_code, timezone,
      primaryUser,
    } = req.body;

    if (!name || !slug) {
      return res.status(400).json({ error: 'name and slug are required' });
    }
    if (!primaryUser?.first_name || !primaryUser?.last_name || !primaryUser?.email) {
      return res.status(400).json({ error: 'primaryUser.first_name, last_name, and email are required' });
    }

    // Check slug uniqueness before creating the auth user
    const { data: existing } = await supabase
      .from('bakers')
      .select('id')
      .eq('slug', slug)
      .maybeSingle();
    if (existing) return res.status(409).json({ error: 'Slug already taken' });

    const tempPassword = randomBytes(6).toString('hex') + 'Aa1!';

    // Auth account is created for the primary user, not the business contact
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email:         primaryUser.email,
      password:      tempPassword,
      email_confirm: true,
    });
    if (authError) return res.status(400).json({ error: authError.message });

    const tier = subscription_tier ?? 'trial';
    const { data, error } = await supabase
      .from('bakers')
      .insert({
        name,
        slug,
        email: email || null,
        tagline:             tagline || null,
        instagram_handle:    instagram_handle || null,
        website_url:         website_url || null,
        primary_color:       primary_color || null,
        accent_color:        accent_color || null,
        logo_url:            logo_url || null,
        subscription_tier:   tier,
        subscription_status: tier === 'trial' ? 'trial' : 'active',
        trial_ends_at:       trial_ends_at || null,
        currency_code:       currency_code || 'INR',
        timezone:            timezone || 'Asia/Kolkata',
        auth_user_id:        authData.user.id,
        is_active:           true,
      })
      .select('id')
      .single();

    if (error) {
      await supabase.auth.admin.deleteUser(authData.user.id);
      return res.status(500).json({ error: error.message });
    }

    // Insert primary user into baker_appusers
    const { error: userError } = await supabase
      .from('baker_appusers')
      .insert({
        baker_id:        data.id,
        first_name:      primaryUser.first_name,
        last_name:       primaryUser.last_name,
        email:           primaryUser.email,
        phone:           primaryUser.phone || null,
        whatsapp_number: primaryUser.whatsapp_number || null,
        role:            'owner',
        is_primary:      true,
        auth_user_id:    authData.user.id,
      });

    if (userError) {
      // Roll back: delete baker row and auth user
      await supabase.from('bakers').delete().eq('id', data.id);
      await supabase.auth.admin.deleteUser(authData.user.id);
      return res.status(500).json({ error: userError.message });
    }

    res.status(201).json({ id: data.id, tempPassword });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/baker/profile', requireAuth, async (req, res) => {
  try {
    const { data: contact } = await supabase
      .from('baker_appusers')
      .select('first_name, last_name, baker_id')
      .eq('auth_user_id', req.user.id)
      .maybeSingle();
    if (!contact) return res.status(404).json({ error: 'No baker account found' });

    const { data: baker } = await supabase
      .from('bakers')
      .select('id, name, logo_url, primary_color, accent_color')
      .eq('id', contact.baker_id)
      .single();
    if (!baker) return res.status(404).json({ error: 'Baker not found' });

    res.json({
      baker: { id: baker.id, name: baker.name, logo_url: toPublicUrl(baker.logo_url), primary_color: baker.primary_color, accent_color: baker.accent_color },
      user: { firstName: contact.first_name, lastName: contact.last_name, email: req.user.email },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/bakers', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('bakers')
      .select('id, name, slug, email, subscription_tier, subscription_status, is_active, created_at')
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
