import { Router } from 'express';
import nodemailer from 'nodemailer';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/rbac.js';
import { config } from '../config.js';

const router = Router();

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Branded, email-client-safe (table layout, inline styles) invite email.
export function buildInviteEmail({ bakerName, firstName, link, brandColor, logoUrl, note, expiresAt }) {
  const brand = brandColor || '#2C4433';
  const greet = firstName ? `Hi ${esc(firstName)},` : 'Hi there,';
  const expiry = expiresAt
    ? new Date(expiresAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
    : null;
  const safeBaker = esc(bakerName);

  const subject = `You're invited to design your cake with ${bakerName}`;

  const text = [
    `${greet}`,
    ``,
    `${bakerName} invited you to design your cake. Use our interactive 3D designer to shape it, choose flavours, and add decorations — exactly the way you imagine it.`,
    note ? `\nA note from ${bakerName}: "${note}"` : ``,
    ``,
    `Start designing: ${link}`,
    expiry ? `\nThis private link is just for you and expires on ${expiry}.` : ``,
    ``,
    `If you weren't expecting this, you can safely ignore this email.`,
  ].filter(Boolean).join('\n');

  const header = logoUrl
    ? `<img src="${esc(logoUrl)}" alt="${safeBaker}" width="64" height="64" style="border-radius:50%;display:block;margin:0 auto;border:0;" />`
    : `<div style="width:64px;height:64px;line-height:64px;border-radius:50%;background:${brand};color:#ffffff;font-size:28px;font-weight:700;text-align:center;margin:0 auto;font-family:Arial,sans-serif;">${esc((bakerName || '?').slice(0,1).toUpperCase())}</div>`;

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#EDEAE2;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EDEAE2;padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:16px;overflow:hidden;font-family:'Helvetica Neue',Arial,sans-serif;">
        <tr><td style="padding:36px 36px 8px;text-align:center;">
          ${header}
          <h1 style="margin:20px 0 0;font-size:22px;color:${brand};font-weight:800;">${safeBaker} invited you to<br/>design your cake</h1>
        </td></tr>
        <tr><td style="padding:20px 36px 0;color:#3C4A40;font-size:15px;line-height:1.6;">
          <p style="margin:0 0 14px;">${greet}</p>
          <p style="margin:0 0 14px;"><strong>${safeBaker}</strong> would love for you to create your perfect cake. Use our interactive 3D designer to shape it, choose flavours, and add decorations — exactly the way you imagine it.</p>
          ${note ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-left:3px solid ${brand};background:#F7F5F0;padding:12px 16px;border-radius:6px;color:#55615A;font-style:italic;font-size:14px;">"${esc(note)}"<br/><span style="font-style:normal;font-size:12px;color:#9aa;">— ${safeBaker}</span></td></tr></table>` : ``}
        </td></tr>
        <tr><td style="padding:28px 36px 8px;text-align:center;">
          <a href="${esc(link)}" style="display:inline-block;background:${brand};color:#ffffff;text-decoration:none;font-size:16px;font-weight:700;padding:14px 34px;border-radius:12px;">Start designing &rarr;</a>
        </td></tr>
        <tr><td style="padding:8px 36px 32px;text-align:center;color:#9aa;font-size:12px;line-height:1.6;">
          ${expiry ? `<p style="margin:0 0 6px;">This private link is just for you and expires on <strong>${expiry}</strong>.</p>` : ``}
          <p style="margin:0;">If you weren't expecting this, you can safely ignore this email.</p>
        </td></tr>
      </table>
      <p style="max-width:480px;margin:16px auto 0;color:#9aa;font-size:11px;font-family:Arial,sans-serif;text-align:center;">Powered by Spattoo</p>
    </td></tr>
  </table>
</body></html>`;

  return { subject, text, html };
}

// Best-effort invite email. Never throws — returns { sent, reason? } so a missing
// SMTP config (or send failure) doesn't block invite creation.
async function sendInviteEmail({ to, ...data }) {
  if (!to) return { sent: false, reason: 'no email' };
  if (!config.smtp.host) return { sent: false, reason: 'smtp not configured' };
  try {
    const transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
    const { subject, text, html } = buildInviteEmail(data);
    await transport.sendMail({ from: config.smtp.from, to, subject, text, html });
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

// ── Resolve baker_id from auth user ──────────────────────────────────────────
async function getBakerId(userId) {
  const { data } = await supabase
    .from('baker_appusers').select('baker_id')
    .eq('auth_user_id', userId).maybeSingle();
  return data?.baker_id ?? null;
}

// ── GET /api/baker/customers ──────────────────────────────────────────────────
// ?include_inactive=true  → include deactivated customers
// ?q=search               → filter by name / phone / email

router.get('/baker/customers', requireAuth, requireCapability('customer:manage'), async (req, res) => {
  try {
    const bakerId = await getBakerId(req.user.id);
    if (!bakerId) return res.status(403).json({ error: 'Not a baker account' });

    const includeInactive = req.query.include_inactive === 'true';
    const q    = req.query.q?.trim().toLowerCase();
    const from = req.query.from;

    let query = supabase
      .from('customers')
      .select('id, first_name, last_name, email, phone, is_active, source, created_at')
      .eq('baker_id', bakerId)
      .order('first_name');

    if (!includeInactive) query = query.eq('is_active', true);
    if (from)             query = query.gte('created_at', from);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const result = q
      ? data.filter(c => {
          const name = `${c.first_name ?? ''} ${c.last_name ?? ''}`.toLowerCase();
          return name.includes(q) || (c.phone ?? '').includes(q) || (c.email ?? '').toLowerCase().includes(q);
        })
      : data;

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/baker/customers ─────────────────────────────────────────────────
// Body: { firstName, lastName?, email?, phone? }

router.post('/baker/customers', requireAuth, requireCapability('customer:manage'), async (req, res) => {
  try {
    const bakerId = await getBakerId(req.user.id);
    if (!bakerId) return res.status(403).json({ error: 'Not a baker account' });

    const { firstName, lastName, email, phone } = req.body;
    if (!firstName?.trim())                  return res.status(400).json({ error: 'firstName is required' });
    if (!phone?.trim() && !email?.trim())    return res.status(400).json({ error: 'phone or email is required' });

    const { data, error } = await supabase
      .from('customers')
      .insert({
        baker_id:   bakerId,
        first_name: firstName.trim(),
        last_name:  lastName?.trim() || null,
        email:      email?.trim().toLowerCase() || null,
        phone:      phone?.trim() || null,
        source:     'manual',
        is_active:  true,
      })
      .select('id, first_name, last_name, email, phone, is_active, source, created_at')
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/baker/customers/:id ────────────────────────────────────────────
// Body: { firstName?, lastName?, email?, phone? }

router.patch('/baker/customers/:id', requireAuth, requireCapability('customer:manage'), async (req, res) => {
  try {
    const bakerId = await getBakerId(req.user.id);
    if (!bakerId) return res.status(403).json({ error: 'Not a baker account' });

    const { firstName, lastName, email, phone } = req.body;

    const updates = {};
    if (firstName !== undefined) updates.first_name = firstName?.trim() || null;
    if (lastName  !== undefined) updates.last_name  = lastName?.trim()  || null;
    if (email     !== undefined) updates.email      = email?.trim().toLowerCase() || null;
    if (phone     !== undefined) updates.phone      = phone?.trim() || null;

    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No fields to update' });
    if (updates.first_name === null)   return res.status(400).json({ error: 'firstName cannot be empty' });

    const { data, error } = await supabase
      .from('customers').update(updates)
      .eq('id', req.params.id).eq('baker_id', bakerId)
      .select('id, first_name, last_name, email, phone, is_active, source, created_at')
      .maybeSingle();

    if (error)  return res.status(500).json({ error: error.message });
    if (!data)  return res.status(404).json({ error: 'Customer not found' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/baker/customers/:id/deactivate ─────────────────────────────────

router.patch('/baker/customers/:id/deactivate', requireAuth, requireCapability('customer:manage'), async (req, res) => {
  try {
    const bakerId = await getBakerId(req.user.id);
    if (!bakerId) return res.status(403).json({ error: 'Not a baker account' });

    const { data, error } = await supabase
      .from('customers').update({ is_active: false })
      .eq('id', req.params.id).eq('baker_id', bakerId)
      .select('id, is_active').maybeSingle();

    if (error)  return res.status(500).json({ error: error.message });
    if (!data)  return res.status(404).json({ error: 'Customer not found' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/baker/customers/:id/reactivate ─────────────────────────────────

router.patch('/baker/customers/:id/reactivate', requireAuth, requireCapability('customer:manage'), async (req, res) => {
  try {
    const bakerId = await getBakerId(req.user.id);
    if (!bakerId) return res.status(403).json({ error: 'Not a baker account' });

    const { data, error } = await supabase
      .from('customers').update({ is_active: true })
      .eq('id', req.params.id).eq('baker_id', bakerId)
      .select('id, is_active').maybeSingle();

    if (error)  return res.status(500).json({ error: error.message });
    if (!data)  return res.status(404).json({ error: 'Customer not found' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/baker/customers/invite ──────────────────────────────────────────
// Upsert the customer (dedupe the person by contact), then create an invite EVENT
// and return the link. OTP/login is enforced later via the invite gate.
// Body: { firstName, lastName?, email?, phone?, channels?, note?, expiresInDays? }
router.post('/baker/customers/invite', requireAuth, requireCapability('customer:manage'), async (req, res) => {
  try {
    const bakerId = req.bakerId;
    if (!bakerId) return res.status(400).json({ error: 'Baker context required' });

    const { firstName, lastName, email, phone, channels, note, expiresInDays = 14 } = req.body;
    const emailNorm = email?.trim().toLowerCase() || null;
    const phoneNorm = phone?.trim() || null;
    if (!firstName?.trim())        return res.status(400).json({ error: 'firstName is required' });
    if (!emailNorm && !phoneNorm)  return res.status(400).json({ error: 'email or phone is required' });

    // ── Upsert the customer (the person) — dedupe by email, else phone ──────────
    let lookup = supabase.from('customers').select('id').eq('baker_id', bakerId);
    lookup = emailNorm ? lookup.eq('email', emailNorm) : lookup.eq('phone', phoneNorm);
    let { data: customer } = await lookup.maybeSingle();

    if (!customer) {
      const { data: created, error: cErr } = await supabase
        .from('customers')
        .insert({
          baker_id:   bakerId,
          first_name: firstName.trim(),
          last_name:  lastName?.trim() || null,
          email:      emailNorm,
          phone:      phoneNorm,
          source:     'invite',
          is_active:  true,
        })
        .select('id')
        .single();
      if (cErr) return res.status(500).json({ error: cErr.message });
      customer = created;
    }

    // ── Who is sending it (audit) + baker slug for the link ─────────────────────
    const [{ data: appUser }, { data: baker }] = await Promise.all([
      supabase.from('baker_appusers').select('id').eq('auth_user_id', req.user.id).eq('baker_id', bakerId).maybeSingle(),
      supabase.from('bakers').select('slug, name, primary_color, logo_url').eq('id', bakerId).single(),
    ]);

    // Default channels from the contact we have, unless the caller specifies.
    const resolvedChannels = Array.isArray(channels) && channels.length
      ? channels
      : [emailNorm && 'email', phoneNorm && 'sms'].filter(Boolean);

    const expiresAt = expiresInDays
      ? new Date(Date.now() + expiresInDays * 86400000).toISOString()
      : null;

    // ── Create the invite event ─────────────────────────────────────────────────
    const { data: invite, error: iErr } = await supabase
      .from('customer_invites')
      .insert({
        baker_id:    bakerId,
        customer_id: customer.id,
        channels:    resolvedChannels.length ? resolvedChannels : ['link'],
        status:      'pending',
        note:        note?.trim() || null,
        expires_at:  expiresAt,
        created_by:  appUser?.id ?? null,
      })
      .select('id, status, channels, note, expires_at, created_at')
      .single();
    if (iErr) return res.status(500).json({ error: iErr.message });

    // Subdomain link: {slug}.<storefront domain>. The invite id grants nothing — OTP gates access.
    const link = `${config.storefront.urlTemplate.replace('{slug}', baker.slug)}/?invite=${invite.id}`;

    // Best-effort email send (SMS/WhatsApp recorded but not yet sent).
    const logoUrl = baker.logo_url
      ? (/^https?:\/\//i.test(baker.logo_url) ? baker.logo_url : `${config.r2.publicUrl}/${baker.logo_url}`)
      : null;
    const emailResult = resolvedChannels.includes('email')
      ? await sendInviteEmail({
          to: emailNorm,
          link,
          bakerName: baker.name,
          firstName: firstName.trim(),
          brandColor: baker.primary_color,
          logoUrl,
          note: note?.trim() || null,
          expiresAt,
        })
      : { sent: false, reason: 'email not a channel' };

    if (emailResult.sent) {
      await supabase.from('customer_invites')
        .update({ status: 'sent', sent_at: new Date().toISOString() })
        .eq('id', invite.id);
      invite.status = 'sent';
    }

    res.status(201).json({
      customer_id: customer.id,
      invite,
      link,
      delivery: { email: emailResult },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
