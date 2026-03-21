import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../../middleware/auth.js';
import { requireRole } from '../../../middleware/role.js';
import { prisma } from '../../../config/db.js';
import { deleteCacheByPrefix } from '../../../lib/cache.js';

const router = Router();
const dataUrlImageRegex = /^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/;

const workerUpdateSchema = z.object({
  photoUrl: z.string().optional(),
  skills: z.array(z.string()).optional(),
  experienceYears: z.number().int().min(0).optional(),
  bio: z.string().optional(),
  pricePerHour: z.number().min(0).optional()
});
const complaintFlagSchema = z.object({
  note: z.string().max(500).optional()
});
const monetizationSchema = z.object({
  listingType: z.enum(['free', 'promoted']).optional(),
  subscriptionPlan: z.enum(['none', 'starter', 'growth', 'pro']).optional(),
  subscriptionEndsAt: z.string().datetime().nullable().optional(),
  adCredits: z.number().int().min(0).max(100000).optional()
});
const adminBroadcastSchema = z.object({
  title: z.string().trim().min(3).max(120),
  message: z.string().trim().min(5).max(1000),
  targetRole: z.enum(['all', 'customer', 'worker']).default('all')
});
const homeBannerSchema = z.object({
  id: z.string().trim().optional(),
  bannerKey: z.string().trim().min(2).max(80),
  title: z.string().trim().min(3).max(160),
  subtitle: z.string().trim().min(3).max(500),
  highlightText: z.string().trim().min(2).max(255),
  imageUrl: z
    .string()
    .trim()
    .max(2_000_000)
    .refine((value) => /^https?:\/\//i.test(value) || dataUrlImageRegex.test(value), 'Image must be a valid URL or data image'),
  targetServiceKey: z.string().trim().max(80).optional().nullable(),
  toneStart: z.string().trim().regex(/^#([0-9A-Fa-f]{6})$/).optional(),
  toneEnd: z.string().trim().regex(/^#([0-9A-Fa-f]{6})$/).optional(),
  sortOrder: z.number().int().min(0).max(999).default(0),
  isActive: z.boolean().default(true)
});
const homeHeroOfferSchema = z.object({
  id: z.string().trim().optional(),
  offerText: z.string().trim().min(2).max(160),
  subtitle: z.string().trim().min(2).max(500),
  couponCode: z.string().trim().max(24).optional().nullable(),
  toneStart: z.string().trim().regex(/^#([0-9A-Fa-f]{6})$/).optional(),
  toneEnd: z.string().trim().regex(/^#([0-9A-Fa-f]{6})$/).optional(),
  isActive: z.boolean().default(true)
});

const ensureHomeBannerTable = async () => {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS HomeBanner (
      id VARCHAR(40) PRIMARY KEY,
      bannerKey VARCHAR(80) NOT NULL UNIQUE,
      title VARCHAR(160) NOT NULL,
      subtitle TEXT NOT NULL,
      highlightText VARCHAR(255) NOT NULL,
      imageUrl TEXT NOT NULL,
      targetServiceKey VARCHAR(80) NULL,
      toneStart VARCHAR(20) NULL,
      toneEnd VARCHAR(20) NULL,
      isActive BOOLEAN NOT NULL DEFAULT TRUE,
      sortOrder INT NOT NULL DEFAULT 0,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      updatedById VARCHAR(191) NULL,
      INDEX idx_homebanner_active_sort (isActive, sortOrder, updatedAt)
    );
  `);
};

const ensureHomeHeroOfferTable = async () => {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS HomeHeroOffer (
      id VARCHAR(40) PRIMARY KEY,
      offerText VARCHAR(160) NOT NULL,
      subtitle TEXT NOT NULL,
      couponCode VARCHAR(24) NULL,
      toneStart VARCHAR(20) NULL,
      toneEnd VARCHAR(20) NULL,
      isActive BOOLEAN NOT NULL DEFAULT TRUE,
      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      updatedById VARCHAR(191) NULL
    );
  `);
};

const seedDefaultHomeBanners = async () => {
  const rows = await prisma.$queryRaw<Array<{ count: number }>>`SELECT COUNT(*) as count FROM HomeBanner`;
  const total = Number(rows?.[0]?.count ?? 0);
  if (total > 0) return;

  await prisma.$executeRawUnsafe(
    `
      INSERT INTO HomeBanner
        (id, bannerKey, title, subtitle, highlightText, imageUrl, targetServiceKey, toneStart, toneEnd, isActive, sortOrder, updatedById)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    'hb_default_salon',
    'salon-home',
    'Relaxing Salon at Home',
    'Enjoy professional beauty services at your home.',
    'Book now for a relaxing day.',
    'https://images.unsplash.com/photo-1521590832167-7bcbfaa6381f?auto=format&fit=crop&w=900&q=80',
    'house-cleaning',
    '#6C4DFF',
    '#8F76FF',
    1,
    1,
    null,
    'hb_default_expert',
    'expert-help',
    'Get Expert Help in 60 Minutes',
    'Book trusted professionals instantly.',
    'Starting at just ₹99.',
    'https://images.unsplash.com/photo-1581578731548-c64695cc6952?auto=format&fit=crop&w=900&q=80',
    'electrician',
    '#4B63FF',
    '#6C4DFF',
    1,
    2,
    null
  );
};

const seedDefaultHeroOffer = async () => {
  const rows = await prisma.$queryRaw<Array<{ count: number }>>`SELECT COUNT(*) as count FROM HomeHeroOffer`;
  const total = Number(rows?.[0]?.count ?? 0);
  if (total > 0) return;
  await prisma.$executeRawUnsafe(
    `
      INSERT INTO HomeHeroOffer
        (id, offerText, subtitle, couponCode, toneStart, toneEnd, isActive, updatedById)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    'hero_default',
    '40% OFF',
    'On First Cleaning Service',
    'CLEAN40',
    '#7B2FF7',
    '#9F5BFF',
    1,
    null
  );
};

const isCouponRunning = (coupon: {
  isActive: number | boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  usageLimit: number | null;
  usedCount: number;
}) => {
  const now = Date.now();
  if (!Boolean(coupon.isActive)) return false;
  if (coupon.startsAt && new Date(coupon.startsAt).getTime() > now) return false;
  if (coupon.endsAt && new Date(coupon.endsAt).getTime() < now) return false;
  if (typeof coupon.usageLimit === 'number' && Number.isFinite(coupon.usageLimit) && coupon.usedCount >= coupon.usageLimit) return false;
  return true;
};

const handleAdminRouteError = (res: any, routeKey: string, error: unknown) => {
  console.error(`admin dashboard route failed: ${routeKey}`, error);
  return res.status(500).json({
    message: 'Admin request failed',
    route: routeKey
  });
};

const serializeWorker = (u: any) => {
  const profile = u.workerProfile;
  return {
    id: u.id,
    role: u.role,
    profilePhotoUrl: u.profilePhotoUrl ?? '',
    name: u.name,
    email: u.email,
    phone: u.phone,
    city: u.city,
    address: u.address,
    isApproved: u.isApproved,
    isVerifiedPlus: Boolean(u.isVerifiedPlus),
    isPriorityBoosted: Boolean((u as any).isPriorityBoosted),
    listingType: (u as any).listingType ?? 'free',
    subscriptionPlan: (u as any).subscriptionPlan ?? 'none',
    subscriptionEndsAt: (u as any).subscriptionEndsAt ? new Date((u as any).subscriptionEndsAt).toISOString() : null,
    adCredits: Number((u as any).adCredits ?? 0),
    isComplaintFlagged: Boolean((u as any).isComplaintFlagged),
    complaintFlagNote: (u as any).complaintFlagNote ?? '',
    createdAt: u.createdAt ? new Date(u.createdAt).toISOString() : null,
    updatedAt: u.updatedAt ? new Date(u.updatedAt).toISOString() : null,
    profile: profile
      ? {
          id: profile.id,
          userId: profile.userId,
          photoUrl: profile.photoUrl,
          location: profile.location,
          isOnDuty: Boolean(profile.isOnDuty),
          skills: Array.isArray(profile.skills) ? (profile.skills as string[]) : [],
          serviceAreas: Array.isArray(profile.serviceAreas) ? (profile.serviceAreas as string[]) : [],
          portfolioUrls: Array.isArray(profile.portfolioUrls) ? (profile.portfolioUrls as string[]) : [],
          portfolioVideoUrls: Array.isArray(profile.portfolioVideoUrls) ? (profile.portfolioVideoUrls as string[]) : [],
          certifications: Array.isArray(profile.certifications) ? (profile.certifications as string[]) : [],
          responseTimeMins: profile.responseTimeMins ?? 30,
          workingHours: profile.workingHours ?? '',
          priceFrom: profile.priceFrom ?? 0,
          priceTo: profile.priceTo ?? 0,
          experienceYears: profile.experienceYears,
          bio: profile.bio,
          aadhaarNumberMasked: profile.aadhaarNumberMasked,
          aadhaarCardUrl: profile.aadhaarCardUrl,
          pricePerHour: profile.pricePerHour,
          rating: profile.rating,
          totalJobs: profile.totalJobs
        }
      : null
  };
};

router.get('/workers/pending', requireAuth, requireRole('admin'), async (_req, res) => {
  try {
    const pendingUsers = await prisma.user.findMany({
      where: { isApproved: false },
      include: { workerProfile: true }
    });

    const pending = pendingUsers.filter((u: any) => u.role === 'worker' || Boolean(u.workerProfile));

    return res.json({
      pendingWorkers: pending.map(serializeWorker)
    });
  } catch (error) {
    return handleAdminRouteError(res, 'workers/pending', error);
  }
});

router.post('/notifications/broadcast', requireAuth, requireRole('admin'), async (req: any, res) => {
  const parsed = adminBroadcastSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid notification payload', errors: parsed.error.flatten() });
  }

  const id = `bn_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const createdAt = new Date();
  await prisma.$executeRaw`
    INSERT INTO BroadcastNotification (id, title, message, targetRole, createdById, createdAt)
    VALUES (${id}, ${parsed.data.title}, ${parsed.data.message}, ${parsed.data.targetRole}, ${req.auth?.userId ?? null}, ${createdAt})
  `;

  return res.status(201).json({
    notification: {
      id,
      title: parsed.data.title,
      message: parsed.data.message,
      targetRole: parsed.data.targetRole,
      createdAt: createdAt.toISOString()
    }
  });
});

router.get('/home-banners', requireAuth, requireRole('admin'), async (_req, res) => {
  try {
    await ensureHomeBannerTable();
    await seedDefaultHomeBanners();
    const rows = await prisma.$queryRaw<
      Array<{
        id: string;
        bannerKey: string;
        title: string;
        subtitle: string;
        highlightText: string;
        imageUrl: string;
        targetServiceKey: string | null;
        toneStart: string | null;
        toneEnd: string | null;
        isActive: number | boolean;
        sortOrder: number;
        updatedAt: Date;
        createdAt: Date;
      }>
    >`
      SELECT id, bannerKey, title, subtitle, highlightText, imageUrl, targetServiceKey, toneStart, toneEnd, isActive, sortOrder, updatedAt, createdAt
      FROM HomeBanner
      ORDER BY sortOrder ASC, updatedAt DESC
      LIMIT 100
    `;

    return res.json({
      banners: rows.map((row) => ({
        id: row.id,
        bannerKey: row.bannerKey,
        title: row.title,
        subtitle: row.subtitle,
        highlightText: row.highlightText,
        imageUrl: row.imageUrl,
        targetServiceKey: row.targetServiceKey,
        toneStart: row.toneStart || '#6C4DFF',
        toneEnd: row.toneEnd || '#8F76FF',
        isActive: Boolean(row.isActive),
        sortOrder: Number(row.sortOrder ?? 0),
        updatedAt: new Date(row.updatedAt).toISOString(),
        createdAt: new Date(row.createdAt).toISOString()
      }))
    });
  } catch (error) {
    return handleAdminRouteError(res, 'home-banners', error);
  }
});

router.get('/home-offer', requireAuth, requireRole('admin'), async (_req, res) => {
  try {
    await ensureHomeHeroOfferTable();
    await seedDefaultHeroOffer();
    const rows = await prisma.$queryRaw<
      Array<{
        id: string;
        offerText: string;
        subtitle: string;
        couponCode: string | null;
        toneStart: string | null;
        toneEnd: string | null;
        isActive: number | boolean;
        updatedAt: Date;
      }>
    >`SELECT id, offerText, subtitle, couponCode, toneStart, toneEnd, isActive, updatedAt FROM HomeHeroOffer ORDER BY updatedAt DESC LIMIT 1`;
    const row = rows[0] ?? null;

    let runningCoupon: {
      code: string;
      title: string;
      type: 'flat' | 'percent';
      value: number;
    } | null = null;
    if (row?.couponCode) {
      const coupons = await prisma.$queryRaw<
        Array<{
          code: string;
          title: string;
          type: 'flat' | 'percent';
          value: number;
          isActive: number | boolean;
          startsAt: Date | null;
          endsAt: Date | null;
          usageLimit: number | null;
          usedCount: number;
        }>
      >`SELECT code, title, type, value, isActive, startsAt, endsAt, usageLimit, usedCount FROM Coupon WHERE code = ${row.couponCode} LIMIT 1`;
      if (coupons[0] && isCouponRunning(coupons[0])) {
        runningCoupon = {
          code: coupons[0].code,
          title: coupons[0].title,
          type: coupons[0].type,
          value: Number(coupons[0].value ?? 0)
        };
      }
    }

    return res.json({
      offer: row
        ? {
            id: row.id,
            offerText: row.offerText,
            subtitle: row.subtitle,
            couponCode: row.couponCode,
            toneStart: row.toneStart || '#7B2FF7',
            toneEnd: row.toneEnd || '#9F5BFF',
            isActive: Boolean(row.isActive),
            runningCoupon,
            updatedAt: new Date(row.updatedAt).toISOString()
          }
        : null
    });
  } catch (error) {
    return handleAdminRouteError(res, 'home-offer', error);
  }
});

router.post('/home-banners/upsert', requireAuth, requireRole('admin'), async (req: any, res) => {
  try {
    const parsed = homeBannerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: 'Invalid home banner payload', errors: parsed.error.flatten() });
    }
    await ensureHomeBannerTable();

    const payload = parsed.data;
    if (payload.imageUrl.startsWith('data:image/') && payload.imageUrl.length > 900_000) {
      return res.status(400).json({ message: 'Banner image too large. Please upload a smaller image (recommended under 500KB).' });
    }
    const id = payload.id?.trim() || `hb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const targetServiceKey = payload.targetServiceKey?.trim() || null;
    const toneStart = payload.toneStart || '#6C4DFF';
    const toneEnd = payload.toneEnd || '#8F76FF';
    const bannerKey = payload.bannerKey.trim();
    const row = await prisma.$queryRaw<Array<{ id: string }>>`SELECT id FROM HomeBanner WHERE bannerKey = ${bannerKey} LIMIT 1`.catch(() => []);
    const targetId = payload.id?.trim() || row[0]?.id || id;
    await prisma.$executeRawUnsafe(
      `
        REPLACE INTO HomeBanner
          (id, bannerKey, title, subtitle, highlightText, imageUrl, targetServiceKey, toneStart, toneEnd, isActive, sortOrder, updatedById)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      targetId,
      bannerKey,
      payload.title,
      payload.subtitle,
      payload.highlightText,
      payload.imageUrl,
      targetServiceKey,
      toneStart,
      toneEnd,
      payload.isActive ? 1 : 0,
      payload.sortOrder,
      req.auth?.userId ?? null
    );

    deleteCacheByPrefix('/home-banners');
    return res.status(201).json({ ok: true, id: targetId });
  } catch (error) {
    return handleAdminRouteError(res, 'home-banners/upsert', error);
  }
});

router.post('/home-offer/upsert', requireAuth, requireRole('admin'), async (req: any, res) => {
  try {
    const parsed = homeHeroOfferSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: 'Invalid home offer payload', errors: parsed.error.flatten() });
    }
    await ensureHomeHeroOfferTable();
    const payload = parsed.data;
    const id = payload.id?.trim() || 'hero_default';
    const couponCode = payload.couponCode?.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') || null;
    await prisma.$executeRawUnsafe(
      `
        REPLACE INTO HomeHeroOffer
          (id, offerText, subtitle, couponCode, toneStart, toneEnd, isActive, updatedById)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      id,
      payload.offerText,
      payload.subtitle,
      couponCode,
      payload.toneStart || '#7B2FF7',
      payload.toneEnd || '#9F5BFF',
      payload.isActive ? 1 : 0,
      req.auth?.userId ?? null
    );

    deleteCacheByPrefix('/home-banners');
    deleteCacheByPrefix('/coupons');
    return res.status(201).json({ ok: true, id });
  } catch (error) {
    return handleAdminRouteError(res, 'home-offer/upsert', error);
  }
});

router.delete('/home-banners/:id', requireAuth, requireRole('admin'), async (req, res) => {
  await ensureHomeBannerTable();
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ message: 'Invalid banner id' });
  await prisma.$executeRawUnsafe(`DELETE FROM HomeBanner WHERE id = ?`, id);
  deleteCacheByPrefix('/home-banners');
  return res.json({ ok: true });
});

