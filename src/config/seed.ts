import bcrypt from 'bcryptjs';
import { prisma } from './db.js';
import { env } from './env.js';

const defaultServices = [
  { name: 'electrician', basePrice: 299 },
  { name: 'plumber', basePrice: 299 },
  { name: 'carpenter', basePrice: 349 },
  { name: 'ac-repair-service', basePrice: 399 },
  { name: 'washing-machine-repair', basePrice: 299 },
  { name: 'refrigerator-repair', basePrice: 349 },
  { name: 'ro-repair', basePrice: 299 },
  { name: 'microwave-repair', basePrice: 299 },
  { name: 'tv-repair', basePrice: 299 },
  { name: 'home-deep-cleaning', basePrice: 449 },
  { name: 'kitchen-cleaning', basePrice: 349 },
  { name: 'bathroom-cleaning', basePrice: 329 },
  { name: 'sofa-cleaning', basePrice: 349 },
  { name: 'carpet-cleaning', basePrice: 349 },
  { name: 'water-tank-cleaning', basePrice: 499 },
  { name: 'painting-service', basePrice: 499 },
  { name: 'mason-work', basePrice: 399 },
  { name: 'tile-fixing', basePrice: 399 },
  { name: 'false-ceiling-work', basePrice: 599 },
  { name: 'door-window-installation', basePrice: 399 },
  { name: 'general-labour', basePrice: 249 },
  { name: 'furniture-shifting', basePrice: 399 },
  { name: 'loading-unloading', basePrice: 299 },
  { name: 'house-shifting-help', basePrice: 699 },
  { name: 'gardening-service', basePrice: 299 },
  { name: 'salon-at-home', basePrice: 299 },
  { name: 'cleaning', basePrice: 349 },
  { name: 'painter', basePrice: 399 },
  { name: 'labour', basePrice: 299 },
  { name: 'mason', basePrice: 399 },
  { name: 'ac-repair', basePrice: 399 },
  { name: 'appliance-repair', basePrice: 499 }
] as const;

const defaultCategories = [
  { name: 'Plumber', slug: 'plumber', icon: 'plumbing', sortOrder: 1 },
  { name: 'Electrician', slug: 'electrician', icon: 'bolt', sortOrder: 2 },
  { name: 'Carpenter', slug: 'carpenter', icon: 'hammer', sortOrder: 3 },
  { name: 'Painter', slug: 'painter', icon: 'brush', sortOrder: 4 },
  { name: 'AC Repair', slug: 'ac-repair', icon: 'snowflake', sortOrder: 5 },
  { name: 'Packers & Movers', slug: 'packers-movers', icon: 'truck', sortOrder: 6 },
  { name: 'Cleaning', slug: 'cleaning', icon: 'broom', sortOrder: 7 },
  { name: 'General Services', slug: 'general-services', icon: 'briefcase', sortOrder: 999 }
] as const;

export const seedData = async () => {
  for (const service of defaultServices) {
    await prisma.service.upsert({
      where: { name: service.name },
      update: {},
      create: service
    });
  }

  for (const category of defaultCategories) {
    await (prisma as any).category.upsert({
      where: { slug: category.slug },
      update: {
        name: category.name,
        icon: category.icon,
        sortOrder: category.sortOrder,
        isActive: true
      },
      create: {
        name: category.name,
        slug: category.slug,
        icon: category.icon,
        sortOrder: category.sortOrder,
        isActive: true
      }
    });
  }

  if (!env.seedDefaultAdmin) {
    return;
  }

  const adminPassword = env.adminSeedPassword || (env.nodeEnv === 'production' ? '' : 'admin123');
  if (!adminPassword) {
    throw new Error('ADMIN_SEED_PASSWORD is required when SEED_DEFAULT_ADMIN is enabled in production');
  }

  const passwordHash = await bcrypt.hash(adminPassword, 10);
  const admin = await prisma.user.findUnique({ where: { email: env.adminSeedEmail } });

  if (!admin) {
    await prisma.user.create({
      data: {
        name: 'Platform Admin',
        email: env.adminSeedEmail,
        phone: '0000000000',
        profilePhotoUrl: '',
        city: 'Prayagraj',
        address: '',
        complaintFlagNote: '',
        phoneVerified: true,
        passwordHash,
        role: 'admin',
        isApproved: true
      }
    });
    return;
  }

  await prisma.user.update({
    where: { email: env.adminSeedEmail },
    data: {
      name: admin.name || 'Platform Admin',
      profilePhotoUrl: admin.profilePhotoUrl || '',
      city: admin.city || 'Prayagraj',
      address: admin.address || '',
      complaintFlagNote: admin.complaintFlagNote || '',
      passwordHash,
      role: 'admin',
      isApproved: true,
      phoneVerified: true
    }
  });
};
