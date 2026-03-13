import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/db.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/role.js';
import { cacheResponse, deleteCacheByPrefix } from '../../lib/cache.js';

const router = Router();

const upsertSchema = z.object({
  serviceKey: z.string().min(2).max(64),
  label: z.string().min(2).max(120),
  basePrice: z.number().min(0),
  isActive: z.boolean().optional()
});
const packageUpsertSchema = z.object({
  id: z.string().optional(),
  serviceKey: z.string().min(2).max(64),
  title: z.string().min(2).max(140),
  price: z.number().min(0),
  points: z.array(z.string().min(1).max(180)).optional(),
  sortOrder: z.number().int().min(0).optional(),
  isActive: z.boolean().optional()
});

const slugifyKey = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const SERVICE_KEY_ALIASES: Record<string, string[]> = {
  'ac-repair-service': ['ac-repair'],
  'home-deep-cleaning': ['cleaning'],
  'general-labour': ['labour'],
  'painting-service': ['painter'],
  'mason-work': ['mason']
};

const DEFAULT_PACKAGES: Array<{ serviceKey: string; title: string; price: number; points: string[]; sortOrder: number }> = [
  { serviceKey: 'electrician', title: 'Switch Repair', price: 299, points: ['Switch board check and repair'], sortOrder: 1 },
  { serviceKey: 'electrician', title: 'Fan Installation', price: 399, points: ['Ceiling fan fitting and test'], sortOrder: 2 },
  { serviceKey: 'electrician', title: 'Wiring Fix', price: 499, points: ['Minor wiring fault repair'], sortOrder: 3 },
  { serviceKey: 'plumber', title: 'Leak Repair', price: 299, points: ['Pipe leak detection and fix'], sortOrder: 1 },
  { serviceKey: 'plumber', title: 'Tap Installation', price: 279, points: ['New tap fitting'], sortOrder: 2 },
  { serviceKey: 'plumber', title: 'Drain Blockage', price: 349, points: ['Drain opening and clean-up'], sortOrder: 3 },
  { serviceKey: 'carpenter', title: 'Door Repair', price: 349, points: ['Hinge and alignment fix'], sortOrder: 1 },
  { serviceKey: 'carpenter', title: 'Furniture Repair', price: 449, points: ['Chair/table stability repair'], sortOrder: 2 },
  { serviceKey: 'carpenter', title: 'Bed Assembly', price: 499, points: ['Bed installation and fitting check'], sortOrder: 3 },
  { serviceKey: 'ac-repair-service', title: 'AC Inspection', price: 299, points: ['Basic AC diagnosis'], sortOrder: 1 },
  { serviceKey: 'ac-repair-service', title: 'Gas Refill', price: 999, points: ['R32/R22 gas refill'], sortOrder: 2 },
  { serviceKey: 'ac-repair-service', title: 'Jet Cleaning', price: 699, points: ['Deep AC cleaning'], sortOrder: 3 },
  { serviceKey: 'washing-machine-repair', title: 'Diagnosis Visit', price: 249, points: ['Inspection and issue report'], sortOrder: 1 },
  { serviceKey: 'washing-machine-repair', title: 'Spin Issue Fix', price: 499, points: ['Drum and belt check'], sortOrder: 2 },
  { serviceKey: 'washing-machine-repair', title: 'Drain Repair', price: 449, points: ['Drain and pump repair'], sortOrder: 3 },
  { serviceKey: 'refrigerator-repair', title: 'Cooling Issue Fix', price: 499, points: ['Cooling diagnosis and fix'], sortOrder: 1 },
  { serviceKey: 'refrigerator-repair', title: 'Gas Refill', price: 749, points: ['Refrigerant top-up'], sortOrder: 2 },
  { serviceKey: 'refrigerator-repair', title: 'Compressor Check', price: 599, points: ['Compressor health test'], sortOrder: 3 },
  { serviceKey: 'ro-repair', title: 'Filter Change', price: 299, points: ['Filter replacement and flush'], sortOrder: 1 },
  { serviceKey: 'ro-repair', title: 'RO Service', price: 399, points: ['Full RO servicing'], sortOrder: 2 },
  { serviceKey: 'ro-repair', title: 'Leak Fix', price: 279, points: ['Leakage detection and fix'], sortOrder: 3 },
  { serviceKey: 'microwave-repair', title: 'Heating Issue Fix', price: 349, points: ['Heating diagnosis and repair'], sortOrder: 1 },
  { serviceKey: 'microwave-repair', title: 'Door Switch Fix', price: 299, points: ['Door sensor repair'], sortOrder: 2 },
  { serviceKey: 'microwave-repair', title: 'Panel Repair', price: 399, points: ['Control panel check'], sortOrder: 3 },
  { serviceKey: 'tv-repair', title: 'Screen Issue', price: 399, points: ['Display issue diagnosis'], sortOrder: 1 },
  { serviceKey: 'tv-repair', title: 'Sound Issue', price: 349, points: ['Audio troubleshooting'], sortOrder: 2 },
  { serviceKey: 'tv-repair', title: 'Power Issue', price: 349, points: ['Power supply diagnosis'], sortOrder: 3 },
  { serviceKey: 'home-deep-cleaning', title: '1 BHK Deep Clean', price: 899, points: ['Complete deep clean'], sortOrder: 1 },
  { serviceKey: 'home-deep-cleaning', title: '2 BHK Deep Clean', price: 1299, points: ['Full home deep clean'], sortOrder: 2 },
  { serviceKey: 'home-deep-cleaning', title: '3 BHK Deep Clean', price: 1699, points: ['Premium deep clean'], sortOrder: 3 },
  { serviceKey: 'kitchen-cleaning', title: 'Basic Kitchen Clean', price: 399, points: ['Slab and sink cleaning'], sortOrder: 1 },
  { serviceKey: 'kitchen-cleaning', title: 'Chimney Clean', price: 599, points: ['Chimney cleaning'], sortOrder: 2 },
  { serviceKey: 'kitchen-cleaning', title: 'Deep Degrease', price: 699, points: ['Deep grease removal'], sortOrder: 3 },
  { serviceKey: 'bathroom-cleaning', title: 'Single Bathroom', price: 349, points: ['Tiles and fixtures clean'], sortOrder: 1 },
  { serviceKey: 'bathroom-cleaning', title: 'Two Bathrooms', price: 599, points: ['Full bathroom cleaning'], sortOrder: 2 },
  { serviceKey: 'bathroom-cleaning', title: 'Tile & Grout', price: 499, points: ['Deep grout scrubbing'], sortOrder: 3 },
  { serviceKey: 'sofa-cleaning', title: '3 Seater Sofa', price: 399, points: ['Basic sofa cleaning'], sortOrder: 1 },
  { serviceKey: 'sofa-cleaning', title: '5 Seater Sofa', price: 549, points: ['Deep cleaning and drying'], sortOrder: 2 },
  { serviceKey: 'sofa-cleaning', title: 'Stain Removal', price: 299, points: ['Targeted stain treatment'], sortOrder: 3 },
  { serviceKey: 'carpet-cleaning', title: 'Small Carpet', price: 349, points: ['Up to 25 sq ft'], sortOrder: 1 },
  { serviceKey: 'carpet-cleaning', title: 'Medium Carpet', price: 499, points: ['25-50 sq ft'], sortOrder: 2 },
  { serviceKey: 'carpet-cleaning', title: 'Large Carpet', price: 649, points: ['50+ sq ft'], sortOrder: 3 },
  { serviceKey: 'water-tank-cleaning', title: 'Under 1000L', price: 699, points: ['Tank cleaning and sludge removal'], sortOrder: 1 },
  { serviceKey: 'water-tank-cleaning', title: '1000-2000L', price: 899, points: ['Medium tank cleaning'], sortOrder: 2 },
  { serviceKey: 'water-tank-cleaning', title: 'Above 2000L', price: 1099, points: ['Large tank cleaning'], sortOrder: 3 },
  { serviceKey: 'painting-service', title: '1 Room Painting', price: 1499, points: ['Single room paint job'], sortOrder: 1 },
  { serviceKey: 'painting-service', title: '2 Room Painting', price: 2499, points: ['Two room paint job'], sortOrder: 2 },
  { serviceKey: 'painting-service', title: 'Wall Texture', price: 1799, points: ['Texture finish on walls'], sortOrder: 3 },
  { serviceKey: 'mason-work', title: 'Minor Repairs', price: 499, points: ['Small masonry repairs'], sortOrder: 1 },
  { serviceKey: 'mason-work', title: 'Brick Work', price: 799, points: ['Brick repair and refill'], sortOrder: 2 },
  { serviceKey: 'mason-work', title: 'Plastering', price: 699, points: ['Wall plaster work'], sortOrder: 3 },
  { serviceKey: 'tile-fixing', title: 'Tile Replacement', price: 499, points: ['Tile remove and replace'], sortOrder: 1 },
  { serviceKey: 'tile-fixing', title: 'Grouting', price: 399, points: ['Tile grout cleaning/fill'], sortOrder: 2 },
  { serviceKey: 'tile-fixing', title: 'Floor Fixing', price: 699, points: ['Floor tile fixing'], sortOrder: 3 },
  { serviceKey: 'false-ceiling-work', title: 'Design Consultation', price: 299, points: ['Site visit and design'], sortOrder: 1 },
  { serviceKey: 'false-ceiling-work', title: 'Gypsum Ceiling', price: 1999, points: ['Gypsum ceiling install'], sortOrder: 2 },
  { serviceKey: 'false-ceiling-work', title: 'PVC Ceiling', price: 1799, points: ['PVC ceiling install'], sortOrder: 3 },
  { serviceKey: 'door-window-installation', title: 'Door Installation', price: 799, points: ['Door fitting and alignment'], sortOrder: 1 },
  { serviceKey: 'door-window-installation', title: 'Window Installation', price: 699, points: ['Window fitting service'], sortOrder: 2 },
  { serviceKey: 'door-window-installation', title: 'Lock Fix', price: 399, points: ['Lock repair and replacement'], sortOrder: 3 },
  { serviceKey: 'general-labour', title: '2 Hour Help', price: 249, points: ['Basic help for 2 hours'], sortOrder: 1 },
  { serviceKey: 'general-labour', title: '4 Hour Help', price: 449, points: ['Half day assistance'], sortOrder: 2 },
  { serviceKey: 'general-labour', title: 'Full Day Help', price: 799, points: ['Full day labour'], sortOrder: 3 },
  { serviceKey: 'furniture-shifting', title: 'Single Item Move', price: 399, points: ['Move one heavy item'], sortOrder: 1 },
  { serviceKey: 'furniture-shifting', title: 'Room Shifting', price: 899, points: ['Move items in one room'], sortOrder: 2 },
  { serviceKey: 'furniture-shifting', title: 'Full Home Shifting', price: 1999, points: ['Multiple items shifting'], sortOrder: 3 },
  { serviceKey: 'loading-unloading', title: 'Small Load', price: 299, points: ['Small vehicle load'], sortOrder: 1 },
  { serviceKey: 'loading-unloading', title: 'Medium Load', price: 499, points: ['Medium vehicle load'], sortOrder: 2 },
  { serviceKey: 'loading-unloading', title: 'Heavy Load', price: 699, points: ['Large vehicle load'], sortOrder: 3 },
  { serviceKey: 'house-shifting-help', title: 'Local Move Assist', price: 999, points: ['Local move support'], sortOrder: 1 },
  { serviceKey: 'house-shifting-help', title: 'Packing Help', price: 799, points: ['Packing assistance'], sortOrder: 2 },
  { serviceKey: 'house-shifting-help', title: 'Unpacking Help', price: 699, points: ['Unpacking assistance'], sortOrder: 3 },
  { serviceKey: 'gardening-service', title: 'Garden Cleanup', price: 349, points: ['Garden clean-up'], sortOrder: 1 },
  { serviceKey: 'gardening-service', title: 'Lawn Care', price: 449, points: ['Lawn trimming and care'], sortOrder: 2 },
  { serviceKey: 'gardening-service', title: 'Planting', price: 399, points: ['Planting and setup'], sortOrder: 3 },
  { serviceKey: 'salon-at-home', title: 'Basic Grooming', price: 299, points: ['Haircut or basic grooming'], sortOrder: 1 },
  { serviceKey: 'salon-at-home', title: 'Standard Care', price: 499, points: ['Facial or spa care'], sortOrder: 2 },
  { serviceKey: 'salon-at-home', title: 'Premium Spa', price: 799, points: ['Premium at-home spa'], sortOrder: 3 }
];

