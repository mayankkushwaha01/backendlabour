import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/db.js';
import { env } from '../../config/env.js';
import { requireAuth, type AuthRequest } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/role.js';

const router = Router();

const createLeadSchema = z.object({
  serviceName: z.string().min(2),
  description: z.string().min(5),
  address: z.string().min(3),
  budgetMin: z.number().min(0),
  budgetMax: z.number().min(0),
  preferredDateTime: z.string().datetime().optional()
});

const quoteSchema = z.object({
  amount: z.number().min(0),
  message: z.string().max(500).optional(),
  etaHours: z.number().int().min(1).max(720).optional()
});
const leadMessageSchema = z.object({
  receiverId: z.string().min(3).optional(),
  message: z.string().min(1).max(1000)
});

const normalizeDigits = (value: string | undefined | null) => (value ?? '').replace(/\D/g, '');
const maskPhone = (value: string | undefined | null) => {
  const digits = normalizeDigits(value);
  if (digits.length < 6) return '******';
  return `${digits.slice(0, 2)}******${digits.slice(-2)}`;
};

const getLeadForAccess = async (leadId: string) =>
  (prisma as any).lead.findUnique({
    where: { id: leadId },
    include: { quotes: true, customer: true, selectedWorker: true }
  });

router.post('/', requireAuth, requireRole('customer'), async (req: AuthRequest, res) => {
  const parsed = createLeadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid lead payload', errors: parsed.error.flatten() });
  }
  if (parsed.data.budgetMin > parsed.data.budgetMax) {
    return res.status(400).json({ message: 'budgetMin cannot be greater than budgetMax' });
  }

  const lead = await (prisma as any).lead.create({
    data: {
      customerId: req.auth!.userId,
      serviceName: parsed.data.serviceName.trim(),
      description: parsed.data.description.trim(),
      address: parsed.data.address.trim(),
      budgetMin: parsed.data.budgetMin,
      budgetMax: parsed.data.budgetMax,
      preferredDateTime: parsed.data.preferredDateTime ? new Date(parsed.data.preferredDateTime) : null
    }
  });

  return res.status(201).json({
    lead: {
      id: lead.id,
      serviceName: lead.serviceName,
      description: lead.description,
      address: lead.address,
      budgetMin: lead.budgetMin,
      budgetMax: lead.budgetMax,
      preferredDateTime: lead.preferredDateTime ? new Date(lead.preferredDateTime).toISOString() : null,
      status: lead.status,
      createdAt: new Date(lead.createdAt).toISOString()
    }
  });
});

router.get('/my', requireAuth, requireRole('customer'), async (req: AuthRequest, res) => {
  const leads = await (prisma as any).lead.findMany({
    where: { customerId: req.auth!.userId },
    include: {
      customer: true,
      quotes: {
        include: {
          worker: {
            include: { workerProfile: true }
          }
        },
        orderBy: { amount: 'asc' }
      }
    },
    orderBy: { createdAt: 'desc' }
  });

  return res.json({
    leads: (leads as any[]).map((lead) => ({
      id: lead.id,
      serviceName: lead.serviceName,
      description: lead.description,
      address: lead.address,
      customerName: lead.customer?.name || 'Customer',
      budgetMin: lead.budgetMin,
      budgetMax: lead.budgetMax,
      preferredDateTime: lead.preferredDateTime ? new Date(lead.preferredDateTime).toISOString() : null,
      status: lead.status,
      selectedWorkerId: lead.selectedWorkerId || null,
      selectedQuoteId: lead.selectedQuoteId || null,
      createdAt: new Date(lead.createdAt).toISOString(),
      quotes: (lead.quotes ?? []).map((quote: any) => ({
        id: quote.id,
        workerId: quote.workerId,
        workerName: quote.worker?.name || 'Worker',
        workerRating: quote.worker?.workerProfile?.rating ?? 0,
        isVerifiedPlus: Boolean(quote.worker?.isVerifiedPlus),
        amount: quote.amount,
        message: quote.message,
        etaHours: quote.etaHours,
        status: quote.status,
        createdAt: new Date(quote.createdAt).toISOString()
      }))
    }))
  });
});

