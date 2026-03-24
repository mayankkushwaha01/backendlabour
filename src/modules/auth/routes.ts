import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { prisma } from '../../config/db.js';
import type { UserRole } from '../../types/domain.js';

const router = Router();

const OTP_TTL_MS = 5 * 60 * 1000;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;
const loginAttempts = new Map<string, { count: number; lockedUntil: number }>();

const normalizePhone = (value: string) => value.replace(/\D/g, '');
const isValidPhone = (value: string) => /^\d{10,15}$/.test(value);
const normalizeAadhaar = (value: string) => value.replace(/\D/g, '');
const createOtpCode = () => Math.floor(100000 + Math.random() * 900000).toString();
const dataUrlImageRegex = /^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/;

const requestOtpSchema = z.object({
  email: z.string().email().transform((value) => value.trim().toLowerCase())
});

const requestPhoneOtpSchema = z.object({
  phone: z.string().min(10).max(15),
  intent: z.enum(['login', 'signup']).optional()
});
const checkPhoneSchema = z.object({
  phone: z.string().min(10).max(15)
});

const verifyWhatsappOtpSchema = z.object({
  phone: z.string().min(10).max(15),
  otp: z.string().regex(/^\d{6}$/),
  intent: z.enum(['login', 'signup']).default('login'),
  role: z.enum(['customer', 'worker']).optional(),
  name: z.string().min(2).max(120).optional()
});

const requestPasswordResetSchema = z.object({
  email: z.string().email().transform((value) => value.trim().toLowerCase())
});

const resetPasswordSchema = z.object({
  email: z.string().email().transform((value) => value.trim().toLowerCase()),
  emailOtpCode: z.string().regex(/^\d{6}$/, 'OTP must be 6 digits'),
  newPassword: z.string().min(8)
});

const signupSchema = z.object({
  name: z.string().min(2),
  email: z.string().email().transform((value) => value.trim().toLowerCase()).optional(),
  phone: z.string().min(8),
  phoneOtpCode: z.string().regex(/^\d{6}$/, 'OTP must be 6 digits').optional(),
  password: z.string().min(8),
  role: z.enum(['customer', 'worker']),
  profilePhotoUrl: z.string().url().or(z.string().regex(dataUrlImageRegex)).or(z.literal('')).optional(),
  aadhaarNumber: z.string().optional(),
  aadhaarCardUrl: z.string().min(10).optional()
}).superRefine((value, ctx) => {
  if (value.role === 'worker') {
    if (!value.aadhaarNumber) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['aadhaarNumber'],
        message: 'Aadhaar number is required for workers'
      });
    }
    if (!value.aadhaarCardUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['aadhaarCardUrl'],
        message: 'Aadhaar card photo is required for workers'
      });
    }
  }
});

const loginSchema = z.object({
  email: z.string().optional(),
  identifier: z.string().optional(),
  password: z.string().min(6)
}).superRefine((value, ctx) => {
  const raw = (value.identifier ?? value.email ?? '').trim();
  if (!raw) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['identifier'],
      message: 'Email, phone or name is required'
    });
  }
});

const sendOtpEmail = async (email: string, otpCode: string, subject = 'LabourHub OTP Verification', context = 'verification') => {
  if (!env.smtpUser || !env.smtpPass) {
    throw new Error('Gmail SMTP is not configured. Set SMTP_USER and SMTP_PASS.');
  }

  const transporter = nodemailer.createTransport({
    host: env.smtpHost,
    port: env.smtpPort,
    secure: env.smtpPort === 465,
    auth: {
      user: env.smtpUser,
      pass: env.smtpPass
    }
  });

  await transporter.sendMail({
    from: env.smtpFrom || env.smtpUser,
    to: email,
    subject,
    text: `${otpCode} is your LabourHub ${context} OTP. It is valid for 5 minutes.`
  });
};

