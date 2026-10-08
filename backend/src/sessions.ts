/**
 * Sessions (docs/adr/0010): what a signed-in browser carries instead of a token. The cookie holds a
 * random id; the database holds its SHA-256 and whose it is, so signing out, disabling a user, or a
 * new password ends a session at once, on the next request, and closes the live streams it opened.
 * A session ends after 12 hours unused and 7 days at most, whatever its use. An open live stream
 * counts as use, so a wall display stays signed in until the 7 days are up.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { Broadcaster } from './sse';
import type { Role } from './users';

export const SESSION_COOKIE = 'ta_session';
export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
export const SESSION_MAX_MS = 7 * 24 * 60 * 60 * 1000;
/** How stale a session's last use may get before a request writes it again: one write a minute, not one a request. */
const TOUCH_AFTER_MS = 60_000;

/** The signed-in user as a request sees it, read fresh from the users table every time. */
export interface SessionUser {
  id: number;
  username: string;
  role: Role;
  /** Still on the password a fresh install starts with: nothing but choosing a new one is allowed. */
  mustChangePassword: boolean;
}

export interface Session {
  /** The SHA-256 of the cookie's id, as stored; never the id itself. */
  id: string;
  user: SessionUser;
}

const digest = (token: string): string => createHash('sha256').update(token).digest('hex');

/** The session id the browser sent, if any. Express parses no cookies, so the one header is read here. */
export function sessionToken(req: Request): string | undefined {
  for (const part of (req.header('cookie') ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at !== -1 && part.slice(0, at).trim() === SESSION_COOKIE) {
      const value = part.slice(at + 1).trim();
      return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
    }
  }
  return undefined;
}

/**
 * The cookie's attributes: script cannot read it, no other site's page can make the browser send
 * it, it goes only to the API, and only over HTTPS when the request came that way (req.secure,
 * from nginx's X-Forwarded-Proto behind app.ts's trust proxy).
 */
const cookieOptions = (req: Request) => ({ httpOnly: true, sameSite: 'strict' as const, secure: req.secure, path: '/api' });

export function setSessionCookie(req: Request, res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions(req), maxAge: SESSION_MAX_MS });
}

export function clearSessionCookie(req: Request, res: Response): void {
  res.clearCookie(SESSION_COOKIE, cookieOptions(req));
}

export interface Sessions {
  /** A new session for the user; returns the id for its cookie. */
  start(userId: number): Promise<string>;
  /** The live session this id names: not ended, not expired, its user not disabled. Marks it used. */
  find(token: string): Promise<Session | undefined>;
  /** Sign out: the session ends, and the streams it opened close. */
  end(id: string): Promise<void>;
  /** Every session the user holds ends, but `keep` (theirs, after a change of their own password). */
  endAllOf(userId: number, keep?: string): Promise<void>;
  /**
   * Forget expired sessions, count each open stream as use of its session, and close the streams
   * whose session has ended some other way (the 7 days, a disabled user). Run once a minute.
   */
  sweep(): Promise<void>;
}

interface SessionRow extends RowDataPacket {
  id: string;
  lastSeenAt: Date;
  userId: number;
  username: string;
  role: Role;
  mustChangePassword: number;
}

export function createSessions({ pool, sse, now = () => new Date() }: { pool: Pool; sse: Broadcaster; now?: () => Date }): Sessions {
  const oldest = (at: Date) => ({ lastSeen: new Date(at.getTime() - SESSION_IDLE_MS), created: new Date(at.getTime() - SESSION_MAX_MS) });

  return {
    async start(userId) {
      const token = randomBytes(32).toString('base64url');
      const at = now();
      await pool.query('INSERT INTO sessions (id, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)', [digest(token), userId, at, at]);
      return token;
    },

    async find(token) {
      const at = now();
      const { lastSeen, created } = oldest(at);
      const [rows] = await pool.query<SessionRow[]>(
        `SELECT s.id, s.last_seen_at AS lastSeenAt, u.id AS userId, u.username, u.role, u.must_change_password AS mustChangePassword
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.id = ? AND u.disabled = 0 AND s.last_seen_at > ? AND s.created_at > ?`,
        [digest(token), lastSeen, created],
      );
      const row = rows[0];
      if (row === undefined) return undefined;
      if (at.getTime() - row.lastSeenAt.getTime() >= TOUCH_AFTER_MS) {
        await pool.query('UPDATE sessions SET last_seen_at = ? WHERE id = ?', [at, row.id]);
      }
      return { id: row.id, user: { id: row.userId, username: row.username, role: row.role, mustChangePassword: row.mustChangePassword === 1 } };
    },

    async end(id) {
      await pool.query('DELETE FROM sessions WHERE id = ?', [id]);
      sse.endStreams((owner) => owner.sessionId === id);
    },

    async endAllOf(userId, keep) {
      await pool.query('DELETE FROM sessions WHERE user_id = ? AND id <> ?', [userId, keep ?? '']);
      sse.endStreams((owner) => owner.userId === userId && owner.sessionId !== keep);
    },

    async sweep() {
      const at = now();
      const { lastSeen, created } = oldest(at);
      await pool.query('DELETE FROM sessions WHERE last_seen_at <= ? OR created_at <= ?', [lastSeen, created]);
      const open = sse.streamSessions();
      if (open.length === 0) return;
      await pool.query('UPDATE sessions SET last_seen_at = ? WHERE id IN (?)', [at, open]);
      const [rows] = await pool.query<RowDataPacket[]>(
        'SELECT s.id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id IN (?) AND u.disabled = 0',
        [open],
      );
      const live = new Set(rows.map((r) => r.id as string));
      sse.endStreams((owner) => !live.has(owner.sessionId));
    },
  };
}

/** The session sweep's schedule, stopped like the other background jobs (shutdown.ts). */
export function startSessionSweep(sessions: Sessions, intervalMs = 60_000, onError = (error: unknown) => console.error('session sweep: pass failed:', error)) {
  let inFlight: Promise<unknown> | undefined;
  const timer = setInterval(() => {
    if (inFlight !== undefined) return;
    inFlight = sessions
      .sweep()
      .catch(onError)
      .finally(() => {
        inFlight = undefined;
      });
  }, intervalMs);
  timer.unref();
  return {
    stop: async () => {
      clearInterval(timer);
      await inFlight;
    },
  };
}
