export type UserRole = 'customer' | 'worker' | 'admin';

export interface User {
  id: string;
  name: string;
  email: string;
  phone: string;
  phoneVerified: boolean;
  passwordHash: string;
  role: UserRole;
  isApproved: boolean;
  createdAt: string;
}

export interface WorkerProfile {
  userId: string;
  photoUrl: string;
  skills: string[];
  serviceAreas?: string[];
  portfolioUrls?: string[];
  responseTimeMins?: number;
  workingHours?: string;
  experienceYears: number;
  bio: string;
  aadhaarNumberMasked?: string;
  aadhaarCardUrl?: string;
  pricePerHour: number;
  rating: number;
  totalJobs: number;
}

export interface Service {
  id: string;
  name: 'mason' | 'carpenter' | 'plumber' | 'labour';
  basePrice: number;
}

export type BookingStatus = 'pending' | 'accepted' | 'rejected' | 'in_progress' | 'completed' | 'cancelled';
export type PaymentMethod = 'online' | 'cash';
export type PaymentStatus = 'unpaid' | 'paid' | 'failed' | 'refunded';

export interface Booking {
  id: string;
  customerId: string;
  workerId: string;
  serviceId: string;
  address: string;
  dateTime: string;
  hours: number;
  totalAmount: number;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  status: BookingStatus;
  createdAt: string;
}

export interface Review {
  id: string;
  bookingId: string;
  customerId: string;
  workerId: string;
  rating: number;
  comment: string;
  createdAt: string;
}