router.get('/workers', requireAuth, requireRole('admin'), async (_req, res) => {
  const users = await prisma.user.findMany({
    include: { workerProfile: true },
    orderBy: { createdAt: 'desc' }
  });

  const workers = users.filter((u: any) => u.role === 'worker' || Boolean(u.workerProfile));

  const sortedWorkers = [...workers].sort((a: any, b: any) => {
    const priorityDelta = Number(Boolean((b as any).isPriorityBoosted)) - Number(Boolean((a as any).isPriorityBoosted));
    if (priorityDelta !== 0) return priorityDelta;
    return Number(Boolean((b as any).isVerifiedPlus)) - Number(Boolean((a as any).isVerifiedPlus));
  });

  return res.json({
    workers: sortedWorkers.map(serializeWorker)
  });
});

router.get('/customers', requireAuth, requireRole('admin'), async (_req, res) => {
  const customers = await prisma.user.findMany({
    where: { role: 'customer' },
    orderBy: [{ createdAt: 'desc' }]
  });

  return res.json({
    customers: customers.map((u: any) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      phone: u.phone,
      city: u.city,
      address: u.address,
      profilePhotoUrl: u.profilePhotoUrl,
      phoneVerified: u.phoneVerified,
      createdAt: new Date(u.createdAt).toISOString()
    }))
  });
});

