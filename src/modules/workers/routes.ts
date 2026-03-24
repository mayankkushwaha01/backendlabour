import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/db.js';
import { requireAuth, type AuthRequest } from '../../middleware/auth.js';

const router = Router();

const toLower = (value: string | null | undefined) => String(value ?? '').trim().toLowerCase();

const toStringArray = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const calculateDistanceKm = (lat1: number, lng1: number, lat2: number, lng2: number) => {
  const earthRadiusKm = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusKm * c;
};

const getLocationTextScore = (worker: { location?: string; serviceAreas?: string[] }, city: string) => {
  const target = toLower(city);
  if (!target) return 0;
  const location = toLower(worker.location);
  if (location === target) return 3;
  if (location.includes(target)) return 2;
  const serviceAreaMatch = (worker.serviceAreas ?? []).some((area) => toLower(area).includes(target));
  if (serviceAreaMatch) return 1;
  return 0;
};

router.get('/', async (req, res) => {
  const { service, skill, location, sort } = req.query;

  let users: any[] = [];
  try {
    users = await prisma.user.findMany({
      where: {
        isApproved: true,
        OR: [{ role: 'worker' }, { workerProfile: { isNot: null } }]
      },
      include: { workerProfile: true }
    });
  } catch {
    users = await prisma.user.findMany({
      where: { role: 'worker', isApproved: true },
      include: { workerProfile: true }
    });
  }

  let workers = users.map((u) => {
    const profile: any = u.workerProfile;
    const skills = Array.isArray(profile?.skills)
      ? profile.skills.filter((item: unknown): item is string => typeof item === 'string')
      : [];
    return {
      id: u.id,
      name: u.name,
      isVerifiedPlus: Boolean((u as any).isVerifiedPlus),
      isTopRated: (profile?.rating ?? 0) >= 4.5,
      isPriorityBoosted: Boolean((u as any).isPriorityBoosted),
      listingType: (u as any).listingType ?? 'free',
      subscriptionPlan: (u as any).subscriptionPlan ?? 'none',
      subscriptionEndsAt: (u as any).subscriptionEndsAt ? new Date((u as any).subscriptionEndsAt).toISOString() : null,
      adCredits: Number((u as any).adCredits ?? 0),
      isComplaintFlagged: Boolean((u as any).isComplaintFlagged),
      photoUrl: profile?.photoUrl || u.profilePhotoUrl || '',
      location: profile?.location ?? '',
      isOnDuty: profile?.isOnDuty ?? true,
      skills,
      serviceAreas: Array.isArray(profile?.serviceAreas) ? (profile?.serviceAreas as string[]) : [],
      certifications: Array.isArray(profile?.certifications) ? (profile?.certifications as string[]) : [],
      responseTimeMins: profile?.responseTimeMins ?? 30,
      priceFrom: profile?.priceFrom ?? 0,
      priceTo: profile?.priceTo ?? 0,
      experienceYears: profile?.experienceYears ?? 0,
      rating: profile?.rating ?? 0,
      totalJobs: profile?.totalJobs ?? 0,
      pricePerHour: profile?.pricePerHour ?? 0
    };
  });

  if (service && typeof service === 'string') {
    workers = workers.filter((w) => w.skills.map((s: string) => s.toLowerCase()).includes(service.toLowerCase()));
  }

  if (skill && typeof skill === 'string') {
    const needed = skill.trim().toLowerCase();
    workers = workers.filter((w) => w.skills.some((s: string) => s.toLowerCase().includes(needed)));
  }

  if (location && typeof location === 'string') {
    const target = location.trim().toLowerCase();
    workers = workers.filter((w) => (w.location ?? '').toLowerCase().includes(target));
  }

  const locationScore = (worker: any) => {
    if (!location || typeof location !== 'string') return 0;
    const target = location.trim().toLowerCase();
    const value = String(worker.location ?? '').toLowerCase();
    if (!target || !value) return 0;
    if (value === target) return 3;
    if (value.startsWith(target)) return 2;
    if (value.includes(target)) return 1;
    return 0;
  };

  const byPriority = (a: any, b: any) => {
    const ratingDelta = Number(b.rating ?? 0) - Number(a.rating ?? 0);
    if (ratingDelta !== 0) return ratingDelta;
    const jobsDelta = Number(b.totalJobs ?? 0) - Number(a.totalJobs ?? 0);
    if (jobsDelta !== 0) return jobsDelta;
    const locationDelta = locationScore(b) - locationScore(a);
    if (locationDelta !== 0) return locationDelta;
    const priorityBoostDelta = Number(Boolean(b.isPriorityBoosted)) - Number(Boolean(a.isPriorityBoosted));
    if (priorityBoostDelta !== 0) return priorityBoostDelta;
    return Number(Boolean(b.isVerifiedPlus)) - Number(Boolean(a.isVerifiedPlus));
  };

  const byPriorityThenVerified = (a: any, b: any) => {
    const promotedDelta = Number(b.listingType === 'promoted') - Number(a.listingType === 'promoted');
    if (promotedDelta !== 0) return promotedDelta;
    const priorityDelta = Number(Boolean(b.isPriorityBoosted)) - Number(Boolean(a.isPriorityBoosted));
    if (priorityDelta !== 0) return priorityDelta;
    return Number(Boolean(b.isVerifiedPlus)) - Number(Boolean(a.isVerifiedPlus));
  };
  if (sort === 'rating') workers.sort((a, b) => byPriority(a, b) || b.rating - a.rating);
  if (sort === 'price') workers.sort((a, b) => byPriority(a, b) || a.pricePerHour - b.pricePerHour);
  if (sort !== 'rating' && sort !== 'price') workers.sort((a, b) => byPriority(a, b) || byPriorityThenVerified(a, b) || b.rating - a.rating);

  return res.json({ workers });
});

