import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/db.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/role.js';
import { cacheResponse, deleteCacheByPrefix } from '../../lib/cache.js';

const router = Router();

const couponTypeSchema = z.enum(['flat', 'percent']);

const createCouponSchema = z.object({
  code: z.string().min(3).max(24),
  title: z.string().min(2).max(120),
  type: couponTypeSchema,
  value: z.number().positive(),
  minOrderAmount: z.number().min(0).optional(),
  maxDiscount: z.number().positive().nullable().optional(),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  usageLimit: z.number().int().positive().nullable().optional(),
  isActive: z.boolean().optional()
});

const updateCouponSchema = createCouponSchema.partial();

const validateCouponSchema = z.object({
  code: z.string().min(3).max(24),
  amount: z.number().min(0)
});
const redeemCouponSchema = z.object({
  code: z.string().min(3).max(24)
});

const normalizeCode = (input: string) => input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

const isCouponRunning = (coupon: any, now: Date) => {
  if (!coupon?.isActive) return false;
  if (coupon.startsAt && new Date(coupon.startsAt) > now) return false;
  if (coupon.endsAt && new Date(coupon.endsAt) < now) return false;
  if (typeof coupon.usageLimit === 'number' && coupon.usedCount >= coupon.usageLimit) return false;
  return true;
};

router.get('/available', cacheResponse(30_000), async (_req, res) => {
  try {
    const now = new Date();
    const coupons = await (prisma as any).coupon.findMany({
      where: {
        isActive: true,
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gte: now } }] }
        ]
      },
      orderBy: { createdAt: 'desc' }
    });

    const available = coupons.filter((coupon: any) => isCouponRunning(coupon, now));

    return res.json({
      coupons: available.map((coupon: any) => ({
        id: coupon.id,
        code: coupon.code,
        title: coupon.title,
        type: coupon.type,
        value: coupon.value,
        minOrderAmount: coupon.minOrderAmount,
        maxDiscount: coupon.maxDiscount
      }))
    });
  } catch (error) {
    console.error('coupons/available failed', error);
    return res.json({ coupons: [] });
  }
});

router.post('/validate', async (req, res) => {
  const parsed = validateCouponSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? 'Invalid input' });

  const now = new Date();
  const code = normalizeCode(parsed.data.code);
  const amount = parsed.data.amount;

  const coupon = await (prisma as any).coupon.findUnique({ where: { code } });
  if (!coupon) return res.status(404).json({ message: 'Invalid coupon code' });
  if (!coupon.isActive) return res.status(400).json({ message: 'Coupon is inactive' });
  if (coupon.startsAt && new Date(coupon.startsAt) > now) return res.status(400).json({ message: 'Coupon is not active yet' });
  if (coupon.endsAt && new Date(coupon.endsAt) < now) return res.status(400).json({ message: 'Coupon expired' });
  if (typeof coupon.usageLimit === 'number' && coupon.usedCount >= coupon.usageLimit) {
    return res.status(400).json({ message: 'Coupon usage limit reached' });
  }
  if (amount < Number(coupon.minOrderAmount ?? 0)) {
    return res.status(400).json({ message: `Minimum order is ₹${Math.round(Number(coupon.minOrderAmount ?? 0))}` });
  }

  const rawDiscount = coupon.type === 'percent' ? (amount * Number(coupon.value)) / 100 : Number(coupon.value);
  const capped = typeof coupon.maxDiscount === 'number' ? Math.min(rawDiscount, Number(coupon.maxDiscount)) : rawDiscount;
  const discount = Math.max(0, Math.min(Math.round(capped), Math.round(amount)));

  return res.json({
    coupon: {
      id: coupon.id,
      code: coupon.code,
      title: coupon.title,
      type: coupon.type,
      value: coupon.value,
      minOrderAmount: coupon.minOrderAmount,
      maxDiscount: coupon.maxDiscount
    },
    discount
  });
});

