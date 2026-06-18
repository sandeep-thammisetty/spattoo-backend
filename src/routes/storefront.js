import { Router } from 'express';
import { supabase, supabaseAuth } from '../services/supabase.js';
import { config } from '../config.js';

const router = Router();

// Load an invite by id with its customer + baker, only if it's still VALID
// (not expired/revoked). Returns { invite, customer, baker } or null.
async function loadValidInvite(id) {
  const { data: invite } = await supabase
    .from('customer_invites')
    .select('id, status, channels, expires_at, customer_id, baker_id, customers(first_name, email, phone), bakers(slug, name)')
    .eq('id', id)
    .maybeSingle();
  if (!invite) return null;
  const expired = invite.expires_at != null && new Date(invite.expires_at) < new Date();
  if (expired || ['expired', 'revoked'].includes(invite.status)) return null;
  return invite;
}

// Resolve the raw contact for a channel from an invite's customer.
function contactFor(channel, customer) {
  if (channel === 'email') return customer?.email || null;
  if (channel === 'sms' || channel === 'whatsapp') return customer?.phone || null;
  return null;
}

function toPublicUrl(key) {
  if (!key) return null;
  if (/^https?:\/\//i.test(key)) return key;
  return `${config.r2.publicUrl}/${key}`;
}

// ── GET /api/storefront/:slug ─────────────────────────────────────────────────
// Public. The customer-facing storefront for a baker: branding + story.
// No auth — this is what a customer sees before entering the design space.
router.get('/storefront/:slug', async (req, res) => {
  try {
    const { data: baker, error } = await supabase
      .from('bakers')
      .select('id, name, slug, logo_url, primary_color, accent_color, tagline, story, portrait_url, instagram_handle, website_url, storefront_published, storefront_customizations, storefront_themes(key)')
      .eq('slug', req.params.slug)
      .eq('is_active', true)
      .maybeSingle();

    if (error)  return res.status(500).json({ error: error.message });
    if (!baker) return res.status(404).json({ error: 'Storefront not found' });
    // Draft storefronts are not publicly visible until the baker hits Publish.
    if (!baker.storefront_published) return res.status(404).json({ error: 'No storefront available' });

    // Gallery photos (ordered) — non-critical; absent is fine (storefront shows the fallback).
    const { data: photos } = await supabase
      .from('baker_storefront_photos')
      .select('storage_key, caption')
      .eq('baker_id', baker.id)
      .order('sort_order');

    res.json({
      name:             baker.name,
      slug:             baker.slug,
      logo_url:         toPublicUrl(baker.logo_url),
      primary_color:    baker.primary_color,
      accent_color:     baker.accent_color,
      tagline:          baker.tagline,
      story:            baker.story,
      portrait_url:     toPublicUrl(baker.portrait_url),
      instagram_handle: baker.instagram_handle,
      website_url:      baker.website_url,
      storefront_theme: baker.storefront_themes?.key || 'spotlight',
      storefront_customizations: baker.storefront_customizations || {},
      gallery:          (photos ?? []).map(p => ({ url: toPublicUrl(p.storage_key), caption: p.caption })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/invite/:id ───────────────────────────────────────────────────────
// Public landing for an invite link. Returns baker branding + the MASKED contact
// to prefill/lock on the login screen, plus validity. Marks the invite opened.
// The id grants nothing — OTP still gates access.
function maskEmail(e) {
  if (!e) return null;
  const [u, d] = e.split('@');
  if (!d) return null;
  return `${u.slice(0, 1)}${'•'.repeat(Math.max(1, u.length - 1))}@${d}`;
}
function maskPhone(p) {
  if (!p) return null;
  const digits = p.replace(/\D/g, '');
  return digits.length <= 4 ? p : `${'•'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}

router.get('/invite/:id', async (req, res) => {
  try {
    const { data: invite, error } = await supabase
      .from('customer_invites')
      .select('id, status, channels, expires_at, customers(first_name, email, phone), bakers(name, slug, logo_url, primary_color, accent_color)')
      .eq('id', req.params.id)
      .maybeSingle();

    if (error)   return res.status(500).json({ error: error.message });
    if (!invite) return res.status(404).json({ error: 'Invite not found' });

    const expired = invite.expires_at != null && new Date(invite.expires_at) < new Date();
    const dead    = ['expired', 'revoked'].includes(invite.status);
    const valid   = !expired && !dead;

    // Mark opened on first view (analytics; harmless side effect).
    if (valid && ['pending', 'sent'].includes(invite.status)) {
      await supabase.from('customer_invites')
        .update({ status: 'opened', opened_at: new Date().toISOString() })
        .eq('id', invite.id);
    }

    const baker = invite.bakers;
    const cust  = invite.customers;
    res.json({
      valid,
      expired,
      baker: {
        name: baker?.name,
        slug: baker?.slug,
        logo_url: toPublicUrl(baker?.logo_url),
        primary_color: baker?.primary_color,
        accent_color: baker?.accent_color,
      },
      // Masked + which channels the OTP can go to. Raw contact is never exposed here.
      customer: {
        first_name: cust?.first_name,
        masked_email: maskEmail(cust?.email),
        masked_phone: maskPhone(cust?.phone),
        channels: invite.channels,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/invite/:id/send-otp ─────────────────────────────────────────────
// Server-side OTP send. The raw contact never leaves the server — the client
// only knows the invite id + chosen channel. Body: { channel? } (default email).
router.post('/invite/:id/send-otp', async (req, res) => {
  try {
    if (!supabaseAuth) return res.status(503).json({ error: 'Auth not configured' });
    const invite = await loadValidInvite(req.params.id);
    if (!invite) return res.status(410).json({ error: 'Invite is no longer valid' });

    const channel = req.body?.channel || 'email';
    const to = contactFor(channel, invite.customers);
    if (!to) return res.status(400).json({ error: `No ${channel} contact on file for this invite` });

    const { error } = channel === 'email'
      ? await supabaseAuth.auth.signInWithOtp({ email: to })
      : await supabaseAuth.auth.signInWithOtp({ phone: to });
    if (error) return res.status(502).json({ error: error.message });

    if (['pending', 'opened'].includes(invite.status)) {
      await supabase.from('customer_invites')
        .update({ status: 'sent', sent_at: new Date().toISOString() })
        .eq('id', invite.id);
    }
    res.json({ sent: true, channel });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/invite/:id/verify-otp ───────────────────────────────────────────
// Verify the code server-side and return the Supabase session for the client to
// adopt (supabase.auth.setSession). Body: { channel?, code }.
router.post('/invite/:id/verify-otp', async (req, res) => {
  try {
    if (!supabaseAuth) return res.status(503).json({ error: 'Auth not configured' });
    const invite = await loadValidInvite(req.params.id);
    if (!invite) return res.status(410).json({ error: 'Invite is no longer valid' });

    const channel = req.body?.channel || 'email';
    const code = String(req.body?.code || '').trim();
    if (!code) return res.status(400).json({ error: 'code is required' });
    const to = contactFor(channel, invite.customers);
    if (!to) return res.status(400).json({ error: `No ${channel} contact on file` });

    // Verify type depends on how the OTP was issued: new user → 'signup',
    // existing user login → 'magiclink', plus the unified 'email'. We don't know
    // which up front, so try in order — a wrong-type attempt doesn't consume the
    // token, so the correct type still succeeds.
    let data = null, error = null;
    const types = channel === 'email' ? ['email', 'magiclink', 'signup'] : ['sms'];
    for (const type of types) {
      const r = channel === 'email'
        ? await supabaseAuth.auth.verifyOtp({ email: to, token: code, type })
        : await supabaseAuth.auth.verifyOtp({ phone: to, token: code, type });
      if (r.data?.session) { data = r.data; error = null; break; }
      error = r.error;
    }
    if (!data?.session) return res.status(401).json({ error: error?.message || 'Invalid or expired code' });

    res.json({
      session: {
        access_token:  data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at:    data.session.expires_at,
      },
      customer_id: invite.customer_id,
      baker_slug:  invite.bakers?.slug,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
