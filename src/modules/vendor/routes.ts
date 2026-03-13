import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/db.js';
import { requireAuth, type AuthRequest } from '../../middleware/auth.js';

const router = Router();
const dataUrlImageRegex = /^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/;

const createBusinessSchema = z.object({
  name: z.string().min(2).max(120),
  description: z.string().max(3000).optional(),
  categoryId: z.string().min(3),
  address: z.string().max(400).optional(),
  city: z.string().max(120).optional(),
  locationText: z.string().max(240).optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  coverPhotoUrl: z.string().url().or(z.string().regex(dataUrlImageRegex)).optional()
});

const updateBusinessSchema = createBusinessSchema.partial();

const businessPhotoSchema = z.object({
  url: z.string().url().or(z.string().regex(dataUrlImageRegex)),
  caption: z.string().max(240).optional(),
  sortOrder: z.number().int().min(0).max(999).optional()
});
const businessPhotoUpdateSchema = businessPhotoSchema.partial();

const serviceSchema = z.object({
  title: z.string().min(2).max(120),
  isActive: z.boolean().optional()
});

const enquiryStatusSchema = z.object({
  status: z.enum(['open', 'closed'])
});

const rangeSchema = z.object({
  range: z.enum(['7d', '30d']).optional()
});
const subscriptionQuerySchema = z.object({
  target: z.enum(['business', 'worker']).optional()
});
const activateSubscriptionSchema = z.object({
  target: z.enum(['business', 'worker']),
  planKey: z.enum(['verified', 'verified_top_rated', 'rocket']),
  billingCycle: z.enum(['monthly', 'yearly']).default('monthly'),
  paymentMethod: z.enum(['upi', 'amanpay']),
  paymentStatus: z.enum(['pending', 'success', 'failed']),
  paymentRef: z.string().min(6).max(120)
});

const getPlanMeta = (planKey: 'verified' | 'verified_top_rated' | 'rocket') => {
  if (planKey === 'verified') {
    return {
      subscriptionPlan: 'starter' as const,
      listingType: 'free' as const,
      isVerifiedPlus: true,
      isPriorityBoosted: false,
      jobsLimit: 10,
      badge: 'Verified',
      monthly: 99,
      yearly: 950
    };
  }
  if (planKey === 'verified_top_rated') {
    return {
      subscriptionPlan: 'growth' as const,
      listingType: 'promoted' as const,
      isVerifiedPlus: true,
      isPriorityBoosted: true,
      jobsLimit: 20,
      badge: 'Verified + Top Rated',
      monthly: 199,
      yearly: 1900
    };
  }
  return {
    subscriptionPlan: 'pro' as const,
    listingType: 'promoted' as const,
    isVerifiedPlus: true,
    isPriorityBoosted: true,
    jobsLimit: 999999,
    badge: 'Rocket',
    monthly: 499,
    yearly: 4790
  };
};

const mapExistingPlan = (subscriptionPlan: string, listingType: string) => {
  if (subscriptionPlan === 'starter') return 'verified' as const;
  if (subscriptionPlan === 'growth') return 'verified_top_rated' as const;
  if (subscriptionPlan === 'pro') return 'rocket' as const;
  if (listingType === 'promoted') return 'verified_top_rated' as const;
  return 'verified' as const;
};

const getOwnedBusiness = async (businessId: string, userId: string) =>
  (prisma as any).business.findFirst({
    where: { id: businessId, vendorUserId: userId }
  });

router.get('/categories', requireAuth, async (_req: AuthRequest, res) => {
  const categories = await (prisma as any).category.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }]
  });
  return res.json({
    categories: categories.map((category: any) => ({
      id: category.id,
      name: category.name,
      slug: category.slug,
      icon: category.icon
    }))
  });
});

router.get('/business', requireAuth, async (req: AuthRequest, res) => {
  const business = await (prisma as any).business.findFirst({
    where: { vendorUserId: req.auth!.userId },
    include: {
      category: true,
      photos: { orderBy: { sortOrder: 'asc' } },
      services: { orderBy: { createdAt: 'asc' } }
    }
  });

  if (!business) {
    return res.json({ business: null });
  }

  return res.json({
    business: {
      id: business.id,
      vendorUserId: business.vendorUserId,
      name: business.name,
      description: business.description,
      categoryId: business.categoryId,
      categoryName: business.category?.name ?? '',
      address: business.address,
      city: business.city,
      locationText: business.locationText,
      lat: business.lat,
      lng: business.lng,
      coverPhotoUrl: business.coverPhotoUrl || '',
      isApproved: business.isApproved,
      avgRating: business.avgRating,
      totalReviews: business.totalReviews,
      listingType: business.listingType,
      subscriptionPlan: business.subscriptionPlan,
      photos: (business.photos ?? []).map((photo: any) => ({
        id: photo.id,
        url: photo.url,
        caption: photo.caption,
        sortOrder: photo.sortOrder
      })),
      services: (business.services ?? []).map((service: any) => ({
        id: service.id,
        title: service.title,
        isActive: service.isActive
      }))
    }
  });
});

