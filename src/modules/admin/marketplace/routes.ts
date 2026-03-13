import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../../config/db.js';
import { requireAuth } from '../../../middleware/auth.js';
import { requireRole } from '../../../middleware/role.js';

const router = Router();

const categorySchema = z.object({
  name: z.string().min(2).max(80),
  slug: z.string().min(2).max(80),
  icon: z.string().max(120).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional()
});

const categoryPatchSchema = categorySchema.partial();

const vendorSubscriptionSchema = z.object({
  listingType: z.enum(['free', 'promoted']).optional(),
  subscriptionPlan: z.enum(['none', 'starter', 'growth', 'pro']).optional(),
  subscriptionEndsAt: z.string().datetime().nullable().optional()
});

const parsePhoneLine = (line: string) => {
  const clean = line.replace(/\s+/g, ' ').trim();
  const match = clean.match(/^(\+\d{1,4})\s*(.*)$/);
  if (match) {
    return {
      countryCode: match[1],
      number: match[2].replace(/\D/g, '')
    };
  }
  return { countryCode: '+91', number: clean.replace(/\D/g, '') };
};

const parseDescriptionFields = (raw = '') => {
  const lines = raw
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);

  const descLines: string[] = [];
  let contact = { countryCode: '+91', number: '' };
  let whatsapp = { countryCode: '+91', number: '' };
  const timings: Array<{ day: string; start: string; end: string }> = [];

  for (const line of lines) {
    if (/^contact:/i.test(line)) {
      contact = parsePhoneLine(line.replace(/^contact:/i, ''));
      continue;
    }
    if (/^whatsapp:/i.test(line)) {
      whatsapp = parsePhoneLine(line.replace(/^whatsapp:/i, ''));
      continue;
    }
    if (/^timing:/i.test(line)) {
      const timingRaw = line.replace(/^timing:/i, '').trim();
      const slots = timingRaw.split('|').map((item) => item.trim()).filter(Boolean);
      for (const slot of slots) {
        const firstSpace = slot.indexOf(' ');
        if (firstSpace <= 0) continue;
        const day = slot.slice(0, firstSpace).trim();
        const [start, end] = slot.slice(firstSpace + 1).trim().split('-').map((item) => item.trim());
        if (day && start && end) timings.push({ day, start, end });
      }
      continue;
    }
    descLines.push(line);
  }

  return {
    bio: descLines.join('\n'),
    contact,
    whatsapp,
    timings
  };
};

const parseAddressFields = (rawAddress = '', rawLocationText = '', fallbackCity = '') => {
  const parts = rawAddress
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const pinPart = parts.find((item) => /^pin\s*/i.test(item));
  const pincode = pinPart ? pinPart.replace(/^pin\s*/i, '').replace(/\D/g, '') : '';
  const withoutPin = parts.filter((item) => !/^pin\s*/i.test(item));

  if (withoutPin.length >= 7) {
    return {
      plotNo: withoutPin[0] ?? '',
      street: withoutPin[1] ?? '',
      address: withoutPin[2] ?? '',
      landmark: withoutPin[3] ?? '',
      area: withoutPin[4] ?? '',
      city: withoutPin[5] || fallbackCity || '',
      stateName: withoutPin[6] ?? '',
      pincode
    };
  }

  const locParts = rawLocationText
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  return {
    plotNo: '',
    street: '',
    address: rawAddress,
    landmark: locParts[1] ?? '',
    area: locParts[0] ?? '',
    city: fallbackCity || locParts[2] || '',
    stateName: locParts[3] || '',
    pincode: pincode || (locParts[4] ?? '').replace(/\D/g, '')
  };
};

