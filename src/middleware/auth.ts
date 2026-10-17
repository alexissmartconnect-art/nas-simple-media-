import type { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { getSessionUser } from '../auth/session';
import type { SessionUser } from '../db/schema';

export type AuthedRequest = Request & { user: SessionUser };

export const PASSWORD_CHANGE_REQUIRED = 'PASSWORD_CHANGE_REQUIRED';

/** Routes still reachable while the account must replace the factory password. */
const ALLOWED_WHILE_MUST_CHANGE = new Set(['/api/me', '/api/me/password', '/api/logout']);

/**
 * Server-side enforcement of the forced password change: while the session's
 * account still uses the default password, every authenticated API answers
 * 403 { code: PASSWORD_CHANGE_REQUIRED } except the routes above.
 * Returns true when the response has been sent.
 */
export function rejectIfPasswordChangeRequired(req: Request, res: Response, user: SessionUser): boolean {
  if (!user.must_change_password) return false;
  const pathname = (req.originalUrl || req.url || '').split('?')[0];
  if (ALLOWED_WHILE_MUST_CHANGE.has(pathname)) return false;
  res.status(403).json({
    error:
      'Changement de mot de passe obligatoire : ce compte utilise encore le mot de passe par défaut. ' +
      'Connectez-vous à l’interface web pour le changer.',
    code: PASSWORD_CHANGE_REQUIRED,
  });
  return true;
}

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
  if (rejectIfPasswordChangeRequired(req, res, user)) return;
  (req as AuthedRequest).user = user;
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = (req as AuthedRequest).user || getSessionUser(req.cookies?.[config.COOKIE_NAME]);
  if (!user || user.role !== 'admin') {
    res.status(403).json({ error: 'Admin requis' });
    return;
  }
  if (rejectIfPasswordChangeRequired(req, res, user)) return;
  (req as AuthedRequest).user = user;
  next();
}