router.post('/workers/:workerId/verify-plus', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const updated = await (prisma as any).user.updateMany({
      where: { id: req.params.workerId, role: 'worker' },
      data: { isVerifiedPlus: true }
    });
    if (updated.count === 0) return res.status(404).json({ message: 'Worker not found' });
    return res.json({ message: 'Worker marked as Verified Plus Member' });
  } catch (error: any) {
    const message = String(error?.message ?? '');
    if (message.includes('Unknown argument `isVerifiedPlus`') || message.includes('Unknown field `isVerifiedPlus`')) {
      return res.status(500).json({ message: 'Verified Plus feature is not migrated yet. Run prisma generate + prisma db push.' });
    }
    return res.status(500).json({ message: 'Failed to mark worker as Verified Plus Member' });
  }
});

router.post('/workers/:workerId/verify', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const updated = await (prisma as any).user.updateMany({
      where: { id: req.params.workerId, role: 'worker' },
      data: { isVerifiedPlus: true }
    });
    if (updated.count === 0) return res.status(404).json({ message: 'Worker not found' });
    return res.json({ message: 'Worker verified' });
  } catch (error: any) {
    const message = String(error?.message ?? '');
    if (message.includes('Unknown argument `isVerifiedPlus`') || message.includes('Unknown field `isVerifiedPlus`')) {
      return res.status(500).json({ message: 'Verify feature is not migrated yet. Run prisma generate + prisma db push.' });
    }
    return res.status(500).json({ message: 'Failed to verify worker' });
  }
});

