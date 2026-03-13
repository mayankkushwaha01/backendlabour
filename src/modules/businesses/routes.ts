import { Router } from 'express';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { prisma } from '../../config/db.js';
import { requireAuth, type AuthRequest } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/role.js';
import { env } from '../../config/env.js';

const router = Router();

const listQuerySchema = z.object({
  query: z.string().optional(),
  category: z.string().optional(),
  location: z.string().optional(),
  minRating: z.coerce.number().min(0).max(5).optional(),
  distanceKm: z.coerce.number().min(0).optional(),
  sort: z.enum(['relevance', 'rating', 'latest']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  lat: z.coerce.number().optional(),
  lng: z.coerce.number().optional()
});

const reviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().min(2).max(1500),
  photoUrl: z.string().url().optional(),
  tags: z.array(z.string().min(1).max(50)).max(12).optional()
});

const enquirySchema = z.object({
  name: z.string().min(2).max(120),
  mobile: z.string().regex(/^\d{10,15}$/),
  message: z.string().min(3).max(1200)
});

const haversineKm = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

const getDistance = (lat?: number | null, lng?: number | null, qLat?: number, qLng?: number) => {
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (typeof qLat !== 'number' || typeof qLng !== 'number') return null;
  return Number(haversineKm(qLat, qLng, lat, lng).toFixed(2));
};