const resolveServiceKeys = (serviceKey: string) => {
  const normalized = slugifyKey(serviceKey);
  const aliases = SERVICE_KEY_ALIASES[normalized] ?? [];
  const reverse = Object.entries(SERVICE_KEY_ALIASES)
    .filter(([, legacy]) => legacy.includes(normalized))
    .map(([key]) => key);
  return Array.from(new Set([normalized, ...aliases, ...reverse]));
};

const getPricingDelegate = (res: any) => {
  const delegate = (prisma as any).pricingItem;
  if (!delegate) {
    res.status(500).json({
      message: 'Pricing feature is not migrated yet. Run prisma generate + prisma db push.'
    });
    return null;
  }
  return delegate;
};
const getPackageDelegate = (res: any) => {
  const delegate = (prisma as any).servicePackage;
  if (!delegate) {
    res.status(500).json({
      message: 'Service packages feature is not migrated yet. Run prisma generate + prisma db push.'
    });
    return null;
  }
  return delegate;
};

router.get('/public', cacheResponse(60_000), async (_req, res) => {
  const pricing = getPricingDelegate(res);
  if (!pricing) return;
  const rows = await pricing.findMany({
    where: { isActive: true },
    orderBy: [{ label: 'asc' }]
  });

  return res.json({
    prices: rows.map((row: any) => ({
      id: row.id,
      serviceKey: row.serviceKey,
      label: row.label,
      basePrice: Number(row.basePrice)
    }))
  });
});