router.post('/workers/:workerId/unverify', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const updated = await (prisma as any).user.updateMany({
      where: { id: req.params.workerId, role: 'worker' },
      data: { isVerifiedPlus: false }
    });
    if (updated.count === 0) return res.status(404).json({ message: 'Worker not found' });
    return res.json({ message: 'Worker unverified' });
  } catch (error: any) {
    const message = String(error?.message ?? '');
    if (message.includes('Unknown argument `isVerifiedPlus`') || message.includes('Unknown field `isVerifiedPlus`')) {
      return res.status(500).json({ message: 'Verify feature is not migrated yet. Run prisma generate + prisma db push.' });
    }
    return res.status(500).json({ message: 'Failed to unverify worker' });
  }
});

router.post('/workers/:workerId/unverify-plus', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const updated = await (prisma as any).user.updateMany({
      where: { id: req.params.workerId, role: 'worker' },
      data: { isVerifiedPlus: false }
    });
    if (updated.count === 0) return res.status(404).json({ message: 'Worker not found' });
    return res.json({ message: 'Worker removed from Verified Plus Member' });
  } catch (error: any) {
    const message = String(error?.message ?? '');
    if (message.includes('Unknown argument `isVerifiedPlus`') || message.includes('Unknown field `isVerifiedPlus`')) {
      return res.status(500).json({ message: 'Verified Plus feature is not migrated yet. Run prisma generate + prisma db push.' });
    }
    return res.status(500).json({ message: 'Failed to remove worker from Verified Plus Member' });
  }
});

