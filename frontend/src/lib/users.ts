import type { SessionUser, User, UserRole } from '../types.ts';

/** An action the Users tab offers on a row, or the sentence that says why it does not. */
export type Offer<T> = { offered: true; to: T } | { offered: false; why: string };

export interface UserActions {
  /** Make an Admin a Viewer, or a Viewer an Admin. */
  role: Offer<UserRole>;
  /** Disable an enabled user, or enable a disabled one. */
  disabled: Offer<boolean>;
  remove: Offer<true>;
  /** Set a new password for someone who forgot theirs. Your own you change from your name in the sidebar. */
  password: Offer<true>;
}

const offer = <T>(to: T): Offer<T> => ({ offered: true, to });
const refuse = <T>(why: string): Offer<T> => ({ offered: false, why });

const lastAdmin = (user: User) => `${user.username} is the last enabled Admin; make another user an Admin first`;

/**
 * What the Users tab offers on one row, by the server's own rules (backend/src/users.ts), so it
 * never offers what the server would refuse: the last enabled Admin cannot be demoted, disabled,
 * or deleted, and no one disables or deletes themselves. The server checks again; this only keeps
 * the buttons honest.
 */
export function userActions(user: User, me: SessionUser, users: User[]): UserActions {
  const enabledAdmins = users.filter((u) => u.role === 'admin' && !u.disabled);
  const isLastAdmin = enabledAdmins.length === 1 && enabledAdmins[0].id === user.id;
  const isMe = user.id === me.id;

  const role: Offer<UserRole> = user.role === 'viewer' ? offer('admin') : isLastAdmin ? refuse(lastAdmin(user)) : offer('viewer');
  const disabled: Offer<boolean> = user.disabled
    ? offer(false)
    : isMe
      ? refuse('You cannot disable yourself; another Admin can')
      : isLastAdmin
        ? refuse(lastAdmin(user))
        : offer(true);
  const remove: Offer<true> = isMe ? refuse('You cannot delete yourself; another Admin can') : isLastAdmin ? refuse(lastAdmin(user)) : offer(true);
  const password: Offer<true> = isMe ? refuse('Change your own password from your name in the sidebar') : offer(true);
  return { role, disabled, remove, password };
}

/** A user's role as the page names it. */
export const roleName = (role: UserRole): string => (role === 'admin' ? 'Admin' : 'Viewer');

export const USERNAME_PATTERN = /^[A-Za-z0-9._@-]{1,64}$/;
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;

/** Why a username will not do, or null, as the server would say it. */
export const usernameProblem = (username: string): string | null =>
  USERNAME_PATTERN.test(username.trim()) ? null : 'A username is 1 to 64 letters, digits, and . _ @ -';

/** Why a new password will not do, or null, as the server would say it. */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `A password needs at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password.length > MAX_PASSWORD_LENGTH) return `A password can be at most ${MAX_PASSWORD_LENGTH} characters`;
  return null;
}
