/** Where the sign-in page lives. Every other page needs a session (docs/adr/0010). */
export const SIGN_IN_PATH = '/sign-in';

/**
 * The sign-in page for someone who asked for `location` without a session: `/sign-in?next=/history/3?date=...`,
 * so signing in returns them to it. The dashboard is where sign-in lands anyway, so it needs no `next`.
 */
export function signInPath({ pathname, search }: { pathname: string; search: string }): string {
  const next = `${pathname}${search}`;
  if (pathname === SIGN_IN_PATH || next === '/') return SIGN_IN_PATH;
  return `${SIGN_IN_PATH}?${new URLSearchParams({ next })}`;
}

/**
 * Where signing in goes on to: the `next` the sign-in page was given, if it is a page of this site,
 * else the dashboard. Only a path on this origin is followed, never `//elsewhere` or a full URL,
 * so a link to the sign-in page cannot send someone off the site after they sign in.
 */
export function returnPath(search: string): string {
  const next = new URLSearchParams(search).get('next');
  if (next === null || !next.startsWith('/') || next.startsWith('//')) return '/';
  // A backslash or a control character is read as a slash, or dropped, by some browsers.
  if ([...next].some((c) => c === '\\' || c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) return '/';
  if (next === SIGN_IN_PATH || next.startsWith(`${SIGN_IN_PATH}?`) || next.startsWith(`${SIGN_IN_PATH}/`)) return '/';
  return next;
}
