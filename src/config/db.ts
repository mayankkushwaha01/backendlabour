import { PrismaClient } from '@prisma/client';
import { env } from './env.js';

export const prisma = new PrismaClient();

export const connectDb = async () => {
  if (!env.databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  await prisma.$connect();
};
