import type { Request, Response, NextFunction } from 'express';

const ADMIN_KEY = process.env.ADMIN_API_KEY;

export function adminAuth(_req: Request, res: Response, next: NextFunction): void {
  if (!ADMIN_KEY) {
    next();
    return;
  }
  const auth = _req.headers.authorization;
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
  if (token !== ADMIN_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}
