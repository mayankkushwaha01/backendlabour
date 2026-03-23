import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthRequest } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/role.js';
import { prisma } from '../../config/db.js';

const router = Router();

const CANCELLATION_POLICY = {
  freeCancellationWindowHours: 2,
  maxReschedules: 2,
  message: 'Free cancellation/reschedule up to 2 hours before service time.'
} as const;

const createBookingSchema = z.object({
  workerId: z.string().min(3),
  serviceId: z.string().min(3),
  customerPhone: z.string().min(10).max(15).optional(),
  address: z.string().min(5),
  dateTime: z.string().datetime(),
  hours: z.number().int().min(1),
  paymentMethod: z.enum(['online', 'cash']),
  packageTitle: z.string().max(160).optional(),
  packageDescription: z.string().max(1000).optional(),
  packagePrice: z.number().min(0).optional()
});

const etaSchema = z.object({
  etaMinutes: z.number().int().min(1).max(720)
});

const liveLocationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180)
});

const rescheduleSchema = z.object({
  dateTime: z.string().datetime(),
  reason: z.string().max(250).optional()
});

const toIso = (value: Date | string | null | undefined) => {
  if (!value) return null;
  return new Date(value).toISOString();
};

const getEtaMinutes = (b: any) => {
  if (typeof b.etaMinutes === 'number' && b.etaMinutes > 0) return b.etaMinutes;
  const scheduleDiff = Math.round((new Date(b.dateTime).getTime() - Date.now()) / (1000 * 60));
  return scheduleDiff > 0 ? scheduleDiff : 0;
};

const getTimeline = (b: any) => {
  const currentStatus = String(b.status ?? 'pending');
  const steps = ['pending', 'accepted', 'on_the_way', 'started', 'completed'] as const;
  const stepTimeMap: Record<string, Date | string | null | undefined> = {
    pending: b.createdAt,
    accepted: b.acceptedAt,
    on_the_way: b.onTheWayAt,
    started: b.startedAt,
    completed: b.completedAt
  };
  const rank: Record<string, number> = {
    pending: 0,
    accepted: 1,
    on_the_way: 2,
    started: 3,
    in_progress: 3,
    completed: 4,
    cancelled: 4,
    rejected: 4
  };
  const currentRank = rank[currentStatus] ?? 0;

  return steps.map((step, index) => ({
    key: step,
    status: step,
    done: index <= currentRank,
    active: step === currentStatus || (currentStatus === 'in_progress' && step === 'started'),
    at: toIso(stepTimeMap[step])
  }));
};

const serializeBooking = (b: any) => ({
  id: b.id,
  customerId: b.customerId,
  workerId: b.workerId,
  serviceId: b.serviceId,
  customerPhone: b.customerPhone,
  address: b.address,
  dateTime: new Date(b.dateTime).toISOString(),
  hours: b.hours,
  totalAmount: b.totalAmount,
  packageTitle: b.packageTitle ?? '',
  packageDescription: b.packageDescription ?? '',
  packagePrice: typeof b.packagePrice === 'number' ? b.packagePrice : null,
  paymentMethod: b.paymentMethod,
  paymentStatus: b.paymentStatus,
  status: b.status,
  etaMinutes: getEtaMinutes(b),
  acceptedAt: toIso(b.acceptedAt),
  onTheWayAt: toIso(b.onTheWayAt),
  startedAt: toIso(b.startedAt),
  completedAt: toIso(b.completedAt),
  cancelledAt: toIso(b.cancelledAt),
  cancellationReason: b.cancellationReason ?? '',
  rescheduleCount: b.rescheduleCount ?? 0,
  lastRescheduledAt: toIso(b.lastRescheduledAt),
  timeline: getTimeline(b),
  workerLiveLat: typeof b.workerLiveLat === 'number' ? b.workerLiveLat : null,
  workerLiveLng: typeof b.workerLiveLng === 'number' ? b.workerLiveLng : null,
  workerLiveUpdatedAt: toIso(b.workerLiveUpdatedAt),
  cancellationPolicy: CANCELLATION_POLICY,
  createdAt: new Date(b.createdAt).toISOString()
});