router.get('/vendors/pending', requireAuth, requireRole('admin'), async (_req, res) => {
  const vendors = await (prisma as any).business.findMany({
    where: { isApproved: false },
    include: {
      vendor: { select: { id: true, name: true, email: true, phone: true, createdAt: true } },
      category: true,
      photos: { orderBy: { sortOrder: 'asc' } },
      services: { where: { isActive: true }, orderBy: { createdAt: 'asc' } }
    },
    orderBy: { createdAt: 'desc' }
  });

  return res.json({
    pendingVendors: vendors.map((business: any) => {
      const desc = parseDescriptionFields(business.description ?? '');
      const addr = parseAddressFields(business.address ?? '', business.locationText ?? '', business.city ?? '');
      return {
        vendorUserId: business.vendorUserId,
        businessId: business.id,
        name: business.name,
        category: business.category?.name ?? '',
        city: business.city,
        createdAt: new Date(business.createdAt).toISOString(),
        vendor: {
          id: business.vendor.id,
          name: business.vendor.name,
          email: business.vendor.email,
          phone: business.vendor.phone,
          joinedAt: new Date(business.vendor.createdAt).toISOString()
        },
        approvalData: {
          step1BusinessDetails: {
            businessName: business.name,
            pincode: addr.pincode,
            address: addr.address,
            plotNo: addr.plotNo,
            street: addr.street,
            landmark: addr.landmark,
            area: addr.area,
            city: addr.city,
            state: addr.stateName
          },
          step2ContactDetails: {
            countryCode: desc.contact.countryCode,
            contactNumber: desc.contact.number,
            whatsappCountryCode: desc.whatsapp.countryCode,
            whatsappNumber: desc.whatsapp.number
          },
          step3BusinessTiming: desc.timings,
          step4Category: {
            categoryId: business.categoryId,
            categoryName: business.category?.name ?? '',
            categorySlug: business.category?.slug ?? '',
            listedServices: (business.services ?? []).map((service: any) => service.title)
          },
          step5Photos: {
            coverPhotoUrl: business.coverPhotoUrl || '',
            gallery: (business.photos ?? []).map((photo: any) => ({
              id: photo.id,
              url: photo.url,
              caption: photo.caption ?? '',
              sortOrder: photo.sortOrder ?? 0
            }))
          },
          profileBio: desc.bio
        }
      };
    })
  });
});

router.post('/vendors/:id/approve', requireAuth, requireRole('admin'), async (req, res) => {
  const vendor = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!vendor) return res.status(404).json({ message: 'Vendor not found' });
  const vendorBusinessCount = await (prisma as any).business.count({ where: { vendorUserId: vendor.id } });
  if (vendorBusinessCount === 0) return res.status(404).json({ message: 'Vendor business not found' });

  await (prisma as any).$transaction([
    (prisma as any).user.update({
      where: { id: vendor.id },
      data: { isApproved: true }
    }),
    (prisma as any).business.updateMany({
      where: { vendorUserId: vendor.id },
      data: { isApproved: true }
    })
  ]);

  return res.json({ message: 'Vendor approved' });
});

router.post('/vendors/:id/reject', requireAuth, requireRole('admin'), async (req, res) => {
  const vendor = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!vendor) return res.status(404).json({ message: 'Vendor not found' });
  const vendorBusinessCount = await (prisma as any).business.count({ where: { vendorUserId: vendor.id } });
  if (vendorBusinessCount === 0) return res.status(404).json({ message: 'Vendor business not found' });

  await (prisma as any).$transaction([
    (prisma as any).user.update({
      where: { id: vendor.id },
      data: { isApproved: false }
    }),
    (prisma as any).business.updateMany({
      where: { vendorUserId: vendor.id },
      data: { isApproved: false }
    })
  ]);

  return res.json({ message: 'Vendor rejected' });
});

router.get('/categories', requireAuth, requireRole('admin'), async (_req, res) => {
  const categories = await (prisma as any).category.findMany({
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }]
  });
  return res.json({
    categories: categories.map((category: any) => ({
      id: category.id,
      name: category.name,
      slug: category.slug,
      icon: category.icon,
      isActive: Boolean(category.isActive),
      sortOrder: category.sortOrder
    }))
  });
});

router.post('/categories', requireAuth, requireRole('admin'), async (req, res) => {
  const parsed = categorySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid category payload', errors: parsed.error.flatten() });
  }

  const category = await (prisma as any).category.create({
    data: {
      name: parsed.data.name.trim(),
      slug: parsed.data.slug.trim().toLowerCase(),
      icon: parsed.data.icon ?? '',
      isActive: parsed.data.isActive ?? true,
      sortOrder: parsed.data.sortOrder ?? 0
    }
  });

  return res.status(201).json({
    category: {
      id: category.id,
      name: category.name,
      slug: category.slug,
      icon: category.icon,
      isActive: category.isActive,
      sortOrder: category.sortOrder
    }
  });
});

