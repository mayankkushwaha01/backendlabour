import { createHmac } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/db.js';
import { env } from '../../config/env.js';
import { requireAuth, type AuthRequest } from '../../middleware/auth.js';

const router = Router();

const createOrderSchema = z.object({
  target: z.enum(['business', 'worker']),
  planKey: z.enum(['verified', 'verified_top_rated', 'rocket']),
  billingCycle: z.enum(['monthly', 'yearly']).default('monthly'),
  paymentMethod: z.enum(['upi', 'amanpay'])
});

const verifySchema = createOrderSchema.extend({
  razorpay_order_id: z.string().min(6),
  razorpay_payment_id: z.string().min(6),
  razorpay_signature: z.string().min(6)
});

const getPlanMeta = (planKey: 'verified' | 'verified_top_rated' | 'rocket') => {
  if (planKey === 'verified') {
    return {
      subscriptionPlan: 'starter' as const,
      listingType: 'free' as const,
      isVerifiedPlus: true,
      isPriorityBoosted: false,
      monthly: 99,
      yearly: 950
    };
  }
  if (planKey === 'verified_top_rated') {
    return {
      subscriptionPlan: 'growth' as const,
      listingType: 'promoted' as const,
      isVerifiedPlus: true,
      isPriorityBoosted: true,
      monthly: 199,
      yearly: 1900
    };
  }
  return {
    subscriptionPlan: 'pro' as const,
    listingType: 'promoted' as const,
    isVerifiedPlus: true,
    isPriorityBoosted: true,
    monthly: 499,
    yearly: 4790
  };
};

const getAuthHeader = () => {
  const token = Buffer.from(`${env.razorpayKeyId}:${env.razorpayKeySecret}`).toString('base64');
  return `Basic ${token}`;
};

router.get('/', (_req, res) => {
  return res.json({ message: 'Razorpay integration ready', keyConfigured: Boolean(env.razorpayKeyId && env.razorpayKeySecret) });
});

router.post('/create-order', requireAuth, async (req: AuthRequest, res) => {
  if (!env.razorpayKeyId || !env.razorpayKeySecret) {
    return res.status(503).json({ message: 'Razorpay keys not configured on server' });
  }

  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid payment payload', errors: parsed.error.flatten() });
  }

  const { target, planKey, billingCycle, paymentMethod } = parsed.data;
  const planMeta = getPlanMeta(planKey);
  const amountInPaise = (billingCycle === 'yearly' ? planMeta.yearly : planMeta.monthly) * 100;

  const payload = {
    amount: amountInPaise,
    currency: 'INR',
    receipt: `lh_${req.auth!.userId.slice(0, 8)}_${Date.now()}`,
    notes: {
      userId: req.auth!.userId,
      target,
      planKey,
      billingCycle,
      paymentMethod,
      app: 'labourhub'
    }
  };

  const response = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: {
      Authorization: getAuthHeader(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const data = (await response.json()) as any;
  if (!response.ok) {
    return res.status(502).json({ message: data?.error?.description || 'Failed to create Razorpay order' });
  }

  return res.json({
    orderId: data.id,
    amount: data.amount,
    currency: data.currency,
    keyId: env.razorpayKeyId,
    plan: { planKey, billingCycle, target, paymentMethod }
  });
});

router.post('/verify', requireAuth, async (req: AuthRequest, res) => {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid verify payload', errors: parsed.error.flatten() });
  }
  if (!env.razorpayKeySecret) {
    return res.status(503).json({ message: 'Razorpay secret not configured on server' });
  }

  const { target, planKey, billingCycle, paymentMethod, razorpay_order_id, razorpay_payment_id, razorpay_signature } = parsed.data;
  const expected = createHmac('sha256', env.razorpayKeySecret)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (expected !== razorpay_signature) {
    return res.status(400).json({ message: 'Payment signature mismatch' });
  }

  const planMeta = getPlanMeta(planKey);
  const nextEndsAt = new Date();
  nextEndsAt.setDate(nextEndsAt.getDate() + (billingCycle === 'yearly' ? 365 : 30));

  if (target === 'worker') {
    const worker = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
    if (!worker) return res.status(404).json({ message: 'User not found' });

    await prisma.user.update({
      where: { id: req.auth!.userId },
      data: {
        listingType: planMeta.listingType,
        subscriptionPlan: planMeta.subscriptionPlan,
        subscriptionEndsAt: nextEndsAt,
        isVerifiedPlus: planMeta.isVerifiedPlus,
        isPriorityBoosted: planMeta.isPriorityBoosted
      } as any
    });
  } else {
    const business = await (prisma as any).business.findFirst({ where: { vendorUserId: req.auth!.userId } });
    if (!business) return res.status(404).json({ message: 'Business not found' });

    await (prisma as any).business.update({
      where: { id: business.id },
      data: {
        listingType: planMeta.listingType,
        subscriptionPlan: planMeta.subscriptionPlan,
        subscriptionEndsAt: nextEndsAt
      }
    });
    await prisma.user.update({
      where: { id: req.auth!.userId },
      data: {
        isVerifiedPlus: planMeta.isVerifiedPlus,
        isPriorityBoosted: planMeta.isPriorityBoosted
      }
    });
  }

  return res.json({
    message: 'Payment verified and subscription activated',
    payment: {
      provider: 'razorpay',
      method: paymentMethod,
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id
    },
    subscription: {
      target,
      planKey,
      plan: planMeta.subscriptionPlan,
      listingType: planMeta.listingType,
      endsAt: nextEndsAt.toISOString(),
      billingCycle
    }
  });
});

export default router;