router.post('/', requireAuth, requireRole('customer'), async (req: AuthRequest, res) => {
  const parsed = createBookingSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid request', errors: parsed.error.flatten() });
  }

  const payload = parsed.data;
  const [worker, service, customer] = await Promise.all([
    prisma.user.findFirst({
      where: {
        id: payload.workerId,
        isApproved: true,
        OR: [{ role: 'worker' }, { workerProfile: { isNot: null } }]
      },
      include: { workerProfile: true }
    }),
    prisma.service.findUnique({ where: { id: payload.serviceId } }),
    prisma.user.findUnique({ where: { id: req.auth!.userId } })
  ]);

  if (!worker || !service || !customer) {
    return res.status(404).json({ message: 'Worker or service not found' });
  }
  if (!worker.workerProfile?.isOnDuty) {
    return res.status(400).json({ message: 'Worker is currently off duty. Please choose another worker.' });
  }

  const fallbackAmount = service.basePrice * payload.hours;
  const totalAmount = typeof payload.packagePrice === 'number' && payload.packagePrice > 0
    ? payload.packagePrice
    : fallbackAmount;
  const booking = await (prisma as any).booking.create({
    data: {
      customerId: req.auth!.userId,
      workerId: payload.workerId,
      serviceId: payload.serviceId,
      customerPhone: (payload.customerPhone?.trim() || customer.phone || '').trim(),
      address: payload.address,
      dateTime: payload.dateTime,
      hours: payload.hours,
      totalAmount,
      packageTitle: payload.packageTitle?.trim() || null,
      packageDescription: payload.packageDescription?.trim() || null,
      packagePrice: typeof payload.packagePrice === 'number' ? payload.packagePrice : null,
      paymentMethod: payload.paymentMethod,
      paymentStatus: payload.paymentMethod === 'cash' ? 'unpaid' : 'paid',
      status: 'pending',
      etaMinutes: 0
    }
  });

  return res.status(201).json({ booking: serializeBooking(booking) });
});