router.post('/business', requireAuth, async (req: AuthRequest, res) => {
  const parsed = createBusinessSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid payload', errors: parsed.error.flatten() });
  }

  const category = await (prisma as any).category.findUnique({ where: { id: parsed.data.categoryId } });
  if (!category || !category.isActive) {
    return res.status(404).json({ message: 'Category not found or inactive' });
  }

  const existing = await (prisma as any).business.findFirst({
    where: { vendorUserId: req.auth!.userId }
  });
  if (existing) {
    return res.status(409).json({ message: 'Vendor business already exists. Use update endpoint.' });
  }

  const business = await (prisma as any).business.create({
    data: {
      vendorUserId: req.auth!.userId,
      name: parsed.data.name.trim(),
      description: parsed.data.description?.trim() ?? '',
      categoryId: parsed.data.categoryId,
      address: parsed.data.address?.trim() ?? '',
      city: parsed.data.city?.trim() ?? '',
      locationText: parsed.data.locationText?.trim() ?? '',
      lat: parsed.data.lat ?? null,
      lng: parsed.data.lng ?? null,
      coverPhotoUrl: parsed.data.coverPhotoUrl ?? '',
      isApproved: false
    }
  });

  return res.status(201).json({
    business: {
      id: business.id,
      vendorUserId: business.vendorUserId,
      name: business.name,
      isApproved: business.isApproved
    }
  });
});

router.patch('/business/:id', requireAuth, async (req: AuthRequest, res) => {
  const parsed = updateBusinessSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid payload', errors: parsed.error.flatten() });
  }

  const owned = await getOwnedBusiness(req.params.id, req.auth!.userId);
  if (!owned) return res.status(404).json({ message: 'Business not found' });

  if (parsed.data.categoryId) {
    const category = await (prisma as any).category.findUnique({ where: { id: parsed.data.categoryId } });
    if (!category || !category.isActive) {
      return res.status(404).json({ message: 'Category not found or inactive' });
    }
  }

  const business = await (prisma as any).business.update({
    where: { id: owned.id },
    data: {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name.trim() } : {}),
      ...(parsed.data.description !== undefined ? { description: parsed.data.description?.trim() ?? '' } : {}),
      ...(parsed.data.categoryId !== undefined ? { categoryId: parsed.data.categoryId } : {}),
      ...(parsed.data.address !== undefined ? { address: parsed.data.address?.trim() ?? '' } : {}),
      ...(parsed.data.city !== undefined ? { city: parsed.data.city?.trim() ?? '' } : {}),
      ...(parsed.data.locationText !== undefined ? { locationText: parsed.data.locationText?.trim() ?? '' } : {}),
      ...(parsed.data.lat !== undefined ? { lat: parsed.data.lat } : {}),
      ...(parsed.data.lng !== undefined ? { lng: parsed.data.lng } : {}),
      ...(parsed.data.coverPhotoUrl !== undefined ? { coverPhotoUrl: parsed.data.coverPhotoUrl ?? '' } : {})
    }
  });

  return res.json({
    business: {
      id: business.id,
      name: business.name,
      description: business.description,
      categoryId: business.categoryId,
      address: business.address,
      city: business.city,
      locationText: business.locationText,
      lat: business.lat,
      lng: business.lng,
      coverPhotoUrl: business.coverPhotoUrl
    }
  });
});

router.delete('/business/:id', requireAuth, async (req: AuthRequest, res) => {
  const owned = await getOwnedBusiness(req.params.id, req.auth!.userId);
  if (!owned) return res.status(404).json({ message: 'Business not found' });

  await (prisma as any).business.delete({
    where: { id: owned.id }
  });

  return res.status(204).send();
});

