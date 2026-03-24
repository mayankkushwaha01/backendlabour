import { Router } from 'express';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { requireAuth, type AuthRequest } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/role.js';
import { prisma } from '../../config/db.js';
import { env } from '../../config/env.js';
import type { UserRole } from '../../types/domain.js';
import { emitWorkersUpdated } from '../../realtime.js';

const router = Router();

const dataUrlImageRegex = /^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/;
const MAX_DATA_URL_CHARS = 350000;
const MAX_URL_CHARS = 2048;

const compactList = (items: string[], maxItems: number, maxLen: number) =>
  Array.from(
    new Set(
      items
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => item.slice(0, maxLen))
    )
  ).slice(0, maxItems);

const profileSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  phone: z.string().min(8).max(20).optional(),
  aadhaarNumber: z.string().min(12).max(20).optional(),
  aadhaarCardUrl: z.string().url().or(z.string().regex(dataUrlImageRegex)).or(z.literal('')).optional(),
  photoUrl: z.string().url().or(z.string().regex(dataUrlImageRegex)).or(z.literal('')).optional(),
  profilePhotoUrl: z.string().url().or(z.string().regex(dataUrlImageRegex)).or(z.literal('')).optional(),
  location: z.string().max(160).optional(),
  skills: z.array(z.string().max(50)).max(15).optional(),
  serviceAreas: z.array(z.string().max(80)).max(15).optional(),
  portfolioUrls: z.array(z.string().url().or(z.string().regex(dataUrlImageRegex))).max(5).optional(),
  portfolioVideoUrls: z.array(z.string().url()).max(5).optional(),
  certifications: z.array(z.string().max(120)).max(10).optional(),
  responseTimeMins: z.number().int().min(1).max(1440).optional(),
  workingHours: z.string().max(120).optional(),
  priceFrom: z.number().min(0).optional(),
  priceTo: z.number().min(0).optional(),
  experienceYears: z.number().int().min(0).optional(),
  bio: z.string().max(320).optional(),
  pricePerHour: z.number().min(0).optional()
});

const dutySchema = z.object({
  isOnDuty: z.boolean(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional()
});

const maskAadhaar = (value: string) => {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 4) return '';
  return `XXXX-XXXX-${digits.slice(-4)}`;
};

const customerProfileSchema = z.object({
  name: z.string().min(2).optional(),
  phone: z.string().min(8).optional(),
  city: z.string().max(120).optional(),
  address: z.string().max(280).optional(),
  profilePhotoUrl: z.string().url().or(z.string().regex(dataUrlImageRegex)).or(z.literal('')).optional()
});
const customerAddressSchema = z.object({
  id: z.string().min(1).max(80),
  type: z.enum(['Home', 'Office', 'Other']),
  name: z.string().min(1).max(120),
  full: z.string().min(1).max(400),
  phone: z.string().min(8).max(20),
  isDefault: z.boolean().optional()
});
const customerAddressesSchema = z.object({
  addresses: z.array(customerAddressSchema).max(20)
});
const cartItemSchema = z.object({
  serviceId: z.string().min(1).max(80),
  name: z.string().min(1).max(160),
  category: z.string().min(1).max(80),
  price: z.number().min(0),
  quantity: z.number().int().min(1).max(20),
  emoji: z.string().max(10),
  description: z.string().max(280).optional()
});
const cartDraftSchema = z.object({
  items: z.array(cartItemSchema).max(50),
  promoCode: z.string().max(40).optional().default('')
});
const switchModeSchema = z.object({
  targetRole: z.enum(['customer', 'worker'])
});

router.get('/me', requireAuth, async (req: AuthRequest, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.auth!.userId },
    include: { workerProfile: true }
  });
  if (!user) return res.status(404).json({ message: 'User not found' });

  const profile: any = user.workerProfile ?? null;

  return res.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      profilePhotoUrl: user.profilePhotoUrl,
      city: user.city,
      address: user.address,
      role: user.role,
      isApproved: user.isApproved,
      isVerifiedPlus: Boolean((user as any).isVerifiedPlus)
    },
    profile: profile
      ? {
          id: profile.id,
          userId: profile.userId,
          photoUrl: profile.photoUrl,
          location: profile.location ?? '',
          isOnDuty: profile.isOnDuty,
          liveLat: typeof profile.liveLat === 'number' ? profile.liveLat : null,
          liveLng: typeof profile.liveLng === 'number' ? profile.liveLng : null,
          liveUpdatedAt: profile.liveUpdatedAt ? new Date(profile.liveUpdatedAt).toISOString() : null,
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
          aadhaarNumberMasked: profile.aadhaarNumberMasked ?? '',
          aadhaarCardUrl: profile.aadhaarCardUrl ?? '',
          pricePerHour: profile.pricePerHour,
          rating: profile.rating,
          totalJobs: profile.totalJobs
        }
      : null
  });
});

