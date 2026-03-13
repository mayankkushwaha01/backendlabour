import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import type { UserRole } from '../types/domain.js';

export interface AuthRequest extends Request {
  auth?: {
    userId: string;
    role: UserRole;
  };
}

export const requireAuth = (req: AuthRequest, res: Response, next: NextFunction) => {
  const raw = req.headers.authorization;
  if (!raw || !raw.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Missing or invalid token' });
  }

  const token = raw.replace('Bearer ', '');
  try {
    const payload = jwt.verify(token, env.jwtSecret) as { sub: string; role: UserRole };
    req.auth = { userId: payload.sub, role: payload.role };
    return next();
  } catch {
    return res.status(401).json({ message: 'Token verification failed' });
  }
};