const directionUrl = (lat?: number | null, lng?: number | null, address = '') => {
  if (typeof lat === 'number' && typeof lng === 'number') {
    return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address || 'India')}`;
};

const baseBusinessSelect = {
  vendor: { select: { id: true, name: true, phone: true, role: true, isVerifiedPlus: true, profilePhotoUrl: true } },
  category: true,
  photos: { orderBy: { sortOrder: 'asc' }, take: 6 },
  services: { where: { isActive: true }, orderBy: { createdAt: 'asc' } },
  _count: { select: { reviews: true } }
};

const serializeBusiness = (business: any, qLat?: number, qLng?: number) => {
  const dist = getDistance(business.lat, business.lng, qLat, qLng);

  return {
    id: business.id,
    source: 'business',
    name: business.name,
    description: business.description ?? '',
    category: business.category
      ? {
          id: business.category.id,
          name: business.category.name,
          slug: business.category.slug,
          icon: business.category.icon
        }
      : null,
    address: business.address,
    city: business.city,
    locationText: business.locationText,
    lat: business.lat,
    lng: business.lng,
    coverPhotoUrl: business.coverPhotoUrl || business.photos?.[0]?.url || '',
    photos: (business.photos ?? []).map((photo: any) => ({
      id: photo.id,
      url: photo.url,
      caption: photo.caption
    })),
    services: (business.services ?? []).map((service: any) => ({
      id: service.id,
      title: service.title
    })),
    avgRating: Number(business.avgRating ?? 0),
    totalReviews: Number(business.totalReviews ?? business._count?.reviews ?? 0),
    distanceKm: dist,
    listingType: business.listingType ?? 'free',
    subscriptionPlan: business.subscriptionPlan ?? 'none',
    subscriptionEndsAt: business.subscriptionEndsAt ? new Date(business.subscriptionEndsAt).toISOString() : null,
    isApproved: Boolean(business.isApproved),
    vendor: {
      userId: business.vendor.id,
      name: business.vendor.name,
      phone: business.vendor.phone,
      profilePhotoUrl: business.vendor.profilePhotoUrl || '',
      isVerified: Boolean(business.vendor.isVerifiedPlus)
    },
    actions: {
      callPhone: business.vendor.phone,
      whatsappPhone: business.vendor.phone,
      directionUrl: directionUrl(business.lat, business.lng, `${business.address} ${business.city}`.trim())
    }
  };
};

const createAnalyticsEvent = async (businessId: string, eventType: 'view' | 'call_click' | 'whatsapp_click' | 'enquiry_submit', actorUserId?: string) => {
  try {
    await (prisma as any).analyticsEvent.create({
      data: {
        businessId,
        eventType,
        actorUserId: actorUserId ?? null
      }
    });
  } catch {
    // Analytics should never block primary API response.
  }
};

const extractActorUserId = (authorizationHeader?: string) => {
  if (!authorizationHeader || !authorizationHeader.startsWith('Bearer ')) return undefined;
  const token = authorizationHeader.slice('Bearer '.length);
  try {
    const payload = jwt.verify(token, env.jwtSecret) as { sub?: string };
    return payload.sub;
  } catch {
    return undefined;
  }
};

router.get('/', async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid query params', errors: parsed.error.flatten() });
  }

  const { query, category, location, minRating, distanceKm, sort, page = 1, limit = 20, lat, lng } = parsed.data;
  const skip = (page - 1) * limit;

  const where: any = {
    isApproved: true,
    vendor: { role: { not: 'worker' } },
    ...(category
      ? {
          OR: [
            { category: { slug: { equals: category.toLowerCase() } } },
            { category: { name: { contains: category, mode: 'insensitive' } } }
          ]
        }
      : {}),
    ...(location
      ? {
          OR: [
            { city: { contains: location, mode: 'insensitive' } },
            { locationText: { contains: location, mode: 'insensitive' } },
            { address: { contains: location, mode: 'insensitive' } }
          ]
        }
      : {}),
    ...(minRating !== undefined ? { avgRating: { gte: minRating } } : {}),
    ...(query
      ? {
          OR: [
            { name: { contains: query, mode: 'insensitive' } },
            { description: { contains: query, mode: 'insensitive' } },
            { services: { some: { title: { contains: query, mode: 'insensitive' } } } },
            { category: { name: { contains: query, mode: 'insensitive' } } }
          ]
        }
      : {})
  };

  const orderBy =
    sort === 'rating'
      ? [{ avgRating: 'desc' }, { totalReviews: 'desc' }]
      : sort === 'latest'
        ? [{ createdAt: 'desc' }]
        : [{ listingType: 'desc' }, { avgRating: 'desc' }, { createdAt: 'desc' }];

  const rows = await (prisma as any).business.findMany({
    where,
    include: baseBusinessSelect,
    skip,
    take: limit,
    orderBy
  });

  let data = rows.map((row: any) => serializeBusiness(row, lat, lng));

  if (distanceKm !== undefined) {
    data = data.filter((item: any) => item.distanceKm == null || item.distanceKm <= distanceKm);
  }

  return res.json({ businesses: data, page, limit, using: 'business' });
});

router.get('/:id', async (req, res) => {
  const actorUserId = extractActorUserId(req.headers.authorization);
  const business = await (prisma as any).business.findFirst({
    where: { id: req.params.id, isApproved: true },
    include: {
      ...baseBusinessSelect,
      reviews: {
        take: 3,
        orderBy: { createdAt: 'desc' },
        include: { customer: { select: { id: true, name: true, profilePhotoUrl: true } } }
      }
    }
  });

  if (business) {
    await createAnalyticsEvent(business.id, 'view', actorUserId);
    return res.json({
      business: {
        ...serializeBusiness(business),
        reviewsPreview: (business.reviews ?? []).map((review: any) => ({
          id: review.id,
          rating: review.rating,
          comment: review.comment,
          createdAt: new Date(review.createdAt).toISOString(),
          customer: {
            id: review.customer?.id ?? '',
            name: review.customer?.name ?? 'Customer',
            profilePhotoUrl: review.customer?.profilePhotoUrl ?? ''
          }
        }))
      }
    });
  }

  return res.status(404).json({ message: 'Business not found' });
});

router.get('/:id/reviews', async (req, res) => {
  const business = await (prisma as any).business.findUnique({ where: { id: req.params.id } });
  if (business) {
    const reviews = await (prisma as any).businessReview.findMany({
      where: { businessId: req.params.id },
      include: { customer: { select: { id: true, name: true, profilePhotoUrl: true } } },
      orderBy: { createdAt: 'desc' }
    });
    return res.json({
      reviews: reviews.map((review: any) => ({
        id: review.id,
        rating: review.rating,
        comment: review.comment,
        photoUrl: review.photoUrl || null,
        tags: Array.isArray(review.tags) ? review.tags : [],
        createdAt: new Date(review.createdAt).toISOString(),
        customer: {
          id: review.customer?.id ?? '',
          name: review.customer?.name ?? 'Customer',
          profilePhotoUrl: review.customer?.profilePhotoUrl ?? ''
        }
      }))
    });
  }

  const worker = await prisma.user.findFirst({ where: { id: req.params.id, role: 'worker' } });
  if (!worker) return res.status(404).json({ message: 'Business not found' });
  const legacyReviews = await prisma.review.findMany({
    where: { workerId: worker.id },
    include: { customer: { select: { id: true, name: true, profilePhotoUrl: true } } },
    orderBy: { createdAt: 'desc' }
  });
  return res.json({
    reviews: legacyReviews.map((review: any) => ({
      id: review.id,
      rating: review.rating,
      comment: review.comment,
      photoUrl: review.photoUrl || null,
      tags: Array.isArray(review.tags) ? review.tags : [],
      createdAt: new Date(review.createdAt).toISOString(),
      customer: {
        id: review.customer?.id ?? '',
        name: review.customer?.name ?? 'Customer',
        profilePhotoUrl: review.customer?.profilePhotoUrl ?? ''
      }
    }))
  });
});

router.post('/:id/review', requireAuth, requireRole('customer'), async (req: AuthRequest, res) => {
  const parsed = reviewSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid review payload', errors: parsed.error.flatten() });
  }

  const business = await (prisma as any).business.findUnique({ where: { id: req.params.id } });
  if (business) {
    const review = await (prisma as any).businessReview.create({
      data: {
        businessId: business.id,
        customerId: req.auth!.userId,
        rating: parsed.data.rating,
        comment: parsed.data.comment.trim(),
        photoUrl: parsed.data.photoUrl ?? null,
        tags: parsed.data.tags ?? []
      }
    });

    const aggregate = await (prisma as any).businessReview.aggregate({
      where: { businessId: business.id },
      _avg: { rating: true },
      _count: { rating: true }
    });

    await (prisma as any).business.update({
      where: { id: business.id },
      data: {
        avgRating: Number(aggregate._avg.rating ?? 0),
        totalReviews: Number(aggregate._count.rating ?? 0)
      }
    });

    return res.status(201).json({
      review: {
        id: review.id,
        businessId: review.businessId,
        rating: review.rating,
        comment: review.comment,
        createdAt: new Date(review.createdAt).toISOString()
      }
    });
  }

  const worker = await prisma.user.findFirst({ where: { id: req.params.id, role: 'worker' } });
  if (!worker) return res.status(404).json({ message: 'Business not found' });
  const booking = await prisma.booking.findFirst({
    where: { customerId: req.auth!.userId, workerId: worker.id, status: 'completed' },
    orderBy: { completedAt: 'desc' }
  });
  if (!booking) return res.status(403).json({ message: 'Only customers with completed booking can review' });
  const existing = await prisma.review.findUnique({ where: { bookingId: booking.id } });
  if (existing) return res.status(409).json({ message: 'Review already submitted for this booking' });

  const review = await prisma.review.create({
    data: {
      bookingId: booking.id,
      customerId: req.auth!.userId,
      workerId: worker.id,
      rating: parsed.data.rating,
      comment: parsed.data.comment.trim(),
      photoUrl: parsed.data.photoUrl ?? '',
      tags: parsed.data.tags ?? []
    } as any
  });

  const ratingStats = await prisma.review.aggregate({
    where: { workerId: worker.id },
    _avg: { rating: true },
    _count: { rating: true }
  });
  await prisma.workerProfile.updateMany({
    where: { userId: worker.id },
    data: { rating: Number(ratingStats._avg.rating ?? 0), totalJobs: Number(ratingStats._count.rating ?? 0) }
  });

  return res.status(201).json({
    review: {
      id: review.id,
      workerId: worker.id,
      rating: review.rating,
      comment: review.comment,
      createdAt: new Date(review.createdAt).toISOString()
    }
  });
});

router.post('/:id/favorite', requireAuth, requireRole('customer'), async (req: AuthRequest, res) => {
  const business = await (prisma as any).business.findUnique({ where: { id: req.params.id } });
  if (!business) return res.status(404).json({ message: 'Business not found' });
  await (prisma as any).favoriteBusiness.upsert({
    where: {
      customerId_businessId: {
        customerId: req.auth!.userId,
        businessId: business.id
      }
    },
    create: { customerId: req.auth!.userId, businessId: business.id },
    update: {}
  });
  return res.json({ message: 'Business added to favorites' });
});

router.delete('/:id/favorite', requireAuth, requireRole('customer'), async (req: AuthRequest, res) => {
  const business = await (prisma as any).business.findUnique({ where: { id: req.params.id } });
  if (!business) return res.status(404).json({ message: 'Business not found' });
  await (prisma as any).favoriteBusiness.deleteMany({
    where: { customerId: req.auth!.userId, businessId: business.id }
  });
  return res.json({ message: 'Business removed from favorites' });
});

router.post('/:id/enquiry', async (req: AuthRequest, res) => {
  const parsed = enquirySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid enquiry payload', errors: parsed.error.flatten() });
  }
  const business = await (prisma as any).business.findUnique({ where: { id: req.params.id } });
  if (!business) return res.status(404).json({ message: 'Business not found' });

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const monthlyLimit =
    business.subscriptionPlan === 'starter'
      ? 10
      : business.subscriptionPlan === 'growth'
        ? 20
        : business.subscriptionPlan === 'pro'
          ? 999999
          : 10;
  const usedThisMonth = await (prisma as any).enquiry.count({
    where: { businessId: business.id, createdAt: { gte: monthStart } }
  });
  if (usedThisMonth >= monthlyLimit) {
    return res.status(403).json({
      message:
        business.subscriptionPlan === 'pro'
          ? 'Enquiry temporarily unavailable. Please retry.'
          : 'Monthly enquiry limit reached for this provider plan'
    });
  }

  const enquiry = await (prisma as any).enquiry.create({
    data: {
      businessId: business.id,
      customerId: req.auth?.userId ?? null,
      name: parsed.data.name.trim(),
      mobile: parsed.data.mobile,
      message: parsed.data.message.trim(),
      status: 'open'
    }
  });
  await createAnalyticsEvent(business.id, 'enquiry_submit', req.auth?.userId);

  return res.status(201).json({
    enquiry: {
      id: enquiry.id,
      businessId: enquiry.businessId,
      status: enquiry.status,
      createdAt: new Date(enquiry.createdAt).toISOString()
    }
  });
});

export default router;