router.get('/open', requireAuth, requireRole('worker'), async (req: AuthRequest, res) => {
  const workerId = req.auth!.userId;
  const leads = await (prisma as any).lead.findMany({
    where: { status: 'open' },
    include: {
      customer: true,
      quotes: true
    },
    orderBy: { createdAt: 'desc' }
  });

  return res.json({
    leads: (leads as any[])
      .filter((lead) => lead.customerId !== workerId)
      .map((lead) => {
        const ownQuote = (lead.quotes ?? []).find((q: any) => q.workerId === workerId) ?? null;
        return {
          id: lead.id,
          serviceName: lead.serviceName,
          description: lead.description,
          address: lead.address,
          budgetMin: lead.budgetMin,
          budgetMax: lead.budgetMax,
          preferredDateTime: lead.preferredDateTime ? new Date(lead.preferredDateTime).toISOString() : null,
          status: lead.status,
          customerName: lead.customer?.name || 'Customer',
          quotesCount: (lead.quotes ?? []).length,
          ownQuote: ownQuote
            ? {
                id: ownQuote.id,
                amount: ownQuote.amount,
                message: ownQuote.message,
                etaHours: ownQuote.etaHours,
                status: ownQuote.status
              }
            : null,
          createdAt: new Date(lead.createdAt).toISOString()
        };
      })
  });
});

router.get('/my/quotes', requireAuth, requireRole('worker'), async (req: AuthRequest, res) => {
  const quotes = await (prisma as any).leadQuote.findMany({
    where: { workerId: req.auth!.userId },
    include: {
      lead: true
    },
    orderBy: { createdAt: 'desc' }
  });

  return res.json({
    quotes: (quotes as any[]).map((quote) => ({
      id: quote.id,
      leadId: quote.leadId,
      amount: quote.amount,
      message: quote.message,
      etaHours: quote.etaHours,
      status: quote.status,
      createdAt: new Date(quote.createdAt).toISOString(),
      lead: quote.lead
        ? {
            id: quote.lead.id,
            serviceName: quote.lead.serviceName,
            description: quote.lead.description,
            address: quote.lead.address,
            budgetMin: quote.lead.budgetMin,
            budgetMax: quote.lead.budgetMax,
            status: quote.lead.status
          }
        : null
    }))
  });
});

router.post('/:leadId/quotes', requireAuth, requireRole('worker'), async (req: AuthRequest, res) => {
  const parsed = quoteSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid quote payload', errors: parsed.error.flatten() });
  }

  const lead = await (prisma as any).lead.findUnique({ where: { id: req.params.leadId } });
  if (!lead) return res.status(404).json({ message: 'Lead not found' });
  if (lead.status !== 'open') return res.status(400).json({ message: 'Lead is not open for quotes' });

  const quote = await (prisma as any).leadQuote.upsert({
    where: {
      leadId_workerId: {
        leadId: req.params.leadId,
        workerId: req.auth!.userId
      }
    },
    create: {
      leadId: req.params.leadId,
      workerId: req.auth!.userId,
      amount: parsed.data.amount,
      message: parsed.data.message?.trim() ?? '',
      etaHours: parsed.data.etaHours ?? 24
    },
    update: {
      amount: parsed.data.amount,
      message: parsed.data.message?.trim() ?? '',
      etaHours: parsed.data.etaHours ?? 24,
      status: 'sent'
    }
  });

  return res.json({
    quote: {
      id: quote.id,
      leadId: quote.leadId,
      workerId: quote.workerId,
      amount: quote.amount,
      message: quote.message,
      etaHours: quote.etaHours,
      status: quote.status
    }
  });
});