router.post('/workers/:workerId/priority-boost', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const updated = await (prisma as any).user.updateMany({
      where: { id: req.params.workerId, role: 'worker' },
      data: { isPriorityBoosted: true }
    });
    if (updated.count === 0) return res.status(404).json({ message: 'Worker not found' });
    return res.json({ message: 'Priority boost enabled' });
  } catch (error: any) {
    const message = String(error?.message ?? '');
    if (message.includes('Unknown argument `isPriorityBoosted`') || message.includes('Unknown field `isPriorityBoosted`')) {
      return res.status(500).json({ message: 'Priority boost feature is not migrated yet. Run prisma generate + prisma db push.' });
    }
    return res.status(500).json({ message: 'Failed to enable priority boost' });
  }
});

router.post('/workers/:workerId/priority-normal', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const updated = await (prisma as any).user.updateMany({
      where: { id: req.params.workerId, role: 'worker' },
      data: { isPriorityBoosted: false }
    });
    if (updated.count === 0) return res.status(404).json({ message: 'Worker not found' });
    return res.json({ message: 'Priority boost removed' });
  } catch (error: any) {
    const message = String(error?.message ?? '');
    if (message.includes('Unknown argument `isPriorityBoosted`') || message.includes('Unknown field `isPriorityBoosted`')) {
      return res.status(500).json({ message: 'Priority boost feature is not migrated yet. Run prisma generate + prisma db push.' });
    }
    return res.status(500).json({ message: 'Failed to remove priority boost' });
  }
});