router.post('/redeem', requireAuth, async (req, res) => {
  const parsed = redeemCouponSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? 'Invalid input' });

  const code = normalizeCode(parsed.data.code);
  const current = await (prisma as any).coupon.findUnique({ where: { code } });
  if (!current) return res.status(404).json({ message: 'Coupon not found' });
  if (!current.isActive) return res.status(400).json({ message: 'Coupon is inactive' });
  if (typeof current.usageLimit === 'number' && current.usedCount >= current.usageLimit) {
    return res.status(400).json({ message: 'Coupon usage limit reached' });
  }

  const coupon = await (prisma as any).coupon.update({
    where: { id: current.id },
    data: { usedCount: { increment: 1 } }
  });

  deleteCacheByPrefix('/coupons');
  deleteCacheByPrefix('/home-banners');
  return res.json({ coupon });
});

router.get('/admin/list', requireAuth, requireRole('admin'), async (_req, res) => {
  const coupons = await (prisma as any).coupon.findMany({ orderBy: { createdAt: 'desc' } });
  return res.json({ coupons });
});

router.post('/admin/create', requireAuth, requireRole('admin'), async (req, res) => {
  const parsed = createCouponSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? 'Invalid input' });

  const payload = parsed.data;
  const code = normalizeCode(payload.code);
  const existing = await (prisma as any).coupon.findUnique({ where: { code } });
  if (existing) return res.status(409).json({ message: 'Coupon code already exists' });

  const coupon = await (prisma as any).coupon.create({
    data: {
      code,
      title: payload.title.trim(),
      type: payload.type,
      value: payload.value,
      minOrderAmount: payload.minOrderAmount ?? 0,
      maxDiscount: payload.maxDiscount ?? null,
      startsAt: payload.startsAt ? new Date(payload.startsAt) : null,
      endsAt: payload.endsAt ? new Date(payload.endsAt) : null,
      usageLimit: payload.usageLimit ?? null,
      isActive: payload.isActive ?? true,
      createdBy: (req as any).auth?.userId ?? null
    }
  });
  deleteCacheByPrefix('/coupons');
  deleteCacheByPrefix('/home-banners');
  return res.status(201).json({ coupon });
});

router.patch('/admin/:couponId', requireAuth, requireRole('admin'), async (req, res) => {
  const parsed = updateCouponSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? 'Invalid input' });

  const current = await (prisma as any).coupon.findUnique({ where: { id: req.params.couponId } });
  if (!current) return res.status(404).json({ message: 'Coupon not found' });

  const payload = parsed.data;
  const nextCode = payload.code ? normalizeCode(payload.code) : undefined;
  if (nextCode && nextCode !== current.code) {
    const existing = await (prisma as any).coupon.findUnique({ where: { code: nextCode } });
    if (existing) return res.status(409).json({ message: 'Coupon code already exists' });
  }

  const coupon = await (prisma as any).coupon.update({
    where: { id: current.id },
    data: {
      ...(nextCode ? { code: nextCode } : {}),
      ...(payload.title !== undefined ? { title: payload.title.trim() } : {}),
      ...(payload.type !== undefined ? { type: payload.type } : {}),
      ...(payload.value !== undefined ? { value: payload.value } : {}),
      ...(payload.minOrderAmount !== undefined ? { minOrderAmount: payload.minOrderAmount } : {}),
      ...(payload.maxDiscount !== undefined ? { maxDiscount: payload.maxDiscount } : {}),
      ...(payload.startsAt !== undefined ? { startsAt: payload.startsAt ? new Date(payload.startsAt) : null } : {}),
      ...(payload.endsAt !== undefined ? { endsAt: payload.endsAt ? new Date(payload.endsAt) : null } : {}),
      ...(payload.usageLimit !== undefined ? { usageLimit: payload.usageLimit } : {}),
      ...(payload.isActive !== undefined ? { isActive: payload.isActive } : {})
    }
  });
  deleteCacheByPrefix('/coupons');
  deleteCacheByPrefix('/home-banners');
  return res.json({ coupon });
});

router.delete('/admin/:couponId', requireAuth, requireRole('admin'), async (req, res) => {
  const current = await (prisma as any).coupon.findUnique({ where: { id: req.params.couponId } });
  if (!current) return res.status(404).json({ message: 'Coupon not found' });
  await (prisma as any).coupon.delete({ where: { id: current.id } });
  deleteCacheByPrefix('/coupons');
  deleteCacheByPrefix('/home-banners');
  return res.status(204).send();
});

export default router;