router.post('/switch-mode', requireAuth, async (req: AuthRequest, res) => {
  const parsed = switchModeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid switch payload', errors: parsed.error.flatten() });
  }

  const targetRole = parsed.data.targetRole as UserRole;
  const current = await prisma.user.findUnique({
    where: { id: req.auth!.userId },
    include: { workerProfile: true }
  });
  if (!current) return res.status(404).json({ message: 'User not found' });

  if (current.role !== targetRole) {
    await prisma.user.update({
      where: { id: current.id },
      data: {
        role: targetRole,
        isApproved: targetRole === 'customer' ? true : current.isApproved
      }
    });
  }

  const freshUser = await prisma.user.findUnique({ where: { id: current.id } });
  if (!freshUser) return res.status(404).json({ message: 'User not found' });

  const token = jwt.sign({ sub: freshUser.id, role: freshUser.role }, env.jwtSecret, { expiresIn: '7d' });
  return res.json({
    token,
    user: {
      id: freshUser.id,
      name: freshUser.name,
      role: freshUser.role,
      email: freshUser.email,
      profilePhotoUrl: freshUser.profilePhotoUrl
    }
  });
});

router.patch('/customer/profile', requireAuth, requireRole('customer'), async (req: AuthRequest, res) => {
  const parsed = customerProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid profile payload', errors: parsed.error.flatten() });
  }

  const data = parsed.data;
  if (data.profilePhotoUrl?.startsWith('data:image/') && data.profilePhotoUrl.length > MAX_DATA_URL_CHARS) {
    return res.status(400).json({ message: 'Image is too large. Please upload a smaller image.' });
  }
  if (data.profilePhotoUrl && data.profilePhotoUrl.length > MAX_URL_CHARS) {
    return res.status(400).json({ message: 'URL is too long.' });
  }
  if (data.phone) {
    const digits = data.phone.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 15) {
      return res.status(400).json({ message: 'Invalid phone number format' });
    }
  }

  try {
    const user = await prisma.user.update({
      where: { id: req.auth!.userId },
      data: {
        ...(data.name !== undefined ? { name: data.name.trim().slice(0, 120) } : {}),
        ...(data.phone !== undefined ? { phone: data.phone.replace(/\D/g, '') } : {}),
        ...(data.city !== undefined ? { city: data.city.trim().slice(0, 120) } : {}),
        ...(data.address !== undefined ? { address: data.address.trim().slice(0, 280) } : {}),
        ...(data.profilePhotoUrl !== undefined ? { profilePhotoUrl: data.profilePhotoUrl } : {})
      }
    });

    return res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        profilePhotoUrl: user.profilePhotoUrl,
        city: user.city,
        address: user.address,
        role: user.role,
        isApproved: user.isApproved,
        isVerifiedPlus: Boolean((user as any).isVerifiedPlus)
      }
    });
  } catch (error: any) {
    if (error?.code === 'P2002') {
      return res.status(409).json({ message: 'Phone number already in use' });
    }
    return res.status(500).json({ message: 'Failed to update customer profile' });
  }
});

router.get('/customer/addresses', requireAuth, requireRole('customer'), async (req: AuthRequest, res) => {
  const book = await (prisma as any).customerAddressBook.findUnique({
    where: { userId: req.auth!.userId }
  });

  return res.json({
    addresses: Array.isArray(book?.addresses) ? (book.addresses as unknown[]) : []
  });
});