router.post('/workers/:workerId/complaint-flag', requireAuth, requireRole('admin'), async (req, res) => {
  const parsed = complaintFlagSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid complaint payload', errors: parsed.error.flatten() });
  }
  try {
    const updated = await (prisma as any).user.updateMany({
      where: { id: req.params.workerId, role: 'worker' },
      data: {
        isComplaintFlagged: true,
        complaintFlagNote: parsed.data.note?.trim() ?? ''
      }
    });
    if (updated.count === 0) return res.status(404).json({ message: 'Worker not found' });
    return res.json({ message: 'Worker complaint flagged' });
  } catch (error: any) {
    const message = String(error?.message ?? '');
    if (
      message.includes('Unknown argument `isComplaintFlagged`') ||
      message.includes('Unknown field `isComplaintFlagged`') ||
      message.includes('Unknown argument `complaintFlagNote`') ||
      message.includes('Unknown field `complaintFlagNote`')
    ) {
      return res.status(500).json({ message: 'Complaint flag feature is not migrated yet. Run prisma generate + prisma db push.' });
    }
    return res.status(500).json({ message: 'Failed to flag complaint' });
  }
});

router.post('/workers/:workerId/complaint-unflag', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const updated = await (prisma as any).user.updateMany({
      where: { id: req.params.workerId, role: 'worker' },
      data: {
        isComplaintFlagged: false,
        complaintFlagNote: ''
      }
    });
    if (updated.count === 0) return res.status(404).json({ message: 'Worker not found' });
    return res.json({ message: 'Worker complaint flag removed' });
  } catch (error: any) {
    const message = String(error?.message ?? '');
    if (
      message.includes('Unknown argument `isComplaintFlagged`') ||
      message.includes('Unknown field `isComplaintFlagged`') ||
      message.includes('Unknown argument `complaintFlagNote`') ||
      message.includes('Unknown field `complaintFlagNote`')
    ) {
      return res.status(500).json({ message: 'Complaint flag feature is not migrated yet. Run prisma generate + prisma db push.' });
    }
    return res.status(500).json({ message: 'Failed to remove complaint flag' });
  }
});

