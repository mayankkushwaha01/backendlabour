import type { NextFunction, Request, Response } from 'express';

export const errorHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) => {
  console.error(err);
  const anyErr = err as { status?: number; type?: string; message?: string };

  if (anyErr?.type === 'entity.too.large') {
    return res.status(413).json({ message: 'Uploaded file is too large. Please upload a smaller Aadhaar file.' });
  }

  if (typeof anyErr?.status === 'number' && anyErr.status >= 400 && anyErr.status < 500) {
    return res.status(anyErr.status).json({ message: anyErr.message ?? 'Request failed' });
  }

  return res.status(500).json({ message: 'Internal server error' });
};
