import nodemailer from 'nodemailer';
import { config } from '../config.js';

const transporter = nodemailer.createTransport({
  host:   config.smtp.host,
  port:   config.smtp.port,
  secure: config.smtp.port === 465,
  auth: {
    user: config.smtp.user,
    pass: config.smtp.pass,
  },
});

// SEC-3: escape user/tenant-controlled values before interpolating into email HTML, so a
// name/note can't inject markup (phishing links, tracking pixels, layout hijack) into the
// recipient's inbox. Mirrors esc() in jobs/processors/sendNotification.js.
function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Warm welcome sent by US (not Supabase) once an invited staff member has confirmed +
// set their password — see the first-load trigger in GET /api/baker/profile. Best-effort
// (the send is fire-and-forget; the DB flag is already claimed before we get here).
export async function sendStaffWelcomeEmail({ staff, baker }) {
  if (!config.smtp.host || !config.smtp.user) return;
  if (!staff?.email) return;

  const name = esc(staff.first_name || 'there');
  const bakery = esc(baker?.name || 'your bakery');
  await transporter.sendMail({
    from:    config.smtp.from,
    to:      staff.email,
    subject: `Welcome to ${baker?.name || 'your bakery'} on Spattoo 🎂`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto">
        <h2 style="color:#2C4433">Welcome, ${name}!</h2>
        <p>You've been added to the team at <b>${bakery}</b> on Spattoo.</p>
        <p>Sign in any time using the <b>Staff</b> tab with your email — you can help manage
           orders, customers and cake designs.</p>
        <p style="color:#888;font-size:12px;margin-top:24px">Powered by Spattoo</p>
      </div>
    `,
  });
}