router.post('/workers/:workerId/approve', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const target = await prisma.user.findUnique({
      where: { id: req.params.workerId },
      include: { workerProfile: true }
    });

    if (!target || (!target.workerProfile && target.role !== 'worker')) {
      return res.status(404).json({ message: 'Worker not found' });
    }

    await prisma.user.update({
      where: { id: req.params.workerId },
      data: {
        isApproved: true,
        ...(target.role !== 'worker' ? { role: 'worker' } : {})
      } as any
    });

    return res.json({ message: 'Worker approved' });
  } catch {
    return res.status(500).json({ message: 'Failed to approve worker' });
  }
});

router.post('/workers/:workerId/reject', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const target = await prisma.user.findUnique({
      where: { id: req.params.workerId },
      include: { workerProfile: true }
    });

    if (!target || (!target.workerProfile && target.role !== 'worker')) {
      return res.status(404).json({ message: 'Worker not found' });
    }

    await prisma.user.update({
      where: { id: req.params.workerId },
      data: { isApproved: false }
    });

    return res.json({ message: 'Worker rejected' });
  } catch {
    return res.status(500).json({ message: 'Failed to reject worker' });
  }
});

router.patch('/workers/:workerId/profile', requireAuth, requireRole('admin'), async (req, res) => {
  const parsed = workerUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid payload', errors: parsed.error.flatten() });
  }

  const profile = await prisma.workerProfile.update({
    where: { userId: req.params.workerId },
    data: {
      ...parsed.data,
      ...(parsed.data.skills ? { skills: parsed.data.skills } : {})
    }
  });

  if (!profile) return res.status(404).json({ message: 'Profile not found' });

  return res.json({
    profile: {
      id: profile.id,
      userId: profile.userId,
      photoUrl: profile.photoUrl,
      skills: Array.isArray(profile.skills) ? (profile.skills as string[]) : [],
      experienceYears: profile.experienceYears,
      bio: profile.bio,
      pricePerHour: profile.pricePerHour,
      rating: profile.rating,
      totalJobs: profile.totalJobs
    }
  });
});

router.get('/bookings', requireAuth, requireRole('admin'), async (_req, res) => {
  const bookings: any[] = await prisma.booking.findMany({
    include: {
      customer: true,
      worker: { include: { workerProfile: true } },
      service: true
    },
    orderBy: { createdAt: 'desc' }
  });
  return res.json({
    bookings: bookings.map((b) => ({
      id: b.id,
      customerId: b.customerId,
      workerId: b.workerId,
      serviceId: b.serviceId,
      address: b.address,
      dateTime: new Date(b.dateTime).toISOString(),
      hours: b.hours,
      totalAmount: b.totalAmount,
      paymentMethod: b.paymentMethod,
      paymentStatus: b.paymentStatus,
      status: b.status,
      createdAt: new Date(b.createdAt).toISOString(),
      customer: {
        id: b.customer.id,
        name: b.customer.name,
        email: b.customer.email,
        phone: b.customer.phone
      },
      worker: {
        id: b.worker.id,
        name: b.worker.name,
        email: b.worker.email,
        phone: b.worker.phone,
        aadhaarNumberMasked: b.worker.workerProfile?.aadhaarNumberMasked ?? '',
        aadhaarCardUrl: b.worker.workerProfile?.aadhaarCardUrl ?? ''
      },
      service: {
        id: b.service.id,
        name: b.service.name,
        basePrice: b.service.basePrice
      }
    }))
  });
});

