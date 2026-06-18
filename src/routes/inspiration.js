import { Router } from 'express';
import { validateCakeImage, analyzeCake } from '../services/openai.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/rbac.js';

const router = Router();

// POST /admin/inspiration/analyze — "Build from Inspiration" phase 1.
// Validate a cake photo, then return a tier-wise reconstruction spec. The image arrives as
// base64 (no R2 upload needed — analysis only). Body: { imageBase64, mimeType }.
// Gate rejection comes back as 200 { ok:false, reason } (not an error) so the UI can explain it.
router.post('/admin/inspiration/analyze', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { imageBase64, mimeType } = req.body ?? {};
    if (!imageBase64 || !mimeType) {
      return res.status(400).json({ error: 'imageBase64 and mimeType are required' });
    }
    const dataUri = `data:${mimeType};base64,${imageBase64}`;

    const verdict = await validateCakeImage(dataUri);
    if (!verdict.ok) return res.json({ ok: false, reason: verdict.reason, category: verdict.category });

    const analysis = await analyzeCake(dataUri);
    res.json({ ok: true, analysis });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