// Used by the app to hide only explicitly-disabled services.
router.get('/public/all', cacheResponse(60_000), async (_req, res) => {
  const pricing = getPricingDelegate(res);
  if (!pricing) return;
  const rows = await pricing.findMany({
    orderBy: [{ label: 'asc' }]
  });

  return res.json({
    prices: rows.map((row: any) => ({
      id: row.id,
      serviceKey: row.serviceKey,
      label: row.label,
      basePrice: Number(row.basePrice),
      isActive: Boolean(row.isActive)
    }))
  });
});

router.get('/admin/list', requireAuth, requireRole('admin'), async (_req, res) => {
  const pricing = getPricingDelegate(res);
  if (!pricing) return;
  const rows = await pricing.findMany({
    orderBy: [{ updatedAt: 'desc' }]
  });
  return res.json({ prices: rows });
});

router.put('/admin/upsert', requireAuth, requireRole('admin'), async (req, res) => {
  const pricing = getPricingDelegate(res);
  if (!pricing) return;
  const parsed = upsertSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? 'Invalid payload' });

  const payload = parsed.data;
  const serviceKey = slugifyKey(payload.serviceKey);

  const item = await pricing.upsert({
    where: { serviceKey },
    create: {
      serviceKey,
      label: payload.label.trim(),
      basePrice: payload.basePrice,
      isActive: payload.isActive ?? true
    },
    update: {
      label: payload.label.trim(),
      basePrice: payload.basePrice,
      ...(payload.isActive !== undefined ? { isActive: payload.isActive } : {})
    }
  });

  deleteCacheByPrefix('/pricing');
  deleteCacheByPrefix('/services');
  return res.json({ price: item });
});

