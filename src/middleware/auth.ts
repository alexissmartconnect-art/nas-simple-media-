import type { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { getSessionUser } from '../auth/session';
import type { SessionUser } from '../db/schema';

export type AuthedRequest = Request & { user: SessionUser };

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const user = getSessionUser(req.cookies?.[config.COOKIE_NAME] as string | undefined);
  if (!user) {
    if (req.path.startsWith('/api/') || req.originalUrl.startsWith('/api/')) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    res.redirect('/login.html');
    return;
  }
  (req as AuthedRequest).user = user;
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = (req as AuthedRequest).user || getSessionUser(req.cookies?.[config.COOKIE_NAME]);
  if (!user || user.role !== 'admin') {
    res.status(403).json({ error: 'Admin requis' });
    return;
  }
  (req as AuthedRequest).user = user;
  next();
}
