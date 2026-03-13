import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';

const router = Router();

router.get('/', requireAuth, (_req, res) => {
  return res.json({ complaints: [] });
});

export default router;
