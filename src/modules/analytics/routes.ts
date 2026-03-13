import { Router } from 'express';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { prisma } from '../../config/db.js';
import type { AuthRequest } from '../../middleware/auth.js';
import { env } from '../../config/env.js';

const router = Router();

const eventSchema = z.object({
  businessId: z.string().min(3),
  eventType: z.enum(['view', 'call_click', 'whatsapp_click', 'enquiry_submit'])
});

router.post('/event', async (req: AuthRequest, res) => {
  const parsed = eventSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid analytics payload', errors: parsed.error.flatten() });
  }
  const business = await (prisma as any).business.findUnique({ where: { id: parsed.data.businessId } });
  if (!business) return res.status(404).json({ message: 'Business not found' });

  const rawAuth = req.headers.authorization ?? '';
  let actorUserId: string | null = null;
  if (rawAuth.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(rawAuth.slice('Bearer '.length), env.jwtSecret) as { sub?: string };
      actorUserId = payload.sub ?? null;
    } catch {
      actorUserId = null;
    }
  }

  const event = await (prisma as any).analyticsEvent.create({
    data: {
      businessId: parsed.data.businessId,
      eventType: parsed.data.eventType,
      actorUserId
    }
  });

  return res.status(201).json({
    event: {
      id: event.id,
      businessId: event.businessId,
      eventType: event.eventType,
      createdAt: new Date(event.createdAt).toISOString()
    }
  });
});

export default router;