const sendSmsOtp = async (phone: string, otpCode: string) => {
  if (!env.msg91AuthKey || !env.msg91OtpTemplateId) {
    throw new Error('MSG91 is not configured. Set MSG91_AUTH_KEY and MSG91_OTP_TEMPLATE_ID.');
  }

  const mobile = phone.length === 10 ? `91${phone}` : phone;
  const url = new URL(env.msg91OtpUrl || 'https://control.msg91.com/api/v5/otp');
  url.searchParams.set('template_id', env.msg91OtpTemplateId);
  url.searchParams.set('mobile', mobile);
  url.searchParams.set('authkey', env.msg91AuthKey);
  url.searchParams.set('otp', otpCode);
  url.searchParams.set('otp_expiry', '5');
  if (env.msg91SenderId) {
    url.searchParams.set('sender', env.msg91SenderId);
  }

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      authkey: env.msg91AuthKey
    }
  });

  if (!response.ok) {
    throw new Error('Failed to send OTP');
  }

  const payload = await response.json().catch(() => null);
  if (payload && typeof payload.type === 'string' && payload.type.toLowerCase() !== 'success') {
    throw new Error(payload.message || 'Failed to send OTP');
  }
};

const getLoginAttemptKey = (identifier: string) => normalizePhone(identifier) || identifier.trim().toLowerCase();

const canAttemptLogin = (identifier: string) => {
  const key = getLoginAttemptKey(identifier);
  const entry = loginAttempts.get(key);
  if (!entry) return { allowed: true as const };
  if (entry.lockedUntil > Date.now()) {
    const waitMinutes = Math.ceil((entry.lockedUntil - Date.now()) / (60 * 1000));
    return {
      allowed: false as const,
      message: `Too many login attempts. ${waitMinutes} min baad dubara try karo.`
    };
  }
  if (entry.lockedUntil <= Date.now()) {
    loginAttempts.delete(key);
  }
  return { allowed: true as const };
};

const markLoginFailure = (identifier: string) => {
  const key = getLoginAttemptKey(identifier);
  const current = loginAttempts.get(key);
  const nextCount = (current?.count ?? 0) + 1;
  const lockedUntil = nextCount >= MAX_LOGIN_ATTEMPTS ? Date.now() + LOGIN_WINDOW_MS : 0;
  loginAttempts.set(key, { count: nextCount, lockedUntil });
};

const clearLoginFailures = (identifier: string) => {
  loginAttempts.delete(getLoginAttemptKey(identifier));
};

const createMobileSession = (user: any) => {
  const token = jwt.sign({ sub: user.id, role: user.role }, env.jwtSecret, { expiresIn: '7d' });
  return {
    token,
    user: {
      id: user.id,
      name: user.name,
      role: user.role,
      email: user.email,
      profilePhotoUrl: user.profilePhotoUrl
    }
  };
};

router.post('/otp/request', async (req, res) => {
  const parsed = requestOtpSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid request', errors: parsed.error.flatten() });
  }

  const email = parsed.data.email;

  const existingEmail = await prisma.user.findUnique({ where: { email } });
  if (existingEmail) {
    return res.status(409).json({ message: 'Email already registered' });
  }

  const otpCode = createOtpCode();
  const codeHash = await bcrypt.hash(otpCode, 10);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  await prisma.emailOtp.upsert({
    where: { email },
    update: { codeHash, expiresAt, attempts: 0, purpose: 'signup' },
    create: { email, codeHash, expiresAt, attempts: 0, purpose: 'signup' }
  });

  try {
    await sendOtpEmail(email, otpCode);
  } catch (error) {
    await prisma.emailOtp.deleteMany({ where: { email, purpose: 'signup' } });
    return res.status(502).json({
      message: error instanceof Error ? error.message : 'Failed to send OTP'
    });
  }

  return res.json({
    message: 'OTP sent to email',
    ...(env.nodeEnv !== 'production' ? { devOtp: otpCode } : {})
  });
});