router.put('/customer/addresses', requireAuth, requireRole('customer'), async (req: AuthRequest, res) => {
  const parsed = customerAddressesSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid addresses payload', errors: parsed.error.flatten() });
  }

  const addresses = parsed.data.addresses.map((address, index) => ({
    ...address,
    phone: address.phone.replace(/\D/g, '').slice(-10),
    isDefault: index === 0 ? true : Boolean(address.isDefault)
  }));

  await (prisma as any).customerAddressBook.upsert({
    where: { userId: req.auth!.userId },
    update: { addresses },
    create: {
      userId: req.auth!.userId,
      addresses
    }
  });

  const primary = addresses.find((item) => item.isDefault) ?? addresses[0];
  if (primary) {
    const cityLine = primary.full.split('\n').pop() ?? primary.full;
    await prisma.user.update({
      where: { id: req.auth!.userId },
      data: {
        address: primary.full.slice(0, 280),
        city: cityLine.slice(0, 120)
      }
    });
  }

  return res.json({ addresses });
});

router.get('/cart', requireAuth, async (req: AuthRequest, res) => {
  const draft = await (prisma as any).cartDraft.findUnique({
    where: { userId: req.auth!.userId }
  });

  return res.json({
    items: Array.isArray(draft?.items) ? (draft.items as unknown[]) : [],
    promoCode: draft?.promoCode ?? ''
  });
});

router.put('/cart', requireAuth, async (req: AuthRequest, res) => {
  const parsed = cartDraftSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid cart payload', errors: parsed.error.flatten() });
  }

  await (prisma as any).cartDraft.upsert({
    where: { userId: req.auth!.userId },
    update: {
      items: parsed.data.items,
      promoCode: parsed.data.promoCode || ''
    },
    create: {
      userId: req.auth!.userId,
      items: parsed.data.items,
      promoCode: parsed.data.promoCode || ''
    }
  });

  return res.json({
    items: parsed.data.items,
    promoCode: parsed.data.promoCode || ''
  });
});

