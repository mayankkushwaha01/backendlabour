import { Router } from 'express';
import { prisma } from '../../config/db.js';
import { requireAuth, type AuthRequest } from '../../middleware/auth.js';

const router = Router();

router.get('/', requireAuth, async (req: AuthRequest, res) => {
  const userId = req.auth!.userId;
  const [currentUser, approvedBusinesses, completedBookings, workerPendingBookings, leadAcceptedByWorkers, broadcasts] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, isApproved: true, updatedAt: true }
    }),
    (prisma as any).business.findMany({
      where: { vendorUserId: userId, isApproved: true },
      select: { id: true, name: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
      take: 50
    }),
    (prisma as any).booking.findMany({
      where: { customerId: userId, status: 'completed' },
      include: {
        worker: { select: { id: true, name: true } },
        service: { select: { id: true, name: true } }
      },
      orderBy: { completedAt: 'desc' },
      take: 50
    }),
    (prisma as any).booking.findMany({
      where: { workerId: userId, status: 'pending' },
      include: {
        customer: { select: { id: true, name: true } },
        service: { select: { id: true, name: true } }
      },
      orderBy: { createdAt: 'desc' },
      take: 50
    }),
    (prisma as any).lead.findMany({
      where: { customerId: userId },
      include: {
        quotes: {
          include: { worker: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'desc' },
          take: 3
        }
      },
      orderBy: { updatedAt: 'desc' },
      take: 40
    }),
    prisma.$queryRaw<Array<{ id: string; title: string; message: string; targetRole: string; createdAt: Date }>>`
      SELECT id, title, message, targetRole, createdAt
      FROM BroadcastNotification
      ORDER BY createdAt DESC
      LIMIT 80
    `
      .catch(() => [])
  ]);

  const businessNotifications = approvedBusinesses.map((business: any) => ({
    id: `business-approved-${business.id}`,
    type: 'business_approved',
    title: 'Business Approved',
    message: `${business.name} is now approved and visible to customers.`,
    createdAt: new Date(business.updatedAt).toISOString(),
    businessId: business.id
  }));

  const bookingNotifications = completedBookings
    .filter((booking: any) => booking.completedAt)
    .map((booking: any) => ({
      id: `booking-completed-${booking.id}`,
      type: 'booking_completed',
      title: 'Work Completed',
      message: `${booking.worker?.name ?? 'Worker'} completed your ${booking.service?.name ?? 'service'} booking.`,
      createdAt: new Date(booking.completedAt).toISOString(),
      bookingId: booking.id
    }));

  const workerBookingNotifications = workerPendingBookings.map((booking: any) => ({
    id: `worker-booking-${booking.id}`,
    type: 'worker_new_booking',
    title: 'New Booking Request',
    message: `${booking.customer?.name ?? 'Customer'} requested ${booking.service?.name ?? 'a service'}.`,
    createdAt: new Date(booking.createdAt).toISOString(),
    bookingId: booking.id
  }));

  const leadNotifications = (leadAcceptedByWorkers as any[]).flatMap((lead) =>
    (lead.quotes ?? []).map((quote: any) => ({
      id: `lead-worker-accepted-${lead.id}-${quote.id}`,
      type: 'lead_worker_accepted',
      title: 'Lead Accepted',
      message: `${quote.worker?.name ?? 'Worker'} accepted your lead for ${lead.serviceName}.`,
      createdAt: new Date(quote.createdAt).toISOString(),
      leadId: lead.id,
      workerId: quote.workerId
    }))
  );

  const workerApprovalNotifications =
    currentUser?.role === 'worker' && Boolean(currentUser.isApproved)
      ? [
          {
            id: `worker-approved-${currentUser.id}`,
            type: 'worker_approved',
            title: 'Profile Approved',
            message: 'Your worker profile has been approved. You can now receive and accept bookings.',
            createdAt: new Date(currentUser.updatedAt).toISOString()
          }
        ]
      : [];

  const broadcastNotifications = (broadcasts as any[])
    .filter((item) => {
      const target = String(item.targetRole ?? 'all').toLowerCase();
      if (target === 'all') return true;
      return target === String(currentUser?.role ?? '').toLowerCase();
    })
    .map((item) => ({
      id: `broadcast-${item.id}`,
      type: 'admin_broadcast',
      title: String(item.title || 'Labour Hub Update'),
      message: String(item.message || ''),
      createdAt: new Date(item.createdAt).toISOString()
    }));

  const notifications = [
    ...broadcastNotifications,
    ...workerApprovalNotifications,
    ...businessNotifications,
    ...bookingNotifications,
    ...workerBookingNotifications,
    ...leadNotifications
  ]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 50);

  return res.json({ notifications, userId });
});

export default router;
