import dotenv from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const thisDir = dirname(fileURLToPath(import.meta.url));

const envCandidates = [
  resolve(process.cwd(), 'backend/api/.env'),
  resolve(process.cwd(), '.env'),
  resolve(thisDir, '../../.env'),
  resolve(thisDir, '../../../../.env')
];

for (const envPath of envCandidates) {
  dotenv.config({ path: envPath });
}

const toBool = (value: string | undefined, fallback: boolean) => {
  if (value == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};

const parseCorsOrigins = (value: string | undefined) => {
  if (!value) return [] as string[];
  return value.split(',').map((origin) => origin.trim()).filter(Boolean);
};

const nodeEnv = process.env.NODE_ENV ?? 'development';
const jwtSecret = process.env.JWT_SECRET ?? 'change-this-secret';

if (nodeEnv === 'production' && jwtSecret === 'change-this-secret') {
  throw new Error('JWT_SECRET must be set to a strong value in production');
}

export const env = {
  nodeEnv,
  port: Number(process.env.PORT ?? 4000),
  jwtSecret,
  databaseUrl: process.env.DATABASE_URL ?? '',
  smtpHost: process.env.SMTP_HOST ?? 'smtp.gmail.com',
  smtpPort: Number(process.env.SMTP_PORT ?? 587),
  smtpUser: process.env.SMTP_USER ?? '',
  smtpPass: process.env.SMTP_PASS ?? '',
  smtpFrom: process.env.SMTP_FROM ?? '',
  razorpayKeyId: process.env.RAZORPAY_KEY_ID ?? '',
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET ?? '',
  whatsappOtpProviderUrl: process.env.WHATSAPP_OTP_PROVIDER_URL ?? '',
  whatsappOtpApiKey: process.env.WHATSAPP_OTP_API_KEY ?? '',
  whatsappOtpTemplate: process.env.WHATSAPP_OTP_TEMPLATE ?? 'Your LabourHub OTP is {{otp}}. It is valid for 5 minutes.',
  whatsappOtpSender: process.env.WHATSAPP_OTP_SENDER ?? '',
  supportProxyPhone: process.env.SUPPORT_PROXY_PHONE ?? '9999999999',
  msg91OtpUrl: process.env.MSG91_OTP_URL ?? 'https://control.msg91.com/api/v5/otp',
  msg91AuthKey: process.env.MSG91_AUTH_KEY ?? '',
  msg91SenderId: process.env.MSG91_SENDER_ID ?? '',
  msg91OtpTemplateId: process.env.MSG91_OTP_TEMPLATE_ID ?? '',
  corsOrigins: parseCorsOrigins(process.env.CORS_ORIGIN),
  seedDefaultAdmin: toBool(process.env.SEED_DEFAULT_ADMIN, nodeEnv !== 'production'),
  adminSeedEmail: process.env.ADMIN_SEED_EMAIL ?? 'admin@labour.local',
  adminSeedPassword: process.env.ADMIN_SEED_PASSWORD ?? ''
};
