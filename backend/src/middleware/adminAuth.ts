import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual, createHash } from 'crypto';

const ADMIN_KEY = process.env.ADMIN_API_KEY;

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function adminAuth(_req: Request, res: Response, next: NextFunction): void {
  if (!ADMIN_KEY) {
    if (process.env.NODE_ENV === 'production') {
      console.warn('[AdminAuth] WARNING: ADMIN_API_KEY is not set — admin endpoints are unprotected!');
    }
    next();
    return;
  }
  const auth = _req.headers.authorization;
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
  if (!timingSafeEqual(sha256(token ?? ''), sha256(ADMIN_KEY))) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}