router.post('/:leadId/quick-quote', requireAuth, requireRole('worker'), async (req: AuthRequest, res) => {
  const lead = await (prisma as any).lead.findUnique({ where: { id: req.params.leadId } });
  if (!lead) return res.status(404).json({ message: 'Lead not found' });
  if (lead.status !== 'open') return res.status(400).json({ message: 'Lead is not open for quotes' });

  const amount = Math.max(lead.budgetMin, Math.round((lead.budgetMin + lead.budgetMax) / 2));
  const quote = await (prisma as any).leadQuote.upsert({
    where: {
      leadId_workerId: {
        leadId: req.params.leadId,
        workerId: req.auth!.userId
      }
    },
    create: {
      leadId: req.params.leadId,
      workerId: req.auth!.userId,
      amount,
      message: 'Quick quote',
      etaHours: 24
    },
    update: {
      amount,
      message: 'Quick quote',
      etaHours: 24,
      status: 'sent'
    }
  });

  return res.json({
    quote: {
      id: quote.id,
      leadId: quote.leadId,
      workerId: quote.workerId,
      amount: quote.amount,
      message: quote.message,
      etaHours: quote.etaHours,
      status: quote.status
    }
  });
});

router.post('/:leadId/hire/:quoteId', requireAuth, requireRole('customer'), async (req: AuthRequest, res) => {
  const lead = await (prisma as any).lead.findUnique({
    where: { id: req.params.leadId },
    include: { quotes: true }
  });
  if (!lead) return res.status(404).json({ message: 'Lead not found' });
  if (lead.customerId !== req.auth!.userId) return res.status(403).json({ message: 'Not allowed' });
  if (lead.status !== 'open') return res.status(400).json({ message: 'Lead is already closed' });

  const selected = (lead.quotes ?? []).find((q: any) => q.id === req.params.quoteId);
  if (!selected) return res.status(404).json({ message: 'Quote not found on this lead' });

  await (prisma as any).$transaction([
    (prisma as any).lead.update({
      where: { id: req.params.leadId },
      data: {
        status: 'hired',
        selectedWorkerId: selected.workerId,
        selectedQuoteId: selected.id
      }
    }),
    (prisma as any).leadQuote.updateMany({
      where: { leadId: req.params.leadId, id: selected.id },
      data: { status: 'selected' }
    }),
    (prisma as any).leadQuote.updateMany({
      where: { leadId: req.params.leadId, id: { not: selected.id } },
      data: { status: 'rejected' }
    })
  ]);

  return res.json({
    message: 'Worker hired successfully',
    selection: {
      leadId: req.params.leadId,
      quoteId: selected.id,
      workerId: selected.workerId
    }
  });
});

router.get('/:leadId/messages', requireAuth, async (req: AuthRequest, res) => {
  const lead = await getLeadForAccess(req.params.leadId);
  if (!lead) return res.status(404).json({ message: 'Lead not found' });

  const userId = req.auth!.userId;
  const isCustomer = req.auth!.role === 'customer' && lead.customerId === userId;
  const isWorker = req.auth!.role === 'worker' && (
    lead.selectedWorkerId === userId ||
    (lead.quotes ?? []).some((q: any) => q.workerId === userId)
  );
  if (!isCustomer && !isWorker) return res.status(403).json({ message: 'Not allowed' });

  let peerId = '';
  const workerIdQuery = typeof req.query.workerId === 'string' ? req.query.workerId : '';
  if (isCustomer) {
    peerId =
      workerIdQuery ||
      lead.selectedWorkerId ||
      (lead.quotes ?? [])[0]?.workerId ||
      '';
    if (!peerId) return res.json({ messages: [], peerId: null });
    const isQuotedWorker = (lead.quotes ?? []).some((q: any) => q.workerId === peerId);
    if (!isQuotedWorker && lead.selectedWorkerId !== peerId) {
      return res.status(400).json({ message: 'Worker is not part of this lead' });
    }
  } else {
    peerId = lead.customerId;
  }

  const messages = await (prisma as any).leadMessage.findMany({
    where: {
      leadId: req.params.leadId,
      OR: [
        { senderId: userId, receiverId: peerId },
        { senderId: peerId, receiverId: userId }
      ]
    },
    orderBy: { createdAt: 'asc' }
  });

  return res.json({
    peerId,
    messages: (messages as any[]).map((m) => ({
      id: m.id,
      leadId: m.leadId,
      senderId: m.senderId,
      receiverId: m.receiverId,
      message: m.message,
      createdAt: new Date(m.createdAt).toISOString()
    }))
  });
});