router.get('/top', async (req, res) => {
  const limitRaw = Number(req.query.limit ?? 5);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(5, limitRaw)) : 5;
  const lat = typeof req.query.lat === 'string' ? Number(req.query.lat) : Number.NaN;
  const lng = typeof req.query.lng === 'string' ? Number(req.query.lng) : Number.NaN;
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);
  const city = typeof req.query.city === 'string' ? req.query.city : '';

  let users: any[] = [];
  try {
    users = await prisma.user.findMany({
      where: {
        isApproved: true,
        OR: [{ role: 'worker' }, { workerProfile: { isNot: null } }]
      },
      include: { workerProfile: true }
    });
  } catch {
    users = await prisma.user.findMany({
      where: { role: 'worker', isApproved: true },
      include: { workerProfile: true }
    });
  }

  const workers = users
    .map((user) => {
      const profile: any = user.workerProfile;
      if (!profile || profile.isOnDuty === false) return null;

      const skills = toStringArray(profile.skills);
      const serviceAreas = toStringArray(profile.serviceAreas);
      const liveLat = typeof profile.liveLat === 'number' ? profile.liveLat : null;
      const liveLng = typeof profile.liveLng === 'number' ? profile.liveLng : null;
      const distanceKm = hasCoords && liveLat !== null && liveLng !== null
        ? calculateDistanceKm(lat, lng, liveLat, liveLng)
        : null;

      return {
        id: user.id,
        name: user.name,
        photoUrl: profile.photoUrl || user.profilePhotoUrl || '',
        location: profile.location ?? '',
        isOnDuty: profile.isOnDuty !== false,
        isOnline: profile.isOnDuty !== false,
        skills,
        serviceAreas,
        rating: Number(profile.rating ?? 0),
        totalJobs: Number(profile.totalJobs ?? 0),
        liveLat,
        liveLng,
        liveUpdatedAt: profile.liveUpdatedAt ? new Date(profile.liveUpdatedAt).toISOString() : null,
        distanceKm,
        locationScore: getLocationTextScore({ location: profile.location, serviceAreas }, city)
      };
    })
    .filter((worker): worker is NonNullable<typeof worker> => Boolean(worker))
    .sort((a, b) => {
      const aDistanceRank = a.distanceKm === null ? Number.POSITIVE_INFINITY : a.distanceKm;
      const bDistanceRank = b.distanceKm === null ? Number.POSITIVE_INFINITY : b.distanceKm;
      if (aDistanceRank !== bDistanceRank) return aDistanceRank - bDistanceRank;
      if (b.locationScore !== a.locationScore) return b.locationScore - a.locationScore;
      if (b.rating !== a.rating) return b.rating - a.rating;
      return b.totalJobs - a.totalJobs;
    })
    .slice(0, limit);

  return res.json({ workers });
});

router.get('/:workerId', async (req, res) => {
  const user = await prisma.user.findFirst({
    where: {
      id: req.params.workerId,
      isApproved: true,
      OR: [{ role: 'worker' }, { workerProfile: { isNot: null } }]
    },
    include: { workerProfile: true }
  });
  if (!user) {
    return res.status(404).json({ message: 'Worker not found' });
  }

  const profile: any = user.workerProfile;
  return res.json({
    worker: {
      id: user.id,
      name: user.name,
      isVerifiedPlus: Boolean((user as any).isVerifiedPlus),
      isTopRated: (profile?.rating ?? 0) >= 4.5,
      isPriorityBoosted: Boolean((user as any).isPriorityBoosted),
      listingType: (user as any).listingType ?? 'free',
      subscriptionPlan: (user as any).subscriptionPlan ?? 'none',
      subscriptionEndsAt: (user as any).subscriptionEndsAt ? new Date((user as any).subscriptionEndsAt).toISOString() : null,
      adCredits: Number((user as any).adCredits ?? 0),
      isComplaintFlagged: Boolean((user as any).isComplaintFlagged),
      profilePhotoUrl: user.profilePhotoUrl || '',
      email: user.email,
      phone: user.phone,
      approved: user.isApproved,
      profile: profile
        ? {
            id: profile.id,
            userId: profile.userId,
            photoUrl: profile.photoUrl || user.profilePhotoUrl || '',
            location: profile.location,
            isOnDuty: profile.isOnDuty,
            skills: Array.isArray(profile.skills) ? (profile.skills as string[]) : [],
            serviceAreas: Array.isArray(profile.serviceAreas) ? (profile.serviceAreas as string[]) : [],
            certifications: Array.isArray(profile.certifications) ? (profile.certifications as string[]) : [],
            portfolioUrls: Array.isArray(profile.portfolioUrls) ? (profile.portfolioUrls as string[]) : [],
            portfolioVideoUrls: Array.isArray(profile.portfolioVideoUrls) ? (profile.portfolioVideoUrls as string[]) : [],
            responseTimeMins: profile.responseTimeMins ?? 30,
            workingHours: profile.workingHours ?? '',
            priceFrom: profile.priceFrom ?? 0,
            priceTo: profile.priceTo ?? 0,
            experienceYears: profile.experienceYears,
            bio: profile.bio,
            pricePerHour: profile.pricePerHour,
            rating: profile.rating,
            totalJobs: profile.totalJobs
          }
        : null
    }
  });
});