router.patch('/worker/profile', requireAuth, async (req: AuthRequest, res) => {
  try {
    const parsed = profileSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: 'Invalid profile payload', errors: parsed.error.flatten() });
    }
    const existingProfile = await prisma.workerProfile.findUnique({
      where: { userId: req.auth!.userId }
    });
    const existingUser = await prisma.user.findUnique({
      where: { id: req.auth!.userId },
      select: { name: true, phone: true, profilePhotoUrl: true, role: true, isApproved: true }
    });

    const hasOversizedDataUrl = (value?: string) => Boolean(value && value.startsWith('data:image/') && value.length > MAX_DATA_URL_CHARS);
    const hasOversizedUrl = (value?: string) => Boolean(value && !value.startsWith('data:image/') && value.length > MAX_URL_CHARS);
    if (
      hasOversizedDataUrl(parsed.data.photoUrl) ||
      hasOversizedDataUrl(parsed.data.profilePhotoUrl) ||
      (parsed.data.portfolioUrls ?? []).some((url) => hasOversizedDataUrl(url))
    ) {
      return res.status(400).json({ message: 'Image is too large. Please upload a smaller image.' });
    }
    if (
      hasOversizedUrl(parsed.data.photoUrl) ||
      hasOversizedUrl(parsed.data.profilePhotoUrl) ||
      (parsed.data.portfolioUrls ?? []).some((url) => hasOversizedUrl(url)) ||
      (parsed.data.portfolioVideoUrls ?? []).some((url) => hasOversizedUrl(url))
    ) {
      return res.status(400).json({ message: 'URL is too long.' });
    }

    const { profilePhotoUrl, name, phone, aadhaarNumber, aadhaarCardUrl, ...workerProfileData } = parsed.data;
    if (
      workerProfileData.priceFrom !== undefined &&
      workerProfileData.priceTo !== undefined &&
      workerProfileData.priceFrom > workerProfileData.priceTo
    ) {
      return res.status(400).json({ message: 'priceFrom cannot be greater than priceTo' });
    }
    const normalizedWorkerProfileData = {
      ...workerProfileData,
      ...(workerProfileData.location !== undefined ? { location: workerProfileData.location.trim().slice(0, 160) } : {}),
      ...(workerProfileData.bio !== undefined ? { bio: workerProfileData.bio.trim().slice(0, 320) } : {}),
      ...(workerProfileData.workingHours !== undefined ? { workingHours: workerProfileData.workingHours.trim().slice(0, 120) } : {}),
      ...(workerProfileData.skills ? { skills: compactList(workerProfileData.skills, 15, 50) } : {}),
      ...(workerProfileData.serviceAreas ? { serviceAreas: compactList(workerProfileData.serviceAreas, 15, 80) } : {}),
      ...(workerProfileData.portfolioUrls ? { portfolioUrls: compactList(workerProfileData.portfolioUrls, 5, MAX_URL_CHARS) } : {}),
      ...(workerProfileData.portfolioVideoUrls ? { portfolioVideoUrls: compactList(workerProfileData.portfolioVideoUrls, 5, MAX_URL_CHARS) } : {}),
      ...(workerProfileData.certifications ? { certifications: compactList(workerProfileData.certifications, 10, 120) } : {})
    };

    if (profilePhotoUrl !== undefined) {
      await prisma.user.update({
        where: { id: req.auth!.userId },
        data: { profilePhotoUrl }
      });
    }

    if (name !== undefined) {
      await prisma.user.update({
        where: { id: req.auth!.userId },
        data: { name: name.trim() }
      });
    }

    if (phone !== undefined) {
      const digits = phone.replace(/\D/g, '');
      if (digits.length < 10 || digits.length > 15) {
        return res.status(400).json({ message: 'Invalid phone number format' });
      }
      try {
        await prisma.user.update({
          where: { id: req.auth!.userId },
          data: { phone: digits }
        });
      } catch (error: any) {
        if (error?.code === 'P2002') {
          return res.status(409).json({ message: 'Phone number already in use' });
        }
        throw error;
      }
    }

    if (aadhaarNumber !== undefined) {
      const digits = aadhaarNumber.replace(/\D/g, '');
      if (digits.length !== 12) {
        return res.status(400).json({ message: 'Aadhaar number must be exactly 12 digits' });
      }
    }

    if (aadhaarCardUrl !== undefined) {
      if (aadhaarCardUrl.startsWith('data:image/') && aadhaarCardUrl.length > MAX_DATA_URL_CHARS) {
        return res.status(400).json({ message: 'Aadhaar image is too large. Please upload a smaller image.' });
      }
      if (!aadhaarCardUrl.startsWith('data:image/') && aadhaarCardUrl.length > MAX_URL_CHARS) {
        return res.status(400).json({ message: 'Aadhaar image URL is too long.' });
      }
    }

    const effectiveName = name ?? existingUser?.name ?? '';
    const effectivePhone = phone ?? existingUser?.phone ?? '';
    const effectiveProfilePhotoUrl = profilePhotoUrl ?? existingUser?.profilePhotoUrl ?? '';
    const effectivePhotoUrl = workerProfileData.photoUrl ?? existingProfile?.photoUrl ?? effectiveProfilePhotoUrl;
    const effectiveLocation = workerProfileData.location ?? existingProfile?.location ?? '';
    const effectiveSkills = workerProfileData.skills ?? (Array.isArray(existingProfile?.skills) ? existingProfile?.skills : []);
    const effectiveServiceAreas =
      workerProfileData.serviceAreas ?? (Array.isArray(existingProfile?.serviceAreas) ? existingProfile?.serviceAreas : []);
    const effectiveExperienceYears = workerProfileData.experienceYears ?? existingProfile?.experienceYears;
    const effectivePriceFrom = workerProfileData.priceFrom ?? existingProfile?.priceFrom;
    const effectivePriceTo = workerProfileData.priceTo ?? existingProfile?.priceTo;
    const effectiveWorkingHours = workerProfileData.workingHours ?? existingProfile?.workingHours ?? '';
    const effectiveBio = workerProfileData.bio ?? existingProfile?.bio ?? '';
    const effectiveAadhaarCardUrl = aadhaarCardUrl ?? existingProfile?.aadhaarCardUrl ?? '';
    const hasAadhaar = Boolean(aadhaarNumber) || Boolean(existingProfile?.aadhaarNumberMasked);

    const mandatoryErrors: string[] = [];
    if (!effectiveName || !effectiveName.trim()) mandatoryErrors.push('name');
    if (!effectivePhone || effectivePhone.replace(/\D/g, '').length !== 10) mandatoryErrors.push('phone');
    if (!effectiveProfilePhotoUrl || !effectiveProfilePhotoUrl.trim()) mandatoryErrors.push('profilePhotoUrl');
    if (!effectiveLocation || !String(effectiveLocation).trim()) mandatoryErrors.push('location');
    if (!effectiveSkills || effectiveSkills.length === 0) mandatoryErrors.push('skills');
    if (!effectiveServiceAreas || effectiveServiceAreas.length === 0) mandatoryErrors.push('serviceAreas');
    if (effectiveExperienceYears === undefined || effectiveExperienceYears < 0) mandatoryErrors.push('experienceYears');
    if (effectivePriceFrom === undefined || effectivePriceFrom <= 0) mandatoryErrors.push('priceFrom');
    if (effectivePriceTo === undefined || effectivePriceTo <= 0) mandatoryErrors.push('priceTo');
    if (!hasAadhaar) mandatoryErrors.push('aadhaarNumber');
    if (!effectiveAadhaarCardUrl || !String(effectiveAadhaarCardUrl).trim()) mandatoryErrors.push('aadhaarCardUrl');
    if (mandatoryErrors.length > 0) {
      return res.status(400).json({
        message: `Complete all mandatory worker profile fields before saving: ${mandatoryErrors.join(', ')}`
      });
    }

    const profile = await prisma.workerProfile.upsert({
      where: { userId: req.auth!.userId },
      update: {
        ...(aadhaarNumber !== undefined ? { aadhaarNumberMasked: maskAadhaar(aadhaarNumber) } : {}),
        ...(aadhaarCardUrl !== undefined ? { aadhaarCardUrl } : {}),
        ...(workerProfileData.photoUrl === undefined ? { photoUrl: effectivePhotoUrl } : {}),
        ...(workerProfileData.workingHours === undefined ? { workingHours: effectiveWorkingHours } : {}),
        ...(workerProfileData.bio === undefined ? { bio: effectiveBio } : {}),
        ...normalizedWorkerProfileData
      },
      create: {
        userId: req.auth!.userId,
        skills: Array.isArray((normalizedWorkerProfileData as any).skills) ? (normalizedWorkerProfileData as any).skills : [],
        photoUrl: effectivePhotoUrl,
        workingHours: effectiveWorkingHours,
        bio: effectiveBio,
        ...(aadhaarNumber !== undefined ? { aadhaarNumberMasked: maskAadhaar(aadhaarNumber) } : {}),
        ...(aadhaarCardUrl !== undefined ? { aadhaarCardUrl } : {}),
        ...normalizedWorkerProfileData
      } as any
    });

    if (!profile) return res.status(404).json({ message: 'Worker profile not found' });

    if (!existingProfile || existingUser?.role !== 'worker' || !existingUser?.isApproved) {
      await prisma.user.update({
        where: { id: req.auth!.userId },
        data: { isApproved: false }
      });
    }

    const p: any = profile;

    return res.json({
      profile: {
        id: p.id,
        userId: p.userId,
        photoUrl: p.photoUrl,
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
        experienceYears: p.experienceYears,
        bio: p.bio,
        aadhaarNumberMasked: p.aadhaarNumberMasked ?? '',
        aadhaarCardUrl: p.aadhaarCardUrl ?? '',
        pricePerHour: p.pricePerHour,
        rating: p.rating,
        totalJobs: p.totalJobs
      }
    });
  } catch (error: any) {
    const message = String(error?.message ?? '');
    if (
      message.includes('Unknown argument') ||
      message.includes('Unknown field') ||
      message.includes('column') ||
      message.includes('does not exist')
    ) {
      return res.status(500).json({ message: 'Worker profile schema not migrated yet. Railway par prisma db push chahiye.' });
    }
    return res.status(500).json({ message: 'Failed to save worker profile' });
  }
});

