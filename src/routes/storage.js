import { Router } from 'express';
import { getSignedUploadUrl } from '../services/r2.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const ALLOWED_FOLDERS = [
  'elements/files/2D',
  'elements/files/3D',
  'elements/thumbnails',
  'templates/files',
  'templates/thumbnails',
];

router.post('/storage/sign-upload', requireAuth, async (req, res) => {
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

export default router;
