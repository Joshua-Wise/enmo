import { useSyncExternalStore } from 'react';
import { getSessionState, isAdmin, subscribeSession, type SessionState } from '@/lib/session';

/** Who is signed in, re-rendering whenever that changes. */
export function useSession(): SessionState {
  return useSyncExternalStore(subscribeSession, getSessionState, getSessionState);
}

/** Whether the signed-in user is an Admin, who sees the controls that change things. */
export function useIsAdmin(): boolean {
  return isAdmin(useSession());
}