router.get('/my', requireAuth, async (req: AuthRequest, res) => {
  try {
    const where: any = req.auth!.role === 'customer'
      ? { customerId: req.auth!.userId }
      : req.auth!.role === 'worker'
        ? { workerId: req.auth!.userId }
        : {};

    const bookings = await (prisma as any).booking.findMany({
      where,
      include: {
        customer: {
          select: { id: true, name: true, email: true, phone: true }
        },
        worker: {
          select: { id: true, name: true, email: true, phone: true }
        },
        service: {
          select: { id: true, name: true, basePrice: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
    return res.json({
      bookings: bookings.map((b: any) => {
        const base = serializeBooking(b);
        const hideWorker = req.auth!.role === 'customer' && String(b.status || '').toLowerCase() === 'pending';
        return {
          ...base,
          customerName: b.customer?.name ?? '',
          customerEmail: b.customer?.email ?? '',
          customerPhone: b.customer?.phone ?? b.customerPhone,
          workerId: hideWorker ? '' : base.workerId,
          workerName: hideWorker ? '' : b.worker?.name ?? '',
          workerEmail: hideWorker ? '' : b.worker?.email ?? '',
          serviceName: b.service?.name ?? ''
        };
      }),
      cancellationPolicy: CANCELLATION_POLICY
    });
  } catch (error) {
    console.error('bookings/my failed', error);
    const message = String((error as any)?.message ?? '');
    if (
      message.includes('Unknown argument') ||
      message.includes('Unknown field') ||
      message.includes('column') ||
      message.includes('does not exist')
    ) {
      return res.status(500).json({ message: 'Booking schema not migrated yet. Railway par prisma db push chahiye.' });
    }
    return res.status(500).json({ message: 'Unable to fetch bookings' });
  }
});

router.post('/:bookingId/accept', requireAuth, requireRole('worker'), async (req: AuthRequest, res) => {
  const booking = await (prisma as any).booking.findFirst({
    where: { id: req.params.bookingId, workerId: req.auth!.userId }
  });
  if (!booking) return res.status(404).json({ message: 'Booking not found' });
  if (booking.status !== 'pending') return res.status(400).json({ message: 'Only pending bookings can be accepted' });
  const updated = await (prisma as any).booking.update({
    where: { id: booking.id },
    data: { status: 'accepted', acceptedAt: new Date(), etaMinutes: booking.etaMinutes || 60 }
  });
  return res.json({ booking: serializeBooking(updated) });
});

router.post('/:bookingId/reject', requireAuth, requireRole('worker'), async (req: AuthRequest, res) => {
  const booking = await (prisma as any).booking.findFirst({
    where: { id: req.params.bookingId, workerId: req.auth!.userId }
  });
  if (!booking) return res.status(404).json({ message: 'Booking not found' });
  if (booking.status !== 'pending') return res.status(400).json({ message: 'Only pending bookings can be rejected' });
  const updated = await (prisma as any).booking.update({
    where: { id: booking.id },
    data: { status: 'rejected' }
  });
  return res.json({ booking: serializeBooking(updated) });
});

router.post('/:bookingId/on-the-way', requireAuth, requireRole('worker'), async (req: AuthRequest, res) => {
  const booking = await (prisma as any).booking.findFirst({
    where: { id: req.params.bookingId, workerId: req.auth!.userId }
  });
  if (!booking) return res.status(404).json({ message: 'Booking not found' });
  if (booking.status !== 'accepted') return res.status(400).json({ message: 'Only accepted bookings can move on-the-way' });
  const updated = await (prisma as any).booking.update({
    where: { id: booking.id },
    data: { status: 'on_the_way', onTheWayAt: new Date() }
  });
  return res.json({ booking: serializeBooking(updated) });
});

router.post('/:bookingId/started', requireAuth, requireRole('worker'), async (req: AuthRequest, res) => {
  const booking = await (prisma as any).booking.findFirst({
    where: { id: req.params.bookingId, workerId: req.auth!.userId }
  });
  if (!booking) return res.status(404).json({ message: 'Booking not found' });
  if (!['accepted', 'on_the_way'].includes(booking.status)) {
    return res.status(400).json({ message: 'Only accepted or on-the-way bookings can be started' });
  }
  const updated = await (prisma as any).booking.update({
    where: { id: booking.id },
    data: { status: 'started', startedAt: new Date(), etaMinutes: 0 }
  });
  return res.json({ booking: serializeBooking(updated) });
});

router.post('/:bookingId/start', requireAuth, requireRole('worker'), async (req: AuthRequest, res) => {
  const booking = await (prisma as any).booking.findFirst({
    where: { id: req.params.bookingId, workerId: req.auth!.userId }
  });
  if (!booking) return res.status(404).json({ message: 'Booking not found' });
  if (!['accepted', 'on_the_way'].includes(booking.status)) {
    return res.status(400).json({ message: 'Only accepted or on-the-way bookings can be started' });
  }
  const updated = await (prisma as any).booking.update({
    where: { id: booking.id },
    data: { status: 'started', startedAt: new Date(), etaMinutes: 0 }
  });
  return res.json({ booking: serializeBooking(updated) });
});

router.post('/:bookingId/complete', requireAuth, requireRole('worker'), async (req: AuthRequest, res) => {
  const booking: any = await prisma.booking.findFirst({
    where: { id: req.params.bookingId, workerId: req.auth!.userId }
  });
  if (!booking) return res.status(404).json({ message: 'Booking not found' });
  if (!['started', 'in_progress'].includes(booking.status)) {
    return res.status(400).json({ message: 'Only started bookings can be completed' });
  }
  const updated = await (prisma as any).booking.update({
    where: { id: booking.id },
    data: {
      status: 'completed',
      completedAt: new Date(),
      etaMinutes: 0,
      ...(booking.paymentMethod === 'cash' ? { paymentStatus: 'paid' } : {})
    }
  });
  return res.json({ booking: serializeBooking(updated) });
});

router.post('/:bookingId/eta', requireAuth, requireRole('worker'), async (req: AuthRequest, res) => {
  const parsed = etaSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid ETA payload', errors: parsed.error.flatten() });
  }
  const booking = await (prisma as any).booking.findFirst({
    where: { id: req.params.bookingId, workerId: req.auth!.userId }
  });
  if (!booking) return res.status(404).json({ message: 'Booking not found' });
  if (!['accepted', 'on_the_way'].includes(booking.status)) {
    return res.status(400).json({ message: 'ETA can be updated only for accepted or on-the-way bookings' });
  }
  const updated = await (prisma as any).booking.update({
    where: { id: booking.id },
    data: { etaMinutes: parsed.data.etaMinutes }
  });
  return res.json({ booking: serializeBooking(updated) });
});

router.post('/:bookingId/live-location', requireAuth, requireRole('worker'), async (req: AuthRequest, res) => {
  const parsed = liveLocationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid live location payload', errors: parsed.error.flatten() });
  }

  const booking = await (prisma as any).booking.findFirst({
    where: { id: req.params.bookingId, workerId: req.auth!.userId }
  });
  if (!booking) return res.status(404).json({ message: 'Booking not found' });
  if (!['accepted', 'on_the_way', 'started', 'in_progress'].includes(String(booking.status))) {
    return res.status(400).json({ message: 'Live location can be updated only for active bookings' });
  }

  const updated = await (prisma as any).booking.update({
    where: { id: booking.id },
    data: {
      workerLiveLat: parsed.data.lat,
      workerLiveLng: parsed.data.lng,
      workerLiveUpdatedAt: new Date()
    }
  });
  return res.json({ booking: serializeBooking(updated) });
});

router.post('/:bookingId/reschedule', requireAuth, requireRole('customer'), async (req: AuthRequest, res) => {
  const parsed = rescheduleSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid reschedule payload', errors: parsed.error.flatten() });
  }

  const booking = await (prisma as any).booking.findFirst({
    where: { id: req.params.bookingId, customerId: req.auth!.userId }
  });
  if (!booking) return res.status(404).json({ message: 'Booking not found' });
  if (!['pending', 'accepted', 'on_the_way'].includes(booking.status)) {
    return res.status(400).json({ message: 'Booking cannot be rescheduled at this stage' });
  }

  const currentServiceTime = new Date(booking.dateTime).getTime();
  const now = Date.now();
  const remainingHours = (currentServiceTime - now) / (1000 * 60 * 60);
  if (remainingHours < CANCELLATION_POLICY.freeCancellationWindowHours) {
    return res.status(400).json({ message: 'Reschedule window closed. Contact support.' });
  }
  if ((booking.rescheduleCount ?? 0) >= CANCELLATION_POLICY.maxReschedules) {
    return res.status(400).json({ message: 'Maximum reschedules reached for this booking' });
  }

  const nextDate = new Date(parsed.data.dateTime);
  if (Number.isNaN(nextDate.getTime()) || nextDate.getTime() <= now) {
    return res.status(400).json({ message: 'Please select a future date and time' });
  }

  const updated = await (prisma as any).booking.update({
    where: { id: booking.id },
    data: {
      dateTime: nextDate,
      status: 'accepted',
      etaMinutes: 0,
      onTheWayAt: null,
      startedAt: null,
      rescheduleCount: (booking.rescheduleCount ?? 0) + 1,
      lastRescheduledAt: new Date(),
      cancellationReason: parsed.data.reason?.trim() || ''
    }
  });
  return res.json({ booking: serializeBooking(updated) });
});

router.post('/:bookingId/cancel', requireAuth, requireRole('customer'), async (req: AuthRequest, res) => {
  const booking = await (prisma as any).booking.findFirst({
    where: { id: req.params.bookingId, customerId: req.auth!.userId }
  });
  if (!booking) return res.status(404).json({ message: 'Booking not found' });
  if (!['pending', 'accepted', 'on_the_way'].includes(booking.status)) {
    return res.status(400).json({ message: 'Booking cannot be cancelled at this stage' });
  }
  const serviceTime = new Date(booking.dateTime).getTime();
  const now = Date.now();
  const remainingHours = (serviceTime - now) / (1000 * 60 * 60);
  if (booking.status !== 'pending' && remainingHours < CANCELLATION_POLICY.freeCancellationWindowHours) {
    return res.status(400).json({ message: 'Cancellation window closed. Contact support.' });
  }

  const updated = await (prisma as any).booking.update({
    where: { id: booking.id },
    data: {
      status: 'cancelled',
      cancelledAt: new Date(),
      cancellationReason: 'Cancelled by customer'
    }
  });
  return res.json({ booking: serializeBooking(updated) });
});

router.get('/policy', (_req, res) => {
  return res.json({ policy: CANCELLATION_POLICY });
});

export default router;
