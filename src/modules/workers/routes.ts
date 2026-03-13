import { Router } from 'express';
import { prisma } from '../../config/db.js';

const router = Router();

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

export default router;