const createWorkerSchema = z.object({
  photoUrl: z.string().url().or(z.literal('')).optional(),
  location: z.string().min(1).max(160),
  isOnDuty: z.boolean().default(true),
  skills: z.array(z.string().max(50)).min(1),
  serviceAreas: z.array(z.string().max(80)).max(15).optional(),
  portfolioUrls: z.array(z.string().url()).max(5).optional(),
  portfolioVideoUrls: z.array(z.string().url()).max(5).optional(),
  certifications: z.array(z.string().max(120)).max(10).optional(),
  responseTimeMins: z.number().int().min(1).max(1440).default(30),
  workingHours: z.string().min(1).max(120),
  priceFrom: z.number().min(0).default(0),
  priceTo: z.number().min(0).default(0),
  experienceYears: z.number().int().min(0).default(0),
  bio: z.string().min(1).max(320),
  aadhaarNumberMasked: z.string().min(1).max(20),
  aadhaarCardUrl: z.string().min(1),
  pricePerHour: z.number().min(0).default(0)
});

router.post('/', requireAuth, async (req: AuthRequest, res) => {
  const parsed = createWorkerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      message: 'Invalid worker profile payload',
      errors: parsed.error.flatten()
    });
  }

  const {
    photoUrl,
    location,
    isOnDuty,
    skills,
    serviceAreas,
    portfolioUrls,
    portfolioVideoUrls,
    certifications,
    responseTimeMins,
    workingHours,
    priceFrom,
    priceTo,
    experienceYears,
    bio,
    aadhaarNumberMasked,
    aadhaarCardUrl,
    pricePerHour
  } = parsed.data;

  const userId = req.auth!.userId;

  const existingProfile = await prisma.workerProfile.findUnique({
    where: { userId }
  });

  const profileData = {
    photoUrl: photoUrl ?? '',
    location: location.trim(),
    isOnDuty,
    skills,
    serviceAreas: serviceAreas ?? [],
    portfolioUrls: portfolioUrls ?? [],
    portfolioVideoUrls: portfolioVideoUrls ?? [],
    certifications: certifications ?? [],
    responseTimeMins,
    workingHours: workingHours.trim(),
    priceFrom,
    priceTo,
    experienceYears,
    bio: bio.trim(),
    aadhaarNumberMasked: aadhaarNumberMasked.trim(),
    aadhaarCardUrl,
    pricePerHour
  };

  const profile = await prisma.workerProfile.upsert({
    where: { userId },
    update: profileData,
    create: {
      userId,
      ...profileData
    }
  });

  // Ensure the user's role is set to 'worker'
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (user && user.role !== 'worker') {
    await prisma.user.update({
      where: { id: userId },
      data: { role: 'worker' }
    });
  }

  const p: any = profile;
  const statusCode = existingProfile ? 200 : 201;

  return res.status(statusCode).json({
    profile: {
      id: p.id,
      userId: p.userId,
      photoUrl: p.photoUrl ?? '',
      location: p.location ?? '',
      isOnDuty: p.isOnDuty,
      skills: Array.isArray(p.skills) ? (p.skills as string[]) : [],
      serviceAreas: Array.isArray(p.serviceAreas) ? (p.serviceAreas as string[]) : [],
      portfolioUrls: Array.isArray(p.portfolioUrls) ? (p.portfolioUrls as string[]) : [],
      portfolioVideoUrls: Array.isArray(p.portfolioVideoUrls) ? (p.portfolioVideoUrls as string[]) : [],
      certifications: Array.isArray(p.certifications) ? (p.certifications as string[]) : [],
      responseTimeMins: p.responseTimeMins ?? 30,
      workingHours: p.workingHours ?? '',
      priceFrom: p.priceFrom ?? 0,
      priceTo: p.priceTo ?? 0,
      experienceYears: p.experienceYears ?? 0,
      bio: p.bio ?? '',
      aadhaarNumberMasked: p.aadhaarNumberMasked ?? '',
      aadhaarCardUrl: p.aadhaarCardUrl ?? '',
      pricePerHour: p.pricePerHour ?? 0,
      rating: p.rating ?? 0,
      totalJobs: p.totalJobs ?? 0
    }
  });
});

export default router;


