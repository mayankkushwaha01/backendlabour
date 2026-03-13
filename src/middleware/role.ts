import type { NextFunction, Response } from 'express';
import type { AuthRequest } from './auth.js';
import type { UserRole } from '../types/domain.js';

export const requireRole = (...roles: UserRole[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    return next();
  };
};