const requestPhoneOtp = async (req: any, res: any) => {
  const parsed = requestPhoneOtpSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid request', errors: parsed.error.flatten() });
  }

  const phone = normalizePhone(parsed.data.phone);
  if (!isValidPhone(phone)) {
    return res.status(400).json({ message: 'Invalid phone number format' });
  }

  const otpCode = createOtpCode();
  const otpHash = await bcrypt.hash(otpCode, 10);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);
  const purpose = parsed.data.intent === 'signup' ? 'signup' : 'login';

  await (prisma as any).whatsappOtp.deleteMany({ where: { phone } });
  await (prisma as any).whatsappOtp.create({
    data: {
      phone,
      otpHash,
      expiresAt,
      attempts: 0,
      purpose
    }
  });

  try {
    await sendSmsOtp(phone, otpCode);
  } catch (error) {
    return res.status(502).json({
      message: error instanceof Error ? error.message : 'Failed to send OTP'
    });
  }

  return res.json({
    message: 'OTP sent to phone',
    ...(env.nodeEnv !== 'production' ? { devOtp: otpCode } : {})
  });
};

router.post('/otp/whatsapp/request', requestPhoneOtp);
router.post('/otp/phone/request', requestPhoneOtp);

router.post('/phone/check', async (req, res) => {
  const parsed = checkPhoneSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid request', errors: parsed.error.flatten() });
  }

  const phone = normalizePhone(parsed.data.phone);
  if (!isValidPhone(phone)) {
    return res.status(400).json({ message: 'Invalid phone number format' });
  }

  const user = await prisma.user.findUnique({ where: { phone } });
  return res.json({
    exists: Boolean(user),
    role: user?.role ?? null
  });
});

const verifyPhoneOtp = async (req: any, res: any) => {
  const parsed = verifyWhatsappOtpSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid request', errors: parsed.error.flatten() });
  }

  const phone = normalizePhone(parsed.data.phone);
  if (!isValidPhone(phone)) {
    return res.status(400).json({ message: 'Invalid phone number format' });
  }

  const otpRecord = await (prisma as any).whatsappOtp.findFirst({
    where: { phone },
    orderBy: { createdAt: 'desc' }
  });
  if (!otpRecord) {
    return res.status(400).json({ message: 'Please request OTP first' });
  }
  if (otpRecord.expiresAt.getTime() < Date.now()) {
    return res.status(400).json({ message: 'OTP expired. Please request a new OTP' });
  }
  if ((otpRecord.attempts ?? 0) >= 5) {
    return res.status(429).json({ message: 'Too many attempts. Please request OTP again' });
  }

  const validOtp = await bcrypt.compare(parsed.data.otp, otpRecord.otpHash);
  if (!validOtp) {
    await (prisma as any).whatsappOtp.update({
      where: { id: otpRecord.id },
      data: { attempts: { increment: 1 } }
    });
    return res.status(400).json({ message: 'Invalid OTP' });
  }

  let user = await prisma.user.findUnique({ where: { phone } });
  if (!user && parsed.data.intent === 'login') {
    return res.status(404).json({ message: 'No account found with this mobile number. Use signup intent.' });
  }

  if (!user && parsed.data.intent === 'signup') {
    const name = parsed.data.name?.trim() || `User ${phone.slice(-4)}`;
    const role = (parsed.data.role ?? 'customer') as UserRole;
    const passwordHash = await bcrypt.hash(`whatsapp-${Date.now()}-${phone}`, 10);
    user = await prisma.user.create({
      data: {
        name,
        email: `${phone}@mobile.labourhub.local`,
        phone,
        profilePhotoUrl: '',
        city: 'Prayagraj',
        address: '',
        passwordHash,
        phoneVerified: true,
        complaintFlagNote: '',
        role,
        isApproved: role === 'customer'
      }
    });
  }

  if (!user) {
    return res.status(500).json({ message: 'Unable to create mobile session' });
  }
  if (user.role === 'worker' && !user.isApproved) {
    return res.status(403).json({ message: 'Worker profile pending admin approval' });
  }

  await (prisma as any).whatsappOtp.deleteMany({ where: { phone } });
  return res.json(createMobileSession(user));
};

