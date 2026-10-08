import { Router, type Request, type Response } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import type { RouteDeps } from '../deps';
import { MonotonicStore } from '../monotonicStore';
import { decoyHash, MAX_PASSWORD_LENGTH, passwordProblem, verifyPassword } from '../passwords';
import { clearSessionCookie, sessionToken, setSessionCookie, type Session, type SessionUser } from '../sessions';
import { findUser, findUserByName, recordSignIn, setOwnPassword } from '../users';

/**
 * Failed sign-ins one address, and one username from anywhere, may make in 15 minutes. Only failures
 * count, as with the wrong-token limit (deviceAuth.ts); past either limit even the right password is
 * refused, so a 429 never tells a guesser which guess was right. Ten tries an account a quarter hour
 * is under a thousand a day, against a password of 8 characters or more; an office behind one NAT
 * has room for thirty slips.
 */
export const SIGN_IN_FAILURES_PER_ADDRESS = 30;
export const SIGN_IN_FAILURES_PER_USERNAME = 10;
const SIGN_IN_WINDOW_MS = 15 * 60 * 1000;

const WRONG = { error: 'Wrong username or password' };

/** What the browser is told about who is signed in. */
const whoIs = ({ id, username, role, mustChangePassword }: SessionUser) => ({ user: { id, username, role }, mustChangePassword });

/**
 * Signing in and out (docs/adr/0010):
 *
 * - POST /api/session `{username, password}` signs in: a session cookie, and who is signed in. Any
 *   failure, an unknown name, a wrong password, a disabled user, says only "Wrong username or password".
 * - GET /api/session says who is signed in, 401 when no one is.
 * - DELETE /api/session signs out; the session's live streams close.
 * - POST /api/session/password `{currentPassword, newPassword}` changes the signed-in user's own
 *   password, their other sessions ending. The one change a user still on `admin`'s first password
 *   may make.
 */
export function sessionRouter({ pool, sessions, now = () => new Date() }: RouteDeps): Router {
  const router = Router();
  const byAddress = new MonotonicStore();
  byAddress.init({ windowMs: SIGN_IN_WINDOW_MS });
  const byUsername = new MonotonicStore();
  byUsername.init({ windowMs: SIGN_IN_WINDOW_MS });
  const addressKey = (req: Request): string => ipKeyGenerator(req.ip ?? '');
  const usernameKey = (username: string): string => username.trim().toLowerCase().slice(0, 64);

  /** A 429 when the address or the username has used its failures up, with when to try again. */
  const refuseLockedOut = (req: Request, res: Response, username: string): boolean => {
    const counts = [
      { info: byAddress.get(addressKey(req)), max: SIGN_IN_FAILURES_PER_ADDRESS },
      { info: byUsername.get(usernameKey(username)), max: SIGN_IN_FAILURES_PER_USERNAME },
    ].filter(({ info, max }) => info !== undefined && info.totalHits >= max);
    if (counts.length === 0) return false;
    const resetAt = Math.max(...counts.map(({ info }) => info?.resetTime?.getTime() ?? Date.now()));
    const seconds = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
    res.set('Retry-After', String(seconds));
    res.status(429).json({ error: `Too many failed sign-ins. Try again in ${Math.ceil(seconds / 60)} min.` });
    return true;
  };
  const countFailure = (req: Request, username: string) => {
    byAddress.increment(addressKey(req));
    byUsername.increment(usernameKey(username));
  };

  /** The session this request's cookie names, live, or undefined. */
  const current = async (req: Request): Promise<Session | undefined> => {
    const token = sessionToken(req);
    return token === undefined ? undefined : sessions.find(token);
  };

  router.post('/', async (req, res, next) => {
    const { username, password } = (req.body ?? {}) as Record<string, unknown>;
    // express.json reads only application/json, so a form posted from another site arrives with no body.
    if (typeof username !== 'string' || typeof password !== 'string' || username.trim() === '' || password === '') {
      res.status(400).json({ error: 'Give a username and a password' });
      return;
    }
    try {
      if (refuseLockedOut(req, res, username)) return;
      const user = password.length > MAX_PASSWORD_LENGTH ? undefined : await findUserByName(pool, username.trim());
      // A missing or disabled user is checked against a decoy hash, so the time taken says nothing about who exists.
      const matches = password.length <= MAX_PASSWORD_LENGTH && (await verifyPassword(password, user?.passwordHash ?? (await decoyHash())));
      if (user === undefined || user.disabled || !matches) {
        countFailure(req, username);
        res.status(401).json(WRONG);
        return;
      }
      // Signing in again replaces the session this browser held, rather than leaving it live behind the new one.
      const previous = await current(req);
      if (previous !== undefined) await sessions.end(previous.id);
      const token = await sessions.start(user.id);
      await recordSignIn(pool, user.id, now());
      setSessionCookie(req, res, token);
      res.json(whoIs(user));
    } catch (error) {
      next(error);
    }
  });

  router.get('/', async (req, res, next) => {
    try {
      const session = await current(req);
      if (session === undefined) {
        res.status(401).json({ error: 'Not signed in' });
        return;
      }
      res.json(whoIs(session.user));
    } catch (error) {
      next(error);
    }
  });

  router.delete('/', async (req, res, next) => {
    try {
      const session = await current(req);
      if (session !== undefined) await sessions.end(session.id);
      clearSessionCookie(req, res);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.post('/password', async (req, res, next) => {
    const { currentPassword, newPassword } = (req.body ?? {}) as Record<string, unknown>;
    try {
      const session = await current(req);
      if (session === undefined) {
        res.status(401).json({ error: 'Sign in first' });
        return;
      }
      const user = await findUser(pool, session.user.id);
      if (user === undefined) {
        res.status(401).json({ error: 'Sign in first' });
        return;
      }
      if (typeof currentPassword !== 'string' || currentPassword === '') {
        res.status(422).json({ error: 'Give your current password' });
        return;
      }
      // A stolen session guessing the password it would need goes against the user's sign-in limit.
      if (refuseLockedOut(req, res, user.username)) return;
      if (currentPassword.length > MAX_PASSWORD_LENGTH || !(await verifyPassword(currentPassword, user.passwordHash))) {
        countFailure(req, user.username);
        res.status(422).json({ error: 'Your current password is not right' });
        return;
      }
      const problem = passwordProblem(newPassword);
      if (problem !== undefined) {
        res.status(422).json({ error: problem });
        return;
      }
      await setOwnPassword(pool, user.id, newPassword as string);
      await sessions.endAllOf(user.id, session.id);
      res.json(whoIs({ ...session.user, mustChangePassword: false }));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