router.patch('/worker/duty', requireAuth, async (req: AuthRequest, res) => {
  const parsed = dutySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid duty payload', errors: parsed.error.flatten() });
  }

  try {
    const profile = await prisma.workerProfile.upsert({
      where: { userId: req.auth!.userId },
      update: {
        isOnDuty: parsed.data.isOnDuty,
        ...(parsed.data.lat !== undefined ? { liveLat: parsed.data.lat } : {}),
        ...(parsed.data.lng !== undefined ? { liveLng: parsed.data.lng } : {}),
        ...(parsed.data.lat !== undefined || parsed.data.lng !== undefined ? { liveUpdatedAt: new Date() } : {})
      },
      create: {
        userId: req.auth!.userId,
        isOnDuty: parsed.data.isOnDuty,
        ...(parsed.data.lat !== undefined ? { liveLat: parsed.data.lat } : {}),
        ...(parsed.data.lng !== undefined ? { liveLng: parsed.data.lng } : {}),
        ...(parsed.data.lat !== undefined || parsed.data.lng !== undefined ? { liveUpdatedAt: new Date() } : {}),
        skills: []
      } as any
    });

    emitWorkersUpdated();

    return res.json({
      profile: {
        id: profile.id,
        userId: profile.userId,
        isOnDuty: profile.isOnDuty,
        liveLat: typeof (profile as any).liveLat === 'number' ? (profile as any).liveLat : null,
        liveLng: typeof (profile as any).liveLng === 'number' ? (profile as any).liveLng : null,
        liveUpdatedAt: (profile as any).liveUpdatedAt ? new Date((profile as any).liveUpdatedAt).toISOString() : null
      }
    });
  } catch (error: any) {
    const message = String(error?.message ?? '');
    if (message.includes('Unknown argument `isOnDuty`') || message.includes('Unknown field `isOnDuty`')) {
      return res.status(500).json({ message: 'Duty feature is not migrated yet. Run prisma generate + prisma db push.' });
    }
    return res.status(500).json({ message: 'Failed to update duty status' });
  }
});

