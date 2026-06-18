import { Router } from 'express';
import { getSignedUploadUrl, deleteObject } from '../services/r2.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/rbac.js';
import { config } from '../config.js';

const router = Router();

const ALLOWED_FOLDERS = [
  'elements/files/2D',
  'elements/files/3D',
  'elements/thumbnails',
  'templates/files',
  'templates/thumbnails',
  'logos',
  'portraits',             // baker portrait for the storefront "Our story" section
  'storefront/gallery',    // baker cake photos for the storefront slideshow
  'orders/thumbnails',
  'meshy/source',   // uploaded 2D image for the image→3D wizard (public so Meshy can fetch it)
  'meshy/outputs',  // our copy of the Meshy-generated GLB (written server-side via putObject)
];

router.post('/storage/sign-upload', requireAuth, requireCapability('design:create'), async (req, res) => {
  try {
    const { folder, filename, contentType } = req.body;
    if (!folder || !filename || !contentType) {
      return res.status(400).json({ error: 'folder, filename and contentType are required' });
    }
    if (!ALLOWED_FOLDERS.includes(folder)) {
      return res.status(400).json({ error: `Invalid folder. Allowed: ${ALLOWED_FOLDERS.join(', ')}` });
    }

    const key = `${folder}/${filename}`;
    const url = await getSignedUploadUrl(key, contentType);
    res.json({ url, key });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Normalize a stored image_url/thumbnail_url to a bucket key. Values are stored as bare
// keys but the API serves them expanded to full public URLs, so callers may send either.
function toKey(raw) {
  if (!raw) return null;
  let k = String(raw).trim();
  const base = config.r2.publicUrl?.replace(/\/+$/, '');
  if (base && k.startsWith(base)) k = k.slice(base.length);
  else if (/^https?:\/\//i.test(k)) { try { k = new URL(k).pathname; } catch { /* leave as-is */ } }
  return k.replace(/^\/+/, '');
}

router.post('/storage/delete', requireAuth, requireCapability('design:create'), async (req, res) => {
  try {
    const key = toKey(req.body?.key);
    if (!key) return res.status(400).json({ error: 'key is required' });
    // Only ever delete within managed folders — never an arbitrary bucket object.
    if (!ALLOWED_FOLDERS.some(f => key.startsWith(`${f}/`))) {
      return res.status(400).json({ error: `Refusing to delete outside managed folders: ${key}` });
    }
    await deleteObject(key);
    res.json({ ok: true, key });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
