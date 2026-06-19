// Throwaway: render the invite email with sample data to /tmp/invite-preview.html
import { writeFileSync } from 'fs';
import { buildInviteEmail } from '../src/routes/customers.js';

const { subject, html } = buildInviteEmail({
  bakerName: 'Feelings & Flavours',
  firstName: 'Riya',
  link: 'https://feelings-flavours.spattoo.com/feelings-flavours?invite=demo',
  brandColor: '#9b5f72',
  logoUrl: null,
  note: "Can't wait to make your birthday cake special!",
  expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
});

writeFileSync('/tmp/invite-preview.html', html);
console.log('subject:', subject);
console.log('written /tmp/invite-preview.html');