router.post('/:leadId/messages', requireAuth, async (req: AuthRequest, res) => {
  const parsed = leadMessageSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid message payload', errors: parsed.error.flatten() });
  }

  const lead = await getLeadForAccess(req.params.leadId);
  if (!lead) return res.status(404).json({ message: 'Lead not found' });

  const userId = req.auth!.userId;
  const isCustomer = req.auth!.role === 'customer' && lead.customerId === userId;
  const isWorker = req.auth!.role === 'worker' && (
    lead.selectedWorkerId === userId ||
    (lead.quotes ?? []).some((q: any) => q.workerId === userId)
  );
  if (!isCustomer && !isWorker) return res.status(403).json({ message: 'Not allowed' });

  let receiverId = '';
  if (isCustomer) {
    receiverId =
      parsed.data.receiverId ||
      lead.selectedWorkerId ||
      (lead.quotes ?? [])[0]?.workerId ||
      '';
    if (!receiverId) return res.status(400).json({ message: 'No worker available for chat in this lead' });
    const isQuotedWorker = (lead.quotes ?? []).some((q: any) => q.workerId === receiverId);
    if (!isQuotedWorker && lead.selectedWorkerId !== receiverId) {
      return res.status(400).json({ message: 'Worker is not part of this lead' });
    }
  } else {
    receiverId = lead.customerId;
  }

  const message = await (prisma as any).leadMessage.create({
    data: {
      leadId: req.params.leadId,
      senderId: userId,
      receiverId,
      message: parsed.data.message.trim()
    }
  });

  return res.status(201).json({
    message: {
      id: message.id,
      leadId: message.leadId,
      senderId: message.senderId,
      receiverId: message.receiverId,
      message: message.message,
      createdAt: new Date(message.createdAt).toISOString()
    }
  });
});

router.get('/:leadId/contact', requireAuth, async (req: AuthRequest, res) => {
  const lead = await getLeadForAccess(req.params.leadId);
  if (!lead) return res.status(404).json({ message: 'Lead not found' });

  const userId = req.auth!.userId;
  const isCustomer = req.auth!.role === 'customer' && lead.customerId === userId;
  const isWorker = req.auth!.role === 'worker' && (
    lead.selectedWorkerId === userId ||
    (lead.quotes ?? []).some((q: any) => q.workerId === userId)
  );
  if (!isCustomer && !isWorker) return res.status(403).json({ message: 'Not allowed' });

  let partnerId = '';
  if (isCustomer) {
    const workerIdQuery = typeof req.query.workerId === 'string' ? req.query.workerId : '';
    partnerId =
      workerIdQuery ||
      lead.selectedWorkerId ||
      (lead.quotes ?? [])[0]?.workerId ||
      '';
    if (!partnerId) return res.status(400).json({ message: 'No worker found for this lead' });
  } else {
    partnerId = lead.customerId;
  }

  const [selfUser, partnerUser] = await Promise.all([
    (prisma as any).user.findUnique({ where: { id: userId } }),
    (prisma as any).user.findUnique({ where: { id: partnerId } })
  ]);
  if (!selfUser || !partnerUser) return res.status(404).json({ message: 'Users not found' });

  const proxyPhone = normalizeDigits(env.supportProxyPhone || '9999999999') || '9999999999';
  const roleLabel = isCustomer ? 'customer' : 'worker';
  const waMessage = `LabourHub lead ${lead.id} ${roleLabel} ${selfUser.name} wants to connect with ${partnerUser.name}.`;
  const whatsappUrl = `https://wa.me/${proxyPhone}?text=${encodeURIComponent(waMessage)}`;

  return res.json({
    leadId: lead.id,
    proxyPhone,
    callUrl: `tel:${proxyPhone}`,
    whatsappUrl,
    self: {
      id: selfUser.id,
      name: selfUser.name,
      phoneMasked: maskPhone(selfUser.phone)
    },
    partner: {
      id: partnerUser.id,
      name: partnerUser.name,
      phoneMasked: maskPhone(partnerUser.phone)
    },
    note: 'Masked privacy contact enabled. Use proxy call or WhatsApp.'
  });
});

export default router;
