import type { SessionInfo, SessionUser } from '../types.ts';

/**
 * Who is signed in in this browser, as the server last said (docs/adr/0010). The session itself is
 * an HttpOnly cookie script never sees; this is only what the page shows and offers. `loading`
 * until the first GET /api/session answers; any request the server answers 401 ends it here, and
 * the page goes to sign-in.
 */
export type SessionState =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'signed-in'; user: SessionUser; mustChangePassword: boolean };

let state: SessionState = { status: 'loading' };
const listeners = new Set<() => void>();

const notify = (): void => listeners.forEach((listener) => listener());

export const getSessionState = (): SessionState => state;

/** The server named who is signed in: after loading, signing in, or choosing a new password. */
export function setSession({ user, mustChangePassword }: SessionInfo): void {
  state = { status: 'signed-in', user, mustChangePassword };
  notify();
}

/** No one is signed in any more: signed out, expired, disabled, or never was. */
export function sessionEnded(): void {
  if (state.status === 'signed-out') return;
  state = { status: 'signed-out' };
  notify();
}

/** Subscribe to changes; returns the unsubscribe function. */
export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether the signed-in user may change things. The server refuses a Viewer anyway; this only hides the controls. */
export const isAdmin = (session: SessionState): boolean => session.status === 'signed-in' && session.user.role === 'admin';
