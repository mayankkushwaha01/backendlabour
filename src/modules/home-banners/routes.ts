import { Router } from 'express';
import { prisma } from '../../config/db.js';
import { cacheResponse } from '../../lib/cache.js';

const router = Router();

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

const resolveRunningCoupon = async (preferredCode?: string | null) => {
  const code = String(preferredCode || '').trim().toUpperCase();
  if (code) {
    const preferred = await prisma.$queryRaw<
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
    >`SELECT code, title, type, value, isActive, startsAt, endsAt, usageLimit, usedCount FROM Coupon WHERE code = ${code} LIMIT 1`;
    if (preferred[0] && isCouponRunning(preferred[0])) return preferred[0];
  }

  const candidates = await prisma.$queryRaw<
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
  >`SELECT code, title, type, value, isActive, startsAt, endsAt, usageLimit, usedCount FROM Coupon ORDER BY createdAt DESC LIMIT 80`;
  return candidates.find((item) => isCouponRunning(item)) ?? null;
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

router.get('/public', cacheResponse(60_000), async (_req, res) => {
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
      }>
    >`
      SELECT id, bannerKey, title, subtitle, highlightText, imageUrl, targetServiceKey, toneStart, toneEnd, isActive, sortOrder, updatedAt
      FROM HomeBanner
      WHERE isActive = TRUE
      ORDER BY sortOrder ASC, updatedAt DESC
      LIMIT 12
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
        sortOrder: Number(row.sortOrder ?? 0),
        updatedAt: new Date(row.updatedAt).toISOString()
      }))
    });
  } catch (error) {
    console.error('home-banners/public failed', error);
    return res.json({ banners: [] });
  }
});

router.get('/offer/public', cacheResponse(60_000), async (_req, res) => {
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
    const row = rows[0];
    if (!row || !Boolean(row.isActive)) {
      return res.json({ offer: null });
    }

    const runningCoupon = await resolveRunningCoupon(row.couponCode);
    const offerText =
      row.offerText?.trim() ||
      (runningCoupon
        ? runningCoupon.type === 'percent'
          ? `${Math.round(Number(runningCoupon.value || 0))}% OFF`
          : `₹${Math.round(Number(runningCoupon.value || 0))} OFF`
        : 'Special Offer');

    return res.json({
      offer: {
        id: row.id,
        offerText,
        subtitle: row.subtitle || 'On selected services',
        couponCode: runningCoupon?.code || null,
        couponTitle: runningCoupon?.title || null,
        toneStart: row.toneStart || '#7B2FF7',
        toneEnd: row.toneEnd || '#9F5BFF',
        updatedAt: new Date(row.updatedAt).toISOString()
      }
    });
  } catch (error) {
    console.error('home-banners/offer/public failed', error);
    return res.json({ offer: null });
  }
});

export default router;