router.get('/complaints', requireAuth, requireRole('admin'), async (_req, res) => {
  const flaggedWorkers = await prisma.user.findMany({
    where: {
      role: 'worker',
      isComplaintFlagged: true
    } as any,
    include: { workerProfile: true },
    orderBy: { updatedAt: 'desc' }
  });

  return res.json({
    complaints: flaggedWorkers.map((worker: any) => ({
      workerId: worker.id,
      workerName: worker.name,
      workerEmail: worker.email,
      workerPhone: worker.phone,
      note: worker.complaintFlagNote || '',
      isPriorityBoosted: Boolean(worker.isPriorityBoosted),
      isVerifiedPlus: Boolean(worker.isVerifiedPlus),
      updatedAt: new Date(worker.updatedAt).toISOString()
    }))
  });
});

router.get('/payments', requireAuth, requireRole('admin'), async (_req, res) => {
  const bookings: any[] = await prisma.booking.findMany();
  const payments = bookings.map((b) => ({
    bookingId: b.id,
    amount: b.totalAmount,
    method: b.paymentMethod,
    status: b.paymentStatus
  }));

  return res.json({ payments });
});

router.get('/monetization/plans', requireAuth, requireRole('admin'), async (_req, res) => {
  const workers: any[] = await prisma.user.findMany({
    where: { role: 'worker' as any },
    select: {
      id: true,
      listingType: true,
      subscriptionPlan: true
    } as any
  });

  const summary = workers.reduce(
    (acc, worker: any) => {
      acc.totalWorkers += 1;
      if (worker.listingType === 'promoted') acc.promotedWorkers += 1;
      const key = String(worker.subscriptionPlan || 'none');
      acc.subscriptions[key] = (acc.subscriptions[key] ?? 0) + 1;
      return acc;
    },
    {
      totalWorkers: 0,
      promotedWorkers: 0,
      subscriptions: { none: 0, starter: 0, growth: 0, pro: 0 } as Record<string, number>
    }
  );

  return res.json({
    model: {
      freeListing: 'Available',
      promotedListing: 'Top placement ads enabled via listingType=promoted',
      subscriptionPlans: [
        { id: 'starter', priceMonthly: 499, features: ['priority support', 'basic lead insights'] },
        { id: 'growth', priceMonthly: 999, features: ['promoted boosts', 'higher response visibility'] },
        { id: 'pro', priceMonthly: 1999, features: ['top placement ads', 'advanced profile analytics'] }
      ]
    },
    summary
  });
});

router.patch('/workers/:workerId/monetization', requireAuth, requireRole('admin'), async (req, res) => {
  const parsed = monetizationSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid monetization payload', errors: parsed.error.flatten() });
  }

  const data = parsed.data;
  try {
    const result = await (prisma as any).user.updateMany({
      where: { id: req.params.workerId, role: 'worker' },
      data: {
        ...(data.listingType !== undefined ? { listingType: data.listingType } : {}),
        ...(data.subscriptionPlan !== undefined ? { subscriptionPlan: data.subscriptionPlan } : {}),
        ...(data.subscriptionEndsAt !== undefined
          ? { subscriptionEndsAt: data.subscriptionEndsAt ? new Date(data.subscriptionEndsAt) : null }
          : {}),
        ...(data.adCredits !== undefined ? { adCredits: data.adCredits } : {}),
        ...(data.listingType !== undefined ? { isPriorityBoosted: data.listingType === 'promoted' } : {})
      }
    });

    if (result.count === 0) return res.status(404).json({ message: 'Worker not found' });
    return res.json({ message: 'Worker monetization updated' });
  } catch (error: any) {
    const message = String(error?.message ?? '');
    if (
      message.includes('Unknown argument `listingType`') ||
      message.includes('Unknown field `listingType`') ||
      message.includes('Unknown argument `subscriptionPlan`') ||
      message.includes('Unknown field `subscriptionPlan`') ||
      message.includes('Unknown argument `subscriptionEndsAt`') ||
      message.includes('Unknown field `subscriptionEndsAt`') ||
      message.includes('Unknown argument `adCredits`') ||
      message.includes('Unknown field `adCredits`')
    ) {
      return res.status(500).json({ message: 'Monetization fields not migrated yet. Run prisma db push.' });
    }
    return res.status(500).json({ message: 'Failed to update worker monetization' });
  }
});

export default router;