router.post('/business/:id/photos', requireAuth, async (req: AuthRequest, res) => {
  const parsed = businessPhotoSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid photo payload', errors: parsed.error.flatten() });
  }
  const owned = await getOwnedBusiness(req.params.id, req.auth!.userId);
  if (!owned) return res.status(404).json({ message: 'Business not found' });

  const photo = await (prisma as any).businessPhoto.create({
    data: {
      businessId: owned.id,
      url: parsed.data.url,
      caption: parsed.data.caption?.trim() ?? '',
      sortOrder: parsed.data.sortOrder ?? 0
    }
  });
  return res.status(201).json({
    photo: {
      id: photo.id,
      businessId: photo.businessId,
      url: photo.url,
      caption: photo.caption,
      sortOrder: photo.sortOrder
    }
  });
});

router.patch('/business/:id/photos/:photoId', requireAuth, async (req: AuthRequest, res) => {
  const parsed = businessPhotoUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid photo payload', errors: parsed.error.flatten() });
  }
  const owned = await getOwnedBusiness(req.params.id, req.auth!.userId);
  if (!owned) return res.status(404).json({ message: 'Business not found' });

  const existingPhoto = await (prisma as any).businessPhoto.findFirst({
    where: { id: req.params.photoId, businessId: owned.id }
  });
  if (!existingPhoto) return res.status(404).json({ message: 'Photo not found' });

  const photo = await (prisma as any).businessPhoto.update({
    where: { id: existingPhoto.id },
    data: {
      ...(parsed.data.url !== undefined ? { url: parsed.data.url } : {}),
      ...(parsed.data.caption !== undefined ? { caption: parsed.data.caption?.trim() ?? '' } : {}),
      ...(parsed.data.sortOrder !== undefined ? { sortOrder: parsed.data.sortOrder } : {})
    }
  });

  return res.json({
    photo: {
      id: photo.id,
      businessId: photo.businessId,
      url: photo.url,
      caption: photo.caption,
      sortOrder: photo.sortOrder
    }
  });
});

router.delete('/business/:id/photos/:photoId', requireAuth, async (req: AuthRequest, res) => {
  const owned = await getOwnedBusiness(req.params.id, req.auth!.userId);
  if (!owned) return res.status(404).json({ message: 'Business not found' });

  const existingPhoto = await (prisma as any).businessPhoto.findFirst({
    where: { id: req.params.photoId, businessId: owned.id }
  });
  if (!existingPhoto) return res.status(404).json({ message: 'Photo not found' });

  await (prisma as any).businessPhoto.delete({ where: { id: existingPhoto.id } });
  return res.status(204).send();
});

router.post('/business/:id/services', requireAuth, async (req: AuthRequest, res) => {
  const parsed = serviceSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid service payload', errors: parsed.error.flatten() });
  }
  const owned = await getOwnedBusiness(req.params.id, req.auth!.userId);
  if (!owned) return res.status(404).json({ message: 'Business not found' });

  const service = await (prisma as any).businessService.create({
    data: {
      businessId: owned.id,
      title: parsed.data.title.trim(),
      isActive: parsed.data.isActive ?? true
    }
  });
  return res.status(201).json({
    service: {
      id: service.id,
      businessId: service.businessId,
      title: service.title,
      isActive: service.isActive
    }
  });
});

router.get('/enquiries', requireAuth, async (req: AuthRequest, res) => {
  const business = await (prisma as any).business.findFirst({
    where: { vendorUserId: req.auth!.userId }
  });
  if (!business) return res.json({ enquiries: [] });

  const enquiries = await (prisma as any).enquiry.findMany({
    where: { businessId: business.id },
    orderBy: { createdAt: 'desc' }
  });
  return res.json({
    enquiries: enquiries.map((enquiry: any) => ({
      id: enquiry.id,
      businessId: enquiry.businessId,
      customerId: enquiry.customerId,
      name: enquiry.name,
      mobile: enquiry.mobile,
      message: enquiry.message,
      status: enquiry.status,
      createdAt: new Date(enquiry.createdAt).toISOString()
    }))
  });
});

router.patch('/enquiries/:id/status', requireAuth, async (req: AuthRequest, res) => {
  const parsed = enquiryStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid status payload', errors: parsed.error.flatten() });
  }

  const enquiry = await (prisma as any).enquiry.findUnique({
    where: { id: req.params.id },
    include: { business: true }
  });
  if (!enquiry || enquiry.business.vendorUserId !== req.auth!.userId) {
    return res.status(404).json({ message: 'Enquiry not found' });
  }

  const updated = await (prisma as any).enquiry.update({
    where: { id: enquiry.id },
    data: { status: parsed.data.status }
  });
  return res.json({
    enquiry: {
      id: updated.id,
      status: updated.status
    }
  });
});

