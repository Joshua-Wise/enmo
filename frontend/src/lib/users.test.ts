import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { User } from '../types.ts';
import { passwordProblem, userActions, usernameProblem } from './users.ts';

const user = (id: number, username: string, role: User['role'], disabled = false): User => ({
  id,
  username,
  role,
  disabled,
  createdAt: '2026-10-08T12:00:00Z',
  lastSignInAt: null,
});

const boss = user(1, 'boss', 'admin');
const kim = user(2, 'kim', 'viewer');

describe('the Users tab refuses what the server would', () => {
  it('the last enabled Admin cannot be demoted, disabled, or deleted, and says why', () => {
    // Seen by someone the list no longer names as an Admin (it was loaded before they were demoted).
    const someoneElse = { id: 99, username: 'someone', role: 'admin' as const };
    const actions = userActions(boss, someoneElse, [boss, kim]);
    for (const offer of [actions.role, actions.disabled, actions.remove]) {
      assert.deepEqual(offer, { offered: false, why: 'boss is the last enabled Admin; make another user an Admin first' });
    }
    assert.deepEqual(actions.password, { offered: true, to: true });
  });

  it('a disabled Admin does not count: the one enabled Admin is still the last', () => {
    const old = user(3, 'old', 'admin', true);
    assert.equal(userActions(boss, kim, [boss, kim, old]).role.offered, false);
    assert.deepEqual(userActions(old, boss, [boss, kim, old]).disabled, { offered: true, to: false }, 'enabling is always offered');
  });

  it('with two enabled Admins, either may be demoted, disabled, or deleted by the other', () => {
    const two = user(3, 'two', 'admin');
    const actions = userActions(two, boss, [boss, kim, two]);
    assert.deepEqual(actions.role, { offered: true, to: 'viewer' });
    assert.deepEqual(actions.disabled, { offered: true, to: true });
    assert.deepEqual(actions.remove, { offered: true, to: true });
  });

  it('no one deletes or disables themselves, or resets their own password here', () => {
    const two = user(3, 'two', 'admin');
    const mine = userActions(boss, boss, [boss, kim, two]);
    assert.deepEqual(mine.remove, { offered: false, why: 'You cannot delete yourself; another Admin can' });
    assert.deepEqual(mine.disabled, { offered: false, why: 'You cannot disable yourself; another Admin can' });
    assert.equal(mine.password.offered, false);
    assert.deepEqual(mine.role, { offered: true, to: 'viewer' }, 'with another Admin, you may step down');
  });

  it('a Viewer may be made an Admin, disabled, deleted, or given a new password', () => {
    const actions = userActions(kim, boss, [boss, kim]);
    assert.deepEqual(actions, {
      role: { offered: true, to: 'admin' },
      disabled: { offered: true, to: true },
      remove: { offered: true, to: true },
      password: { offered: true, to: true },
    });
  });
});

describe('what a new user and password must be', () => {
  it('usernames: 1 to 64 letters, digits, and . _ @ -', () => {
    for (const ok of ['kim', 'k.lee@district', 'tech_2', 'a-b']) assert.equal(usernameProblem(ok), null, ok);
    for (const bad of ['', 'has space', 'x'.repeat(65), 'naïve']) assert.notEqual(usernameProblem(bad), null, bad);
  });

  it('passwords: 8 to 200 characters, so the first one, admin, cannot stay', () => {
    assert.match(passwordProblem('admin') ?? '', /at least 8/);
    assert.equal(passwordProblem('eight888'), null);
    assert.match(passwordProblem('x'.repeat(201)) ?? '', /at most 200/);
  });
});
