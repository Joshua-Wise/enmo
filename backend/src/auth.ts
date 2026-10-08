import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import type { Config } from './config';
import { sessionToken, type Session, type Sessions } from './sessions';

function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  return match?.[1]?.trim();
}

/**
 * The Device token from either form a board sends: `Bearer <token>` with Readings, or Basic
 * credentials `device:<token>` with the firmware check, whose library can only send Basic.
 */
function deviceCredential(header: string | undefined): string | undefined {
  const bearer = bearerToken(header);
  if (bearer !== undefined) return bearer;
  const basic = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header?.trim() ?? '');
  if (basic === null) return undefined;
  const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
  return decoded.startsWith('device:') ? decoded.slice('device:'.length) : undefined;
}

/** Every token is compared as a SHA-256 digest: the same length whatever was sent, so not even its length leaks. */
const digest = (token: string): Buffer => createHash('sha256').update(token).digest();

/** Stands in for an unset token, so a check does the same work either way. Nothing can match it. */
const NO_TOKEN = randomBytes(32);

const tokensMatch = (presented: Buffer, expected: Buffer): boolean => timingSafeEqual(presented, expected);

/** What lets a request through: the Admin token, which is no user, or a user's session. */
export type Credential = { kind: 'token' } | { kind: 'session'; session: Session };

/** The guards every route but Readings, the firmware check, health and sign-in stands behind (docs/adr/0010). */
export interface Auth {
  /** What the pages read: any signed-in user's session, or the Admin token. */
  signedIn: RequestHandler;
  /** Every change, and what only an Admin reads: an Admin's session, or the Admin token. */
  admin: RequestHandler;
}

/** The session a guard let through, if a session did (none for the Admin token). */
export const sessionOf = (res: Response): Session | undefined => res.locals.session as Session | undefined;

const isChange = (req: Request): boolean => !['GET', 'HEAD', 'OPTIONS'].includes(req.method);

/**
 * Cross-site request forgery: the cookie is SameSite=Strict, so another site's page cannot make the
 * browser send it; and a change made with it must be JSON (or the firmware upload's octet-stream),
 * which no HTML form can send and a script on another origin can send only after a CORS preflight
 * that cors.ts refuses. A change with the Admin token needs neither: a browser never adds that header.
 */
const sentAsData = (req: Request): boolean => /^application\/(json|octet-stream)\s*(;|$)/i.test(req.header('content-type') ?? '');

export function createAuth(config: Config, sessions: Sessions): Auth {
  const adminToken = digest(config.adminToken);

  /** Who is asking, or how to refuse them. Worked out once per request, however many guards ask. */
  const identify = async (req: Request, res: Response): Promise<Credential | { status: number; error: string }> => {
    if (res.locals.credential !== undefined) return res.locals.credential as Credential;
    let credential: Credential;
    const header = req.header('authorization');
    if (header !== undefined) {
      // Whatever else it carries, a request naming a token is judged on that token alone.
      const presented = bearerToken(header);
      if (presented === undefined || !tokensMatch(digest(presented), adminToken)) return { status: 401, error: 'Not authorised' };
      credential = { kind: 'token' };
    } else {
      const token = sessionToken(req);
      const session = token === undefined ? undefined : await sessions.find(token);
      if (session === undefined) return { status: 401, error: 'Sign in first' };
      if (isChange(req) && !sentAsData(req)) return { status: 415, error: 'Send changes as application/json' };
      credential = { kind: 'session', session };
      res.locals.session = session;
    }
    res.locals.credential = credential;
    return credential;
  };

  const guard =
    (allows: (credential: Credential) => { status: number; error: string } | undefined): RequestHandler =>
    async (req, res, next) => {
      try {
        const credential = await identify(req, res);
        const refusal = 'status' in credential ? credential : allows(credential);
        if (refusal !== undefined) {
          res.status(refusal.status).json({ error: refusal.error });
          return;
        }
        next();
      } catch (error) {
        next(error);
      }
    };

  const mustChooseFirst = { status: 403, error: 'Choose a new password first' };
  return {
    signedIn: guard((credential) => (credential.kind === 'session' && credential.session.user.mustChangePassword ? mustChooseFirst : undefined)),
    admin: guard((credential) => {
      if (credential.kind === 'token') return undefined;
      if (credential.session.user.mustChangePassword) return mustChooseFirst;
      return credential.session.user.role === 'admin' ? undefined : { status: 403, error: 'Only an Admin can change this' };
    }),
  };
}

/** Which Device token a request carries: the current one, the one a rotation is retiring, or neither. */
export type DeviceTokenMatch = 'current' | 'previous' | undefined;

/**
 * Checks a request against both Device tokens. Both comparisons always run, in constant time, and
 * their results are combined without a branch, so the time taken never says which one matched.
 */
export function deviceTokenMatcher(config: Config): (req: Request) => DeviceTokenMatch {
  const current = digest(config.deviceToken);
  const previous = config.deviceTokenPrevious === undefined ? NO_TOKEN : digest(config.deviceTokenPrevious);
  return (req) => {
    const token = deviceCredential(req.header('authorization'));
    if (token === undefined) return undefined;
    const presented = digest(token);
    const which = Number(tokensMatch(presented, current)) | (Number(tokensMatch(presented, previous)) << 1);
    return which === 0 ? undefined : which === 1 ? 'current' : 'previous';
  };
}

/** What the Device token check found, for the route behind it (requireDeviceToken). */
export const deviceTokenOf = (res: Response): Exclude<DeviceTokenMatch, undefined> => res.locals.deviceToken as 'current' | 'previous';

/** Guards the Reading ingest route: the Device token, or during a rotation the previous one too. */
export const requireDeviceToken = (config: Config): RequestHandler => {
  const match = deviceTokenMatcher(config);
  return (req, res, next) => {
    const which = match(req);
    if (which === undefined) {
      res.status(401).json({ error: 'Not authorised' });
      return;
    }
    res.locals.deviceToken = which;
    next();
  };
};

/** Whether a request carries a Device token (either, during a rotation), for the ingest route's refusal limit. */
export const hasDeviceToken = (config: Config): ((req: Request) => boolean) => {
  const match = deviceTokenMatcher(config);
  return (req) => match(req) !== undefined;
};