router.get('/analytics', requireAuth, async (req: AuthRequest, res) => {
  const parsed = rangeSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid range query', errors: parsed.error.flatten() });
  }
  const range = parsed.data.range ?? '7d';
  const days = range === '30d' ? 30 : 7;
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const business = await (prisma as any).business.findFirst({ where: { vendorUserId: req.auth!.userId } });
  if (!business) {
    return res.json({
      range,
      totals: { views: 0, callClicks: 0, whatsappClicks: 0, enquiries: 0 },
      funnel: []
    });
  }

  const [events, enquiries] = await Promise.all([
    (prisma as any).analyticsEvent.findMany({
      where: { businessId: business.id, createdAt: { gte: from } }
    }),
    (prisma as any).enquiry.count({ where: { businessId: business.id, createdAt: { gte: from } } })
  ]);

  const totals = {
    views: 0,
    callClicks: 0,
    whatsappClicks: 0,
    enquiries: enquiries
  };
  for (const event of events) {
    if (event.eventType === 'view') totals.views += 1;
    if (event.eventType === 'call_click') totals.callClicks += 1;
    if (event.eventType === 'whatsapp_click') totals.whatsappClicks += 1;
  }

  const recentViewEvents = await (prisma as any).analyticsEvent.findMany({
    where: {
      businessId: business.id,
      eventType: 'view',
      createdAt: { gte: from },
      actorUserId: { not: null }
    },
    include: {
      actor: {
        select: {
          id: true,
          name: true,
          profilePhotoUrl: true,
          role: true
        }
      }
    },
    orderBy: { createdAt: 'desc' },
    take: 200
  });

  const seen = new Set<string>();
  const visitors: Array<{ userId: string; name: string; profilePhotoUrl: string; role: string; visitedAt: string }> = [];
  for (const event of recentViewEvents) {
    const actor = event.actor;
    if (!actor?.id || seen.has(actor.id)) continue;
    seen.add(actor.id);
    visitors.push({
      userId: actor.id,
      name: actor.name,
      profilePhotoUrl: actor.profilePhotoUrl || '',
      role: actor.role,
      visitedAt: new Date(event.createdAt).toISOString()
    });
    if (visitors.length >= 20) break;
  }
  const anonymousVisits = Math.max(0, totals.views - recentViewEvents.length);

  return res.json({
    range,
    totals,
    visitors,
    anonymousVisits,
    funnel: [
      { stage: 'views', value: totals.views },
      { stage: 'call_click', value: totals.callClicks },
      { stage: 'whatsapp_click', value: totals.whatsappClicks },
      { stage: 'enquiry_submit', value: totals.enquiries }
    ]
  });
});

