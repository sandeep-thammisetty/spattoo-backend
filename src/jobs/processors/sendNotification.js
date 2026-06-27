import nodemailer from 'nodemailer';
import { config } from '../../config.js';
import { supabase } from '../../services/supabase.js';

const transporter = nodemailer.createTransport({
  host:   config.smtp.host,
  port:   config.smtp.port,
  secure: config.smtp.port === 465,
  auth: { user: config.smtp.user, pass: config.smtp.pass },
});

function formatDate(str) {
  if (!str) return '—';
  return new Date(str).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Branded, email-client-safe (table layout, inline styles) invite email. Returns
// { subject, text, html }. Kept here (with the other notification templates) so the
// invite flows through the same durable outbox pipeline as every other email.
function buildInviteEmail({ bakerName, firstName, link, brandColor, logoUrl, note, expiresAt }) {
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

function orderDetailsHtml(p) {
  const rows = [
    ['Customer',     p.customerName],
    p.customerEmail ? ['Email', p.customerEmail] : null,
    p.customerPhone ? ['Phone', p.customerPhone] : null,
    ['Delivery',     `${formatDate(p.deliveryDate)}${p.deliveryTime ? ' at ' + p.deliveryTime : ''}`],
    ['Mode',         p.deliveryMode === 'home_delivery' ? 'Home Delivery' : 'Pickup'],
    p.deliveryAddress ? ['Address', p.deliveryAddress] : null,
    p.weightKg ? ['Weight', `${p.weightKg} kg`] : null,
    p.flavours?.length ? ['Flavours', p.flavours.map(f => f.name ?? f.flavour ?? f).join(', ')] : null,
    p.specialInstructions ? ['Instructions', p.specialInstructions] : null,
  ].filter(Boolean);

  return `<table style="width:100%;border-collapse:collapse;font-family:sans-serif;font-size:14px;color:#333">
    ${rows.map(([label, value]) => `
      <tr>
        <td style="padding:6px 0;color:#888;width:160px">${label}</td>
        <td style="padding:6px 0">${value}</td>
      </tr>`).join('')}
  </table>`;
}

function rawEmail(from) {
  const match = from.match(/<([^>]+)>/);
  return match ? match[1] : from;
}

function buildEmail(typeSlug, recipientEmail, payload) {
  const p = payload;

  const thumbnailHtml = p.thumbnailUrl
    ? `<img src="${p.thumbnailUrl}" alt="Cake design" style="display:block;max-width:100%;border-radius:8px;margin:16px 0" />`
    : '';

  if (typeSlug === 'order_placed_baker') {
    return {
      from:    config.smtp.from,
      to:      recipientEmail,
      subject: `New quote request — ${p.customerName}`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto">
        <h2 style="color:#2C4433">New quote request</h2>
        <p>You have a new cake quote request from <b>${p.customerName}</b>. Review the design and send them a quote.</p>
        ${thumbnailHtml}
        ${orderDetailsHtml(p)}
        <p style="margin-top:24px;color:#888;font-size:12px">Log in to your Spattoo dashboard to review and quote this request.</p>
      </div>`,
    };
  }

  if (typeSlug === 'order_placed_customer') {
    // This fires when the customer places a request — every order starts at
    // 'requested' (quote-first flow). It is NOT a confirmation; the actual
    // confirmation is `order_confirmed_customer`, sent after the baker confirms.
    return {
      from:    `${p.bakerName} <${rawEmail(config.smtp.from)}>`,
      to:      recipientEmail,
      subject: `Your cake request was sent to ${p.bakerName}`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto">
        <h2 style="color:#2C4433">Request sent!</h2>
        <p>Hi ${p.customerFirstName}, thanks for designing your cake with <b>${p.bakerName}</b>. Your request has been sent — <b>${p.bakerName}</b> will review your design and get back to you with a quote. Here's what you requested:</p>
        ${thumbnailHtml}
        ${orderDetailsHtml(p)}
        <p style="margin-top:24px">We'll email you as soon as your quote is ready. If you have any questions, contact your baker directly.</p>
        <p style="color:#888;font-size:12px;margin-top:24px">Powered by Spattoo</p>
      </div>`,
    };
  }

  if (typeSlug === 'design_updated_customer') {
    const isReco = p.mode === 'recommendations';
    const link = p.bakerSlug
      ? config.storefront.urlTemplate.replace('{slug}', p.bakerSlug)
      : null;
    return {
      from:    `${p.bakerName} <${rawEmail(config.smtp.from)}>`,
      to:      recipientEmail,
      subject: isReco
        ? `${p.bakerName} has design ideas for your cake`
        : `${p.bakerName} updated your cake design`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto">
        <h2 style="color:#2C4433">${isReco ? 'A few ideas for your cake' : 'Your design was updated'}</h2>
        <p>Hi ${p.customerFirstName}, <b>${p.bakerName}</b> ${isReco
          ? 'has suggested some changes to your cake design'
          : 'has updated your cake design'}. Open the designer to take a look — you can keep refining it yourself.</p>
        ${thumbnailHtml}
        ${link ? `<p style="margin-top:24px"><a href="${link}" style="display:inline-block;background:#2C4433;color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:700">View your design</a></p>` : ''}
        <p style="color:#888;font-size:12px;margin-top:24px">Powered by Spattoo</p>
      </div>`,
    };
  }

  if (typeSlug === 'quote_issued_customer') {
    // Deep-link to the customer's quote summary screen (review + accept), not the
    // storefront root.
    const base = p.bakerSlug ? config.storefront.urlTemplate.replace('{slug}', p.bakerSlug) : null;
    const link = base && p.orderId ? `${base.replace(/\/+$/, '')}/orders/${p.orderId}` : base;
    const priceLine = p.quotedPrice != null ? `Your quote: <b>₹${p.quotedPrice}</b>` : "Your quote is ready";
    const advanceLine = p.advanceAmount != null
      ? `<p style="font-size:14px;color:#444">Advance to confirm: <b>₹${p.advanceAmount}</b></p>` : "";
    const validLine = p.quoteValidUntil
      ? `<p style="color:#888;font-size:13px">Valid until ${formatDate(p.quoteValidUntil)}.</p>`
      : "";
    const noteLine = p.quoteNote
      ? `<p style="background:#f6f4ef;border-radius:8px;padding:12px 14px;font-style:italic;color:#444">&ldquo;${p.quoteNote}&rdquo; — ${p.bakerName}</p>` : "";
    return {
      from:    `${p.bakerName} <${rawEmail(config.smtp.from)}>`,
      to:      recipientEmail,
      subject: `${p.bakerName} sent you a quote`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto">
        <h2 style="color:#2C4433">Your quote is ready</h2>
        <p>Hi ${p.customerFirstName}, <b>${p.bakerName}</b> has priced your cake.</p>
        <p style="font-size:16px">${priceLine}</p>
        ${advanceLine}
        ${validLine}
        ${noteLine}
        ${link ? `<p style="margin-top:24px"><a href="${link}" style="display:inline-block;background:#2C4433;color:#fff;text-decoration:none;padding:12px 28px;border-radius:10px;font-weight:700">Review your quote</a></p>` : ''}
        <p style="color:#888;font-size:12px;margin-top:24px">Powered by Spattoo</p>
      </div>`,
    };
  }

  if (typeSlug === 'quote_accepted_baker') {
    return {
      from:    config.smtp.from,
      to:      recipientEmail,
      subject: `Quote approved — ${p.customerName || 'a customer'}`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto">
        <h2 style="color:#2C4433">Quote approved</h2>
        <p><b>${p.customerName || 'A customer'}</b> is happy with your quote${p.finalPrice != null ? ` of <b>₹${p.finalPrice}</b>` : ''}. Collect the advance and confirm the order to lock it in.</p>
        <p style="margin-top:24px;color:#888;font-size:12px">Open your Spattoo dashboard to confirm.</p>
      </div>`,
    };
  }

  if (typeSlug === 'quote_question_baker') {
    return {
      from:    config.smtp.from,
      to:      recipientEmail,
      subject: `Question on your quote — ${p.customerName || 'a customer'}`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto">
        <h2 style="color:#2C4433">A question on your quote</h2>
        <p><b>${p.customerName || 'A customer'}</b> has a question about the quote you sent:</p>
        <p style="background:#f6f4ef;border-radius:8px;padding:12px 14px;font-style:italic;color:#444">&ldquo;${p.message}&rdquo;</p>
        <p style="margin-top:24px;color:#888;font-size:12px">Reply by revising the quote in your dashboard, or reach out to them directly.</p>
      </div>`,
    };
  }

  if (typeSlug === 'order_confirmed_customer') {
    return {
      from:    `${p.bakerName} <${rawEmail(config.smtp.from)}>`,
      to:      recipientEmail,
      subject: `Your order is confirmed by ${p.bakerName}!`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto">
        <h2 style="color:#2C4433">Your order is confirmed by ${p.bakerName}</h2>
        <p>Hi ${p.customerFirstName}, <b>${p.bakerName}</b> has confirmed your order${p.finalPrice != null ? ` (<b>₹${p.finalPrice}</b>)` : ''} — it's all set, they're on it!</p>
        ${thumbnailHtml}
        <p style="color:#888;font-size:12px;margin-top:24px">Powered by Spattoo</p>
      </div>`,
    };
  }

  if (typeSlug === 'order_ready_customer') {
    const isDelivery = p.deliveryMode === 'home_delivery';
    const when = p.deliveryDate ? ` on ${formatDate(p.deliveryDate)}${p.deliveryTime ? ' at ' + p.deliveryTime : ''}` : '';
    return {
      from:    `${p.bakerName} <${rawEmail(config.smtp.from)}>`,
      to:      recipientEmail,
      subject: `Your order from ${p.bakerName} is ready!`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto">
        <h2 style="color:#2C4433">Your order is ready</h2>
        <p>Hi ${p.customerFirstName}, your cake from <b>${p.bakerName}</b> is ready${isDelivery ? ` for delivery${when}` : ` for pickup${when}`}!</p>
        ${thumbnailHtml}
        <p style="color:#888;font-size:12px;margin-top:24px">Powered by Spattoo</p>
      </div>`,
    };
  }

  if (typeSlug === 'order_completed_customer') {
    const base = p.bakerSlug ? config.storefront.urlTemplate.replace('{slug}', p.bakerSlug) : null;
    return {
      from:    `${p.bakerName} <${rawEmail(config.smtp.from)}>`,
      to:      recipientEmail,
      subject: `Thank you from ${p.bakerName}!`,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto">
        <h2 style="color:#2C4433">Your order is complete</h2>
        <p>Hi ${p.customerFirstName}, your cake order from <b>${p.bakerName}</b> is complete — we hope it made the moment special!</p>
        ${thumbnailHtml}
        <p style="margin-top:16px">Thank you for ordering.${base ? ` Design another anytime with <a href="${base}" style="color:#2C4433;font-weight:700">${p.bakerName}</a>.` : ''}</p>
        <p style="color:#888;font-size:12px;margin-top:24px">Powered by Spattoo</p>
      </div>`,
    };
  }

  if (typeSlug === 'customer_invite') {
    const { subject, text, html } = buildInviteEmail({
      bakerName:  p.bakerName,
      firstName:  p.firstName,
      link:       p.link,
      brandColor: p.brandColor,
      logoUrl:    p.logoUrl,
      note:       p.note,
      expiresAt:  p.expiresAt,
    });
    return {
      from: `${p.bakerName} <${rawEmail(config.smtp.from)}>`,
      to:   recipientEmail,
      subject,
      text,
      html,
    };
  }

  throw new Error(`Unknown notification type: ${typeSlug}`);
}

export async function sendNotification({ notificationId }) {
  // Fetch notification with its type
  const { data: notification, error } = await supabase
    .from('notifications')
    .select('*, notification_types(slug)')
    .eq('id', notificationId)
    .single();

  if (error || !notification) throw new Error(`Notification ${notificationId} not found`);

  const typeSlug = notification.notification_types.slug;
  const mail = buildEmail(typeSlug, notification.recipient_email, notification.payload);

  try {
    const info = await transporter.sendMail(mail);
    // 'sent' only means the SMTP server ACCEPTED the message — not that it reached the
    // inbox. Log what the provider actually said (response line + message id + any
    // rejected recipients) so deliverability problems (sandbox, SPF/DKIM, bounces)
    // are diagnosable from Render logs instead of being invisible behind status=sent.
    console.log('[notifications] sent', JSON.stringify({
      notificationId,
      type:      typeSlug,
      to:        mail.to,
      messageId: info?.messageId,
      response:  info?.response,
      accepted:  info?.accepted,
      rejected:  info?.rejected,
    }));
    await supabase.from('notifications').update({
      status:  'sent',
      sent_at: new Date().toISOString(),
    }).eq('id', notificationId);
  } catch (err) {
    console.error('[notifications] send failed', JSON.stringify({ notificationId, type: typeSlug, to: mail.to, error: err.message }));
    const exhausted = notification.attempts >= notification.max_attempts;
    await supabase.from('notifications').update({
      status:        exhausted ? 'failed' : 'pending',
      error_message: err.message,
      ...(exhausted ? { failed_at: new Date().toISOString() } : {}),
    }).eq('id', notificationId);
  }
}
