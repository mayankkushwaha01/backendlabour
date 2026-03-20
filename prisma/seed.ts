import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const email = 'admin@labour.local';

  const existing = await prisma.user.findUnique({ where: { email } });

  if (existing) {
    console.log(`Admin user already exists (id: ${existing.id}). Skipping seed.`);
    return;
  }

  const passwordHash = await bcrypt.hash('Admin@123456', 10);

  const admin = await prisma.user.create({
    data: {
      name: 'Admin',
      email,
      phone: '9999999999',
      passwordHash,
      role: 'admin',
      isApproved: true,
      phoneVerified: true,
      city: 'Prayagraj',
      address: 'Admin Office',
      profilePhotoUrl: '',
      complaintFlagNote: '',
    },
  });

  console.log(`Admin user created successfully (id: ${admin.id}, email: ${admin.email})`);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
