import { Router } from 'express';
import { prisma } from '../../config/db.js';
import { cacheResponse } from '../../lib/cache.js';

const router = Router();

router.get('/', cacheResponse(60_000), async (_req, res) => {
  const services = await prisma.service.findMany();
  return res.json({
    services: services.map((s) => ({ id: s.id, name: s.name, basePrice: s.basePrice }))
  });
});

export default router;
