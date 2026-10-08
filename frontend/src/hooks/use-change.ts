import { useCallback, useState } from 'react';
import { describeError, UnauthorisedError } from '@/api';

/** How a change ended: done, refused because the session ended, or failed with a message to show. */
export type ChangeResult = { ok: true } | { ok: false; reason: 'unauthorised' | 'failed' };

/**
 * Run a change against the API. A session that has ended takes the page to sign-in on its own
 * (api.ts), so `onUnauthorised` is only for a page with something to put away first; every other
 * failure, a Viewer's refusal included, becomes a message to show inline.
 */
export function useChange(onUnauthorised?: () => void) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const run = useCallback(
    async (change: () => Promise<unknown>): Promise<ChangeResult> => {
      setError(null);
      setPending(true);
      try {
        await change();
        return { ok: true };
      } catch (thrown) {
        if (thrown instanceof UnauthorisedError) {
          onUnauthorised?.();
          return { ok: false, reason: 'unauthorised' };
        }
        setError(describeError(thrown));
        return { ok: false, reason: 'failed' };
      } finally {
        setPending(false);
      }
    },
    [onUnauthorised],
  );

  return { run, error, pending, clearError: () => setError(null) };
}