router.get('/worker/earnings', requireAuth, requireRole('worker'), async (req: AuthRequest, res) => {
  const completed = await prisma.booking.findMany({
    where: { workerId: req.auth!.userId, status: 'completed' }
  });
  const gross = completed.reduce((sum, b: any) => {
    const amount = typeof b.packagePrice === 'number' && b.packagePrice > 0 ? b.packagePrice : b.totalAmount;
    return sum + amount;
  }, 0);
  const commission = Math.round(gross * 0.1);
  const net = gross - commission;

  return res.json({
    summary: {
      completedJobs: completed.length,
      gross,
      commission,
      net
    },
    bookings: completed.map((b: any) => {
      const amount = typeof b.packagePrice === 'number' && b.packagePrice > 0 ? b.packagePrice : b.totalAmount;
      return {
      id: b.id,
      customerId: b.customerId,
      workerId: b.workerId,
      serviceId: b.serviceId,
      address: b.address,
      dateTime: new Date(b.dateTime).toISOString(),
      hours: b.hours,
      totalAmount: amount,
      packageTitle: b.packageTitle ?? '',
      packageDescription: b.packageDescription ?? '',
      packagePrice: typeof b.packagePrice === 'number' ? b.packagePrice : null,
      paymentMethod: b.paymentMethod,
      paymentStatus: b.paymentStatus,
      status: b.status,
      createdAt: new Date(b.createdAt).toISOString()
    };
    })
  });
});

router.get('/worker/reviews', requireAuth, requireRole('worker'), async (req: AuthRequest, res) => {
  const reviews = await prisma.review.findMany({
    where: { workerId: req.auth!.userId },
    orderBy: { createdAt: 'desc' }
  });
  const customerIds = [...new Set(reviews.map((r) => r.customerId))];
  const customers = await prisma.user.findMany({ where: { id: { in: customerIds } } });
  const customerMap = new Map(customers.map((c) => [c.id, c.name]));

  return res.json({
    reviews: reviews.map((r) => {
      const review: any = r;
      return {
        id: r.id,
        bookingId: r.bookingId,
        customerId: r.customerId,
        customerName: customerMap.get(r.customerId) ?? 'Customer',
        rating: r.rating,
        comment: r.comment,
        photoUrl: review.photoUrl ?? '',
        tags: Array.isArray(review.tags) ? (review.tags as string[]) : [],
        createdAt: new Date(r.createdAt).toISOString()
      };
    })
  });
});

router.get('/me/favorites', requireAuth, requireRole('customer'), async (req: AuthRequest, res) => {
  return res.json({ favorites: [] });
});

export default router;
