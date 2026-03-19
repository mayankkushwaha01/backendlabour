import express from 'express';
import compression from 'compression';
import cors from 'cors';
import authRoutes from './modules/auth/routes.js';
import serviceRoutes from './modules/services/routes.js';
import workerRoutes from './modules/workers/routes.js';
import bookingRoutes from './modules/bookings/routes.js';
import reviewRoutes from './modules/reviews/routes.js';
import userRoutes from './modules/users/routes.js';
import adminRoutes from './modules/admin/dashboard/routes.js';
import paymentRoutes from './modules/payments/routes.js';
import notificationRoutes from './modules/notifications/routes.js';
import complaintRoutes from './modules/complaints/routes.js';
import couponRoutes from './modules/coupons/routes.js';
import pricingRoutes from './modules/pricing/routes.js';
import homeBannerRoutes from './modules/home-banners/routes.js';
import { errorHandler } from './middleware/error-handler.js';
import { env } from './config/env.js';

export const app = express();

app.disable('x-powered-by');
app.use(compression());
const normalizeOrigin = (value: string) => value.trim().replace(/\/$/, '').toLowerCase();
const allowedOrigins = new Set(env.corsOrigins.map(normalizeOrigin));
const isLocalhostOrigin = (origin: string) => {
  try {
    const url = new URL(origin);
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  } catch {
    return false;
  }
};

if (env.corsOrigins.length === 0) {
  app.use(cors());
} else {
  app.use(cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.has(normalizeOrigin(origin)) || isLocalhostOrigin(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error('CORS origin not allowed'));
    }
  }));
}

app.use(express.json({ limit: '5mb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/auth', authRoutes);
app.use('/services', serviceRoutes);
app.use('/workers', workerRoutes);
app.use('/bookings', bookingRoutes);
app.use('/reviews', reviewRoutes);
app.use('/users', userRoutes);
app.use('/admin', adminRoutes);
app.use('/payments', paymentRoutes);
app.use('/notifications', notificationRoutes);
app.use('/complaints', complaintRoutes);
app.use('/coupons', couponRoutes);
app.use('/pricing', pricingRoutes);
app.use('/home-banners', homeBannerRoutes);

app.use(errorHandler);