router.get('/subscription', requireAuth, async (req: AuthRequest, res) => {
  const parsed = subscriptionQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid subscription query', errors: parsed.error.flatten() });
  }

  const target = parsed.data.target ?? 'business';
  const userId = req.auth!.userId;
  const now = Date.now();
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  if (target === 'worker') {
    const worker = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        listingType: true,
        subscriptionPlan: true,
        subscriptionEndsAt: true,
        isVerifiedPlus: true,
        isPriorityBoosted: true
      }
    });
    if (!worker) {
      return res.status(404).json({ message: 'User not found' });
    }
    const planKey = mapExistingPlan(String(worker.subscriptionPlan ?? 'none'), String(worker.listingType ?? 'free'));
    const planMeta = getPlanMeta(planKey);
    const endsAtMs = worker.subscriptionEndsAt ? new Date(worker.subscriptionEndsAt).getTime() : null;
    const isActive = endsAtMs ? endsAtMs >= now : false;
    const jobsUsed = await prisma.booking.count({
      where: {
        workerId: userId,
        createdAt: { gte: monthStart },
        status: { in: ['pending', 'accepted', 'on_the_way', 'started', 'in_progress', 'completed'] }
      }
    });
    return res.json({
      subscription: {
        target: 'worker',
        listingType: worker.listingType,
        plan: worker.subscriptionPlan,
        planKey,
        badge: planMeta.badge,
        endsAt: worker.subscriptionEndsAt ? new Date(worker.subscriptionEndsAt).toISOString() : null,
        isActive,
        jobsLimit: planMeta.jobsLimit,
        jobsUsed,
        jobsRemaining: Math.max(0, planMeta.jobsLimit - jobsUsed),
        monthlyPrice: planMeta.monthly,
        yearlyPrice: planMeta.yearly,
        isVerifiedPlus: Boolean(worker.isVerifiedPlus),
        isPriorityBoosted: Boolean(worker.isPriorityBoosted)
      }
    });
  }

  const business = await (prisma as any).business.findFirst({
    where: { vendorUserId: userId }
  });
  if (!business) {
    return res.json({
      subscription: {
        target: 'business',
        listingType: 'free',
        plan: 'none',
        planKey: 'verified',
        badge: 'Verified',
        endsAt: null,
        isActive: false,
        jobsLimit: 10,
        jobsUsed: 0,
        jobsRemaining: 10,
        monthlyPrice: 99,
        yearlyPrice: 950,
        isVerifiedPlus: false,
        isPriorityBoosted: false
      }
    });
  }

  const planKey = mapExistingPlan(String(business.subscriptionPlan ?? 'none'), String(business.listingType ?? 'free'));
  const planMeta = getPlanMeta(planKey);
  const endsAtMs = business.subscriptionEndsAt ? new Date(business.subscriptionEndsAt).getTime() : null;
  const isActive = endsAtMs ? endsAtMs >= now : false;
  const jobsUsed = await (prisma as any).enquiry.count({
    where: { businessId: business.id, createdAt: { gte: monthStart } }
  });
  return res.json({
    subscription: {
      target: 'business',
      listingType: business.listingType,
      plan: business.subscriptionPlan,
      planKey,
      badge: planMeta.badge,
      endsAt: business.subscriptionEndsAt ? new Date(business.subscriptionEndsAt).toISOString() : null,
      isActive,
      jobsLimit: planMeta.jobsLimit,
      jobsUsed,
      jobsRemaining: Math.max(0, planMeta.jobsLimit - jobsUsed),
      monthlyPrice: planMeta.monthly,
      yearlyPrice: planMeta.yearly,
      isVerifiedPlus: true,
      isPriorityBoosted: Boolean(business.listingType === 'promoted')
    }
  });
});

router.post('/subscription/activate', requireAuth, async (req: AuthRequest, res) => {
  const parsed = activateSubscriptionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid subscription payload', errors: parsed.error.flatten() });
  }

  const { target, planKey, billingCycle } = parsed.data;
  const { paymentStatus, paymentMethod, paymentRef } = parsed.data;
  const userId = req.auth!.userId;
  const planMeta = getPlanMeta(planKey);
  const nextEndsAt = new Date();
  nextEndsAt.setDate(nextEndsAt.getDate() + (billingCycle === 'yearly' ? 365 : 30));

  if (paymentStatus !== 'success') {
    return res.status(402).json({
      message: 'Payment required. Plan will upgrade only after successful payment.',
      payment: { paymentStatus, paymentMethod, paymentRef }
    });
  }

  if (target === 'worker') {
    const worker = await prisma.user.findUnique({ where: { id: userId } });
    if (!worker) return res.status(404).json({ message: 'User not found' });

    await prisma.user.update({
      where: { id: userId },
      data: {
        listingType: planMeta.listingType,
        subscriptionPlan: planMeta.subscriptionPlan,
        subscriptionEndsAt: nextEndsAt,
        isVerifiedPlus: planMeta.isVerifiedPlus,
        isPriorityBoosted: planMeta.isPriorityBoosted
      } as any
    });
    return res.json({
      message: 'Worker subscription activated',
      subscription: {
        target: 'worker',
        planKey,
        plan: planMeta.subscriptionPlan,
        listingType: planMeta.listingType,
        endsAt: nextEndsAt.toISOString(),
        billingCycle
      }
    });
  }

  const business = await (prisma as any).business.findFirst({ where: { vendorUserId: userId } });
  if (!business) return res.status(404).json({ message: 'Business not found' });

  await (prisma as any).business.update({
    where: { id: business.id },
    data: {
      listingType: planMeta.listingType,
      subscriptionPlan: planMeta.subscriptionPlan,
      subscriptionEndsAt: nextEndsAt
    }
  });
  await prisma.user.update({
    where: { id: userId },
    data: {
      isVerifiedPlus: planMeta.isVerifiedPlus,
      isPriorityBoosted: planMeta.isPriorityBoosted
    }
  });

  return res.json({
    message: 'Business subscription activated',
    subscription: {
      target: 'business',
      planKey,
      plan: planMeta.subscriptionPlan,
      listingType: planMeta.listingType,
      endsAt: nextEndsAt.toISOString(),
      billingCycle
    }
  });
});

export default router;