router.delete('/admin/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const pricing = getPricingDelegate(res);
  if (!pricing) return;
  const current = await pricing.findUnique({ where: { id: req.params.id } });
  if (!current) return res.status(404).json({ message: 'Price item not found' });
  await pricing.delete({ where: { id: current.id } });
  deleteCacheByPrefix('/pricing');
  deleteCacheByPrefix('/services');
  return res.status(204).send();
});

router.get('/packages/public', cacheResponse(60_000), async (req, res) => {
  const servicePackage = getPackageDelegate(res);
  const pricing = getPricingDelegate(res);
  if (!servicePackage) return;
  const serviceKey = slugifyKey(String(req.query.serviceKey ?? ''));
  if (!serviceKey) return res.json({ packages: [] });
  const keys = resolveServiceKeys(serviceKey);
  if (pricing) {
    const serviceRows = await pricing.findMany({ where: { serviceKey: { in: keys } } });
    if (serviceRows.length > 0 && serviceRows.every((row) => row.isActive === false)) {
      return res.json({ packages: [] });
    }
  }
  const rows = await servicePackage.findMany({
    where: { serviceKey: { in: keys } },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }]
  });
  const normalizeTitle = (value: string) => value.trim().toLowerCase();
  const rowTitles = new Set(rows.map((row: any) => normalizeTitle(String(row.title || ''))).filter(Boolean));
  const activeRows = rows.filter((row: any) => row.isActive);
  const presets = DEFAULT_PACKAGES.filter((pkg) => keys.includes(pkg.serviceKey)).filter(
    (pkg) => !rowTitles.has(normalizeTitle(pkg.title))
  );
  const merged = [
    ...activeRows.map((row: any) => ({
      id: row.id,
      serviceKey: row.serviceKey,
      title: row.title,
      price: Number(row.price),
      points: Array.isArray(row.points) ? row.points : [],
      sortOrder: row.sortOrder,
      isActive: Boolean(row.isActive)
    })),
    ...presets.map((pkg) => ({
      id: `preset-${pkg.serviceKey}-${pkg.sortOrder}`,
      serviceKey: pkg.serviceKey,
      title: pkg.title,
      price: Number(pkg.price),
      points: pkg.points,
      sortOrder: pkg.sortOrder,
      isActive: true
    }))
  ];
  return res.json({
    packages: merged
  });
});