router.patch('/categories/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const parsed = categoryPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid category payload', errors: parsed.error.flatten() });
  }

  const existing = await (prisma as any).category.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ message: 'Category not found' });

  const category = await (prisma as any).category.update({
    where: { id: existing.id },
    data: {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name.trim() } : {}),
      ...(parsed.data.slug !== undefined ? { slug: parsed.data.slug.trim().toLowerCase() } : {}),
      ...(parsed.data.icon !== undefined ? { icon: parsed.data.icon } : {}),
      ...(parsed.data.isActive !== undefined ? { isActive: parsed.data.isActive } : {}),
      ...(parsed.data.sortOrder !== undefined ? { sortOrder: parsed.data.sortOrder } : {})
    }
  });

  return res.json({
    category: {
      id: category.id,
      name: category.name,
      slug: category.slug,
      icon: category.icon,
      isActive: category.isActive,
      sortOrder: category.sortOrder
    }
  });
});

router.delete('/categories/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const existing = await (prisma as any).category.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ message: 'Category not found' });

  const linked = await (prisma as any).business.count({ where: { categoryId: existing.id } });
  if (linked > 0) {
    return res.status(400).json({ message: 'Category is in use by businesses and cannot be deleted' });
  }

  await (prisma as any).category.delete({ where: { id: existing.id } });
  return res.json({ message: 'Category deleted' });
});

router.get('/revenue/subscriptions', requireAuth, requireRole('admin'), async (_req, res) => {
  const businesses = await (prisma as any).business.findMany({
    select: { id: true, subscriptionPlan: true, subscriptionEndsAt: true, listingType: true, isApproved: true }
  });

  const planPrice: Record<string, number> = {
    none: 0,
    starter: 499,
    growth: 999,
    pro: 1999
  };

  const now = Date.now();
  const summary = businesses.reduce(
    (acc: any, business: any) => {
      const plan = String(business.subscriptionPlan ?? 'none');
      acc.totalBusinesses += 1;
      if (business.isApproved) acc.approvedBusinesses += 1;
      if (business.listingType === 'promoted') acc.promotedListings += 1;
      acc.byPlan[plan] = (acc.byPlan[plan] ?? 0) + 1;
      const endsAtMs = business.subscriptionEndsAt ? new Date(business.subscriptionEndsAt).getTime() : null;
      if (endsAtMs && endsAtMs >= now && planPrice[plan]) {
        acc.activeRevenueEstimate += planPrice[plan];
      }
      return acc;
    },
    {
      totalBusinesses: 0,
      approvedBusinesses: 0,
      promotedListings: 0,
      activeRevenueEstimate: 0,
      byPlan: { none: 0, starter: 0, growth: 0, pro: 0 } as Record<string, number>
    }
  );

  return res.json({ summary, planPrice });
});

router.patch('/vendors/:id/subscription', requireAuth, requireRole('admin'), async (req, res) => {
  const parsed = vendorSubscriptionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid subscription payload', errors: parsed.error.flatten() });
  }

  const vendor = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!vendor) return res.status(404).json({ message: 'Vendor not found' });
  const vendorBusinessCount = await (prisma as any).business.count({ where: { vendorUserId: vendor.id } });
  if (vendorBusinessCount === 0) return res.status(404).json({ message: 'Vendor business not found' });

  await (prisma as any).$transaction([
    (prisma as any).user.update({
      where: { id: vendor.id },
      data: {
        ...(parsed.data.listingType !== undefined ? { listingType: parsed.data.listingType } : {}),
        ...(parsed.data.subscriptionPlan !== undefined ? { subscriptionPlan: parsed.data.subscriptionPlan } : {}),
        ...(parsed.data.subscriptionEndsAt !== undefined
          ? { subscriptionEndsAt: parsed.data.subscriptionEndsAt ? new Date(parsed.data.subscriptionEndsAt) : null }
          : {})
      }
    }),
    (prisma as any).business.updateMany({
      where: { vendorUserId: vendor.id },
      data: {
        ...(parsed.data.listingType !== undefined ? { listingType: parsed.data.listingType } : {}),
        ...(parsed.data.subscriptionPlan !== undefined ? { subscriptionPlan: parsed.data.subscriptionPlan } : {}),
        ...(parsed.data.subscriptionEndsAt !== undefined
          ? { subscriptionEndsAt: parsed.data.subscriptionEndsAt ? new Date(parsed.data.subscriptionEndsAt) : null }
          : {})
      }
    })
  ]);

  return res.json({ message: 'Vendor subscription updated' });
});

export default router;
