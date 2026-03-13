import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthRequest } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/role.js';
import { prisma } from '../../config/db.js';

const router = Router();

const dataUrlImageRegex = /^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/;
const allowedTags = ['on-time', 'behaviour', 'quality'] as const;

const reviewSchema = z.object({
  bookingId: z.string().min(3),
  rating: z.number().min(1).max(5),
  comment: z.string().min(3),
  photoUrl: z.string().url().or(z.string().regex(dataUrlImageRegex)).or(z.literal('')).optional(),
  tags: z.array(z.enum(allowedTags)).max(3).optional()
});

const serializeReview = (r: any) => ({
  id: r.id,
  bookingId: r.bookingId,
  customerId: r.customerId,
  workerId: r.workerId,
  rating: r.rating,
  comment: r.comment,
  photoUrl: r.photoUrl ?? '',
  tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
  createdAt: new Date(r.createdAt).toISOString()
});

router.post('/', requireAuth, requireRole('customer'), async (req: AuthRequest, res) => {
  const parsed = reviewSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid request', errors: parsed.error.flatten() });
  }

  const { bookingId, rating, comment, photoUrl, tags } = parsed.data;
  const booking = await prisma.booking.findFirst({ where: { id: bookingId, customerId: req.auth!.userId } });
  if (!booking) return res.status(404).json({ message: 'Booking not found' });
  if (booking.status !== 'completed') return res.status(400).json({ message: 'Review allowed only after completion' });

  const existing = await prisma.review.findUnique({ where: { bookingId } });
  if (existing) return res.status(409).json({ message: 'Review already submitted for this booking' });

  const review = await prisma.review.create({
    data: {
      bookingId,
      customerId: req.auth!.userId,
      workerId: booking.workerId,
      rating,
      comment,
      photoUrl: photoUrl?.trim() || '',
      tags: tags?.length ? tags : []
    } as any
  });

  const stats = await prisma.review.aggregate({
    where: { workerId: booking.workerId },
    _avg: { rating: true },
    _count: { _all: true }
  });

  const avgRating = stats._avg.rating ?? 0;
  const total = stats._count._all ?? 0;

  await prisma.workerProfile.updateMany({
    where: { userId: booking.workerId },
    data: { rating: Number(avgRating.toFixed(2)), totalJobs: total }
  });

  return res.status(201).json({ review: serializeReview(review) });
});

router.get('/my', requireAuth, requireRole('customer'), async (req: AuthRequest, res) => {
  const reviews = await prisma.review.findMany({ where: { customerId: req.auth!.userId } });
  return res.json({
    reviewedBookingIds: reviews.map((r) => r.bookingId),
    reviews: reviews.map(serializeReview)
  });
});

export default router;