router.post('/otp/whatsapp/verify', verifyPhoneOtp);
router.post('/otp/phone/verify', verifyPhoneOtp);

router.post('/login/mobile', async (req, res) => {
  const parsed = z.object({
    phone: z.string().min(10).max(15),
    otp: z.string().regex(/^\d{6}$/)
  }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid request', errors: parsed.error.flatten() });
  }

  const phone = normalizePhone(parsed.data.phone);
  if (!isValidPhone(phone)) {
    return res.status(400).json({ message: 'Invalid phone number format' });
  }

  const otpRecord = await (prisma as any).whatsappOtp.findFirst({
    where: { phone },
    orderBy: { createdAt: 'desc' }
  });
  if (!otpRecord) {
    return res.status(400).json({ message: 'Please request OTP first' });
  }
  if (otpRecord.expiresAt.getTime() < Date.now()) {
    return res.status(400).json({ message: 'OTP expired. Please request a new OTP' });
  }

  const validOtp = await bcrypt.compare(parsed.data.otp, otpRecord.otpHash);
  if (!validOtp) {
    await (prisma as any).whatsappOtp.update({
      where: { id: otpRecord.id },
      data: { attempts: { increment: 1 } }
    });
    return res.status(400).json({ message: 'Invalid OTP' });
  }

  const user = await prisma.user.findUnique({ where: { phone } });
  if (!user) {
    return res.status(404).json({ message: 'No account found with this mobile number. Use signup intent.' });
  }
  if (user.role === 'worker' && !user.isApproved) {
    return res.status(403).json({ message: 'Worker profile pending admin approval' });
  }

  await (prisma as any).whatsappOtp.deleteMany({ where: { phone } });
  return res.json(createMobileSession(user));
});

router.post('/signup', async (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid request', errors: parsed.error.flatten() });
  }

  const { name, email, password, role, phoneOtpCode, aadhaarNumber } = parsed.data;
  const phone = normalizePhone(parsed.data.phone);
  if (!isValidPhone(phone)) {
    return res.status(400).json({ message: 'Invalid phone number format' });
  }

  if (email) {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ message: 'Email already registered' });
    }
  }

  const existingPhone = await prisma.user.findUnique({ where: { phone } });
  if (existingPhone) {
    return res.status(409).json({ message: 'Phone number already registered' });
  }

  let phoneVerified = false;
  if (phoneOtpCode) {
    const otpRecord = await (prisma as any).whatsappOtp.findFirst({
      where: { phone, purpose: 'signup' },
      orderBy: { createdAt: 'desc' }
    });
    if (!otpRecord) {
      return res.status(400).json({ message: 'Please request phone OTP first' });
    }

    if (otpRecord.expiresAt.getTime() < Date.now()) {
      return res.status(400).json({ message: 'OTP expired. Please request a new OTP' });
    }

    const validOtp = await bcrypt.compare(phoneOtpCode, otpRecord.otpHash);
    if (!validOtp) {
      await (prisma as any).whatsappOtp.update({
        where: { id: otpRecord.id },
        data: { attempts: { increment: 1 } }
      });
      return res.status(400).json({ message: 'Invalid OTP' });
    }

    phoneVerified = true;
    await (prisma as any).whatsappOtp.delete({ where: { id: otpRecord.id } });
  } else if (role === 'worker') {
    return res.status(400).json({ message: 'Phone OTP is required for worker signup' });
  }

  const normalizedAadhaar = role === 'worker' ? normalizeAadhaar(aadhaarNumber ?? '') : '';
  if (role === 'worker' && !/^\d{12}$/.test(normalizedAadhaar)) {
    return res.status(400).json({ message: 'Aadhaar number must be 12 digits' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const normalizedEmail = email?.trim().toLowerCase() || `${phone}@mobile.labourhub.local`;
  await prisma.user.create({
    data: {
      name,
      email: normalizedEmail,
      phone,
      profilePhotoUrl: parsed.data.profilePhotoUrl?.trim() || '',
      city: 'Prayagraj',
      address: '',
      phoneVerified,
      passwordHash,
      complaintFlagNote: '',
      role: role as UserRole,
      isApproved: role === 'customer'
    }
  });

  return res.status(201).json({ message: 'Signup successful. Worker accounts require admin approval.' });
});

router.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid request', errors: parsed.error.flatten() });
  }

  const { password } = parsed.data;
  const rawIdentifier = (parsed.data.identifier ?? parsed.data.email ?? '').trim();
  const loginGuard = canAttemptLogin(rawIdentifier);
  if (!loginGuard.allowed) {
    return res.status(429).json({ message: loginGuard.message });
  }
  const normalizedEmail = rawIdentifier.toLowerCase();
  const normalizedPhone = normalizePhone(rawIdentifier);

  let user = null;
  if (rawIdentifier.includes('@')) {
    user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  } else if (isValidPhone(normalizedPhone)) {
    user = await prisma.user.findUnique({ where: { phone: normalizedPhone } });
  } else {
    return res.status(400).json({ message: 'Use email or phone for login' });
  }

  if (!user) {
    markLoginFailure(rawIdentifier);
    return res.status(401).json({ message: 'Invalid credentials' });
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    markLoginFailure(rawIdentifier);
    return res.status(401).json({ message: 'Invalid credentials' });
  }

  if (user.role === 'worker' && !user.isApproved) {
    return res.status(403).json({ message: 'Worker profile pending admin approval' });
  }

  clearLoginFailures(rawIdentifier);

  const token = jwt.sign({ sub: user.id, role: user.role }, env.jwtSecret, { expiresIn: '7d' });

  return res.json({
    token,
    user: {
      id: user.id,
      name: user.name,
      role: user.role,
      email: user.email,
      profilePhotoUrl: user.profilePhotoUrl
    }
  });
});

