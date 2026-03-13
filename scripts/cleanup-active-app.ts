import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const asNum = (value: unknown) => (typeof value === 'number' ? value : 0);

const main = async () => {
  const execute = process.argv.includes('--execute');
  const now = new Date();

  const before = {
    users: await prisma.user.count(),
    workers: await prisma.user.count({ where: { role: 'worker' } }),
    businesses: await prisma.business.count(),
    businessPhotos: await prisma.businessPhoto.count(),
    businessServices: await prisma.businessService.count(),
    favoriteBusinesses: await prisma.favoriteBusiness.count(),
    businessReviews: await prisma.businessReview.count(),
    enquiries: await prisma.enquiry.count(),
    analyticsEvents: await prisma.analyticsEvent.count(),
    bookings: await prisma.booking.count(),
    services: await prisma.service.count(),
    leads: await prisma.lead.count(),
    leadQuotes: await prisma.leadQuote.count(),
    leadMessages: await prisma.leadMessage.count(),
    whatsappOtp: await prisma.whatsappOtp.count(),
    emailOtp: await prisma.emailOtp.count()
  };

  console.log('=== Active App DB Cleanup ===');
  console.log(`Mode: ${execute ? 'EXECUTE' : 'DRY-RUN'}`);
  console.table(before);

  const deletePlan = {
    analyticsEvents: before.analyticsEvents,
    enquiries: before.enquiries,
    businessReviews: before.businessReviews,
    favoriteBusinesses: before.favoriteBusinesses,
    businessServices: before.businessServices,
    businessPhotos: before.businessPhotos,
    businesses: before.businesses,
    leadMessages: before.leadMessages,
    leadQuotes: before.leadQuotes,
    leads: before.leads,
    expiredWhatsappOtp: await prisma.whatsappOtp.count({ where: { expiresAt: { lt: now } } }),
    expiredEmailOtp: await prisma.emailOtp.count({ where: { expiresAt: { lt: now } } })
  };

  console.log('Cleanup Plan (non-core / stale data):');
  console.table(deletePlan);

  if (!execute) {
    console.log('Dry-run complete. Run with --execute to apply cleanup.');
    return;
  }

  const result = await prisma.$transaction(async (tx) => {
    const removedAnalyticsEvents = await tx.analyticsEvent.deleteMany({});
    const removedEnquiries = await tx.enquiry.deleteMany({});
    const removedBusinessReviews = await tx.businessReview.deleteMany({});
    const removedFavoriteBusinesses = await tx.favoriteBusiness.deleteMany({});
    const removedBusinessServices = await tx.businessService.deleteMany({});
    const removedBusinessPhotos = await tx.businessPhoto.deleteMany({});
    const removedBusinesses = await tx.business.deleteMany({});
    const removedLeadMessages = await tx.leadMessage.deleteMany({});
    const removedLeadQuotes = await tx.leadQuote.deleteMany({});
    const removedLeads = await tx.lead.deleteMany({});
    const removedWhatsappOtp = await tx.whatsappOtp.deleteMany({ where: { expiresAt: { lt: now } } });
    const removedEmailOtp = await tx.emailOtp.deleteMany({ where: { expiresAt: { lt: now } } });

    return {
      removedAnalyticsEvents: asNum(removedAnalyticsEvents.count),
      removedEnquiries: asNum(removedEnquiries.count),
      removedBusinessReviews: asNum(removedBusinessReviews.count),
      removedFavoriteBusinesses: asNum(removedFavoriteBusinesses.count),
      removedBusinessServices: asNum(removedBusinessServices.count),
      removedBusinessPhotos: asNum(removedBusinessPhotos.count),
      removedBusinesses: asNum(removedBusinesses.count),
      removedLeadMessages: asNum(removedLeadMessages.count),
      removedLeadQuotes: asNum(removedLeadQuotes.count),
      removedLeads: asNum(removedLeads.count),
      removedWhatsappOtp: asNum(removedWhatsappOtp.count),
      removedEmailOtp: asNum(removedEmailOtp.count)
    };
  });

  const after = {
    users: await prisma.user.count(),
    workers: await prisma.user.count({ where: { role: 'worker' } }),
    businesses: await prisma.business.count(),
    businessPhotos: await prisma.businessPhoto.count(),
    businessServices: await prisma.businessService.count(),
    favoriteBusinesses: await prisma.favoriteBusiness.count(),
    businessReviews: await prisma.businessReview.count(),
    enquiries: await prisma.enquiry.count(),
    analyticsEvents: await prisma.analyticsEvent.count(),
    bookings: await prisma.booking.count(),
    services: await prisma.service.count(),
    leads: await prisma.lead.count(),
    leadQuotes: await prisma.leadQuote.count(),
    leadMessages: await prisma.leadMessage.count(),
    whatsappOtp: await prisma.whatsappOtp.count(),
    emailOtp: await prisma.emailOtp.count()
  };

  console.log('Deleted:');
  console.table(result);
  console.log('After Cleanup:');
  console.table(after);
};

main()
  .catch((err) => {
    console.error('Cleanup failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