router.get('/packages/admin/list', requireAuth, requireRole('admin'), async (_req, res) => {
  const servicePackage = getPackageDelegate(res);
  if (!servicePackage) return;
  const rows = await servicePackage.findMany({
    orderBy: [{ serviceKey: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }]
  });
  return res.json({ packages: rows });
});

router.put('/packages/admin/upsert', requireAuth, requireRole('admin'), async (req, res) => {
  const servicePackage = getPackageDelegate(res);
  if (!servicePackage) return;
  const parsed = packageUpsertSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? 'Invalid payload' });

  const payload = parsed.data;
  const serviceKey = slugifyKey(payload.serviceKey);

  if (payload.id) {
    const current = await servicePackage.findUnique({ where: { id: payload.id } });
    if (!current) return res.status(404).json({ message: 'Package not found' });
    const next = await servicePackage.update({
      where: { id: payload.id },
      data: {
        serviceKey,
        title: payload.title.trim(),
        price: payload.price,
        points: payload.points ?? [],
        sortOrder: payload.sortOrder ?? current.sortOrder,
        ...(payload.isActive !== undefined ? { isActive: payload.isActive } : {})
      }
    });
    deleteCacheByPrefix('/pricing');
    return res.json({ package: next });
  }

  const created = await servicePackage.create({
    data: {
      serviceKey,
      title: payload.title.trim(),
      price: payload.price,
      points: payload.points ?? [],
      sortOrder: payload.sortOrder ?? 0,
      isActive: payload.isActive ?? true
    }
  });
  deleteCacheByPrefix('/pricing');
  return res.json({ package: created });
});

router.delete('/packages/admin/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const servicePackage = getPackageDelegate(res);
  if (!servicePackage) return;
  const current = await servicePackage.findUnique({ where: { id: req.params.id } });
  if (!current) return res.status(404).json({ message: 'Package not found' });
  await servicePackage.delete({ where: { id: current.id } });
  deleteCacheByPrefix('/pricing');
  return res.status(204).send();
});

export default router;