router.post('/password/forgot', async (req, res) => {
  const parsed = requestPasswordResetSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid request', errors: parsed.error.flatten() });
  }

  const email = parsed.data.email;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    return res.status(404).json({ message: 'Account not found for this email' });
  }

  const otpCode = createOtpCode();
  const codeHash = await bcrypt.hash(otpCode, 10);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  await prisma.emailOtp.upsert({
    where: { email },
    update: { codeHash, expiresAt, attempts: 0, purpose: 'signup' },
    create: { email, codeHash, expiresAt, attempts: 0, purpose: 'signup' }
  });

  try {
    await sendOtpEmail(email, otpCode, 'LabourHub Password Reset OTP', 'password reset');
  } catch (error) {
    return res.status(502).json({
      message: error instanceof Error ? error.message : 'Failed to send OTP'
    });
  }

  return res.json({
    message: 'Password reset OTP sent to email',
    ...(env.nodeEnv !== 'production' ? { devOtp: otpCode } : {})
  });
});

router.post('/password/reset', async (req, res) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid request', errors: parsed.error.flatten() });
  }

  const { email, emailOtpCode, newPassword } = parsed.data;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    return res.status(404).json({ message: 'Account not found for this email' });
  }

  const otpRecord = await prisma.emailOtp.findFirst({ where: { email } });
  if (!otpRecord) {
    return res.status(400).json({ message: 'Please request password reset OTP first' });
  }

  if (otpRecord.expiresAt.getTime() < Date.now()) {
    return res.status(400).json({ message: 'OTP expired. Please request a new OTP' });
  }

  const validOtp = await bcrypt.compare(emailOtpCode, otpRecord.codeHash);
  if (!validOtp) {
    await prisma.emailOtp.update({
      where: { id: otpRecord.id },
      data: { attempts: { increment: 1 } }
    });
    return res.status(400).json({ message: 'Invalid OTP' });
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash }
  });
  await prisma.emailOtp.delete({ where: { id: otpRecord.id } });

  return res.json({ message: 'Password reset successful. Please login with new password.' });
});

export default router;
