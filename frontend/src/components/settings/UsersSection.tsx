import { useRef, useState } from 'react';
import { KeyRound, Plus } from 'lucide-react';
import { AnimatePresence } from 'framer-motion';
import { addUser, deleteUser, getUsers, updateUser } from '@/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useChange } from '@/hooks/use-change';
import { useResource } from '@/hooks/use-resource';
import { passwordProblem, roleName, userActions, usernameProblem } from '@/lib/users';
import type { SessionUser, User, UserRole } from '@/types';
import { AnimatedRow, DeleteButton, EmptyRow, ErrorRow, FieldHint, InlineError, InlineForm, SectionHeader, SkeletonRows, StatusLine, WrappingCell } from './section';

const COLUMNS = 4;

const lastSignIn = (iso: string | null): string => (iso === null ? 'Never' : new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }));

/**
 * Who may sign in (docs/adr/0010), for an Admin: add a user with a starting password, make an Admin
 * a Viewer or the other way round, disable or enable, set a new password for someone who forgot
 * theirs, delete. What the server would refuse (the last enabled Admin, yourself) is not offered,
 * and says why (lib/users.ts); a refusal the server still makes shows inline.
 */
export function UsersSection({ me }: { me: SessionUser }) {
  const { state, reload } = useResource(getUsers);
  const add = useChange();
  const change = useChange();
  const remove = useChange();
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState({ username: '', role: 'viewer' as UserRole, password: '' });
  const [submitted, setSubmitted] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  /** The user whose row is the new-password form, if any. */
  const [settingPassword, setSettingPassword] = useState<User | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);

  const usernameError = usernameProblem(form.username);
  const passwordError = passwordProblem(form.password);

  const closeForm = () => {
    setFormOpen(false);
    setForm({ username: '', role: 'viewer', password: '' });
    setSubmitted(false);
    add.clearError();
    addButton.current?.focus();
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    if (usernameError !== null || passwordError !== null) return;
    const username = form.username.trim();
    const result = await add.run(() => addUser(username, form.role, form.password));
    if (result.ok) {
      setStatus(`${username} added, as ${form.role === 'admin' ? 'an Admin' : 'a Viewer'}. Tell them their starting password; they can change it from their name in the sidebar.`);
      setForm({ username: '', role: 'viewer', password: '' });
      setSubmitted(false);
      setFormOpen(false);
      await reload();
    }
  };

  const apply = async (user: User, changes: Parameters<typeof updateUser>[1], said: string) => {
    setStatus(null);
    const result = await change.run(() => updateUser(user.id, changes));
    if (result.ok) {
      setStatus(said);
      await reload();
    }
    return result;
  };

  const removeUser = async (user: User) => {
    setStatus(null);
    const result = await remove.run(() => deleteUser(user.id));
    if (result.ok) {
      setStatus(`${user.username} deleted.`);
      await reload();
      addButton.current?.focus();
    }
    return result;
  };

  const users = state.status === 'ready' ? state.data : [];

  return (
    <section className="space-y-4" aria-labelledby="users-heading">
      <SectionHeader
        id="users-heading"
        title="Users"
        description="Who may sign in. An Admin can change everything here; a Viewer can only look. Disabling a user or setting a new password ends their sessions at once."
        action={
          <Button ref={addButton} size="sm" variant="outline" onClick={() => setFormOpen(true)} disabled={formOpen}>
            <Plus aria-hidden />
            Add user
          </Button>
        }
      />

      {formOpen && (
        <InlineForm onSubmit={submit} aria-label="Add a user">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="user-username">Username</Label>
              <Input
                id="user-username"
                value={form.username}
                onChange={(event) => setForm({ ...form, username: event.target.value })}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={64}
                aria-invalid={(submitted && usernameError !== null) || undefined}
                aria-describedby={submitted && usernameError !== null ? 'user-username-error' : undefined}
                autoFocus
              />
              {submitted && usernameError !== null && <InlineError id="user-username-error" message={usernameError} />}
            </div>
            <div className="space-y-2">
              <Label htmlFor="user-role">Role</Label>
              <Select value={form.role} onValueChange={(role) => setForm({ ...form, role: role as UserRole })}>
                <SelectTrigger id="user-role" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="viewer">Viewer, can only look</SelectItem>
                  <SelectItem value="admin">Admin, can change things</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="user-password">Starting password</Label>
              <Input
                id="user-password"
                type="password"
                value={form.password}
                onChange={(event) => setForm({ ...form, password: event.target.value })}
                autoComplete="new-password"
                aria-invalid={(submitted && passwordError !== null) || undefined}
                aria-describedby={submitted && passwordError !== null ? 'user-password-error user-password-hint' : 'user-password-hint'}
              />
              {submitted && passwordError !== null && <InlineError id="user-password-error" message={passwordError} />}
            </div>
          </div>
          <FieldHint id="user-password-hint">A username is letters, digits, and . _ @ -. The starting password needs at least 8 characters.</FieldHint>
          <InlineError message={add.error} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={add.pending}>
              {add.pending ? 'Saving…' : 'Save user'}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={closeForm} disabled={add.pending}>
              Cancel
            </Button>
          </div>
        </InlineForm>
      )}

      <StatusLine message={status} />
      <InlineError message={change.error} />

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Username</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Last sign-in</TableHead>
              <TableHead className="w-48">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.status === 'loading' && <SkeletonRows columns={COLUMNS} />}
            {state.status === 'error' && <ErrorRow colSpan={COLUMNS} message={`Could not load users. ${state.message}`} onRetry={reload} />}
            {state.status === 'ready' && users.length === 0 && <EmptyRow colSpan={COLUMNS} title="No users" hint="Add one to let someone sign in." />}
            <AnimatePresence initial={false}>
              {users.map((user) => {
                const actions = userActions(user, me, users);
                return settingPassword?.id === user.id ? (
                  <AnimatedRow key={user.id} className="hover:bg-transparent">
                    <TableCell colSpan={COLUMNS} className="whitespace-normal p-2">
                      <NewPasswordForm
                        user={user}
                        onCancel={() => setSettingPassword(null)}
                        onSave={async (password) => {
                          const result = await apply(user, { password }, `${user.username} has a new password; their sessions have ended.`);
                          if (result.ok) setSettingPassword(null);
                        }}
                        error={change.error}
                        pending={change.pending}
                      />
                    </TableCell>
                  </AnimatedRow>
                ) : (
                  <AnimatedRow key={user.id}>
                    <WrappingCell>
                      <span className="font-medium">{user.username}</span>
                      {user.id === me.id && <Badge variant="outline" className="ml-2">You</Badge>}
                      {user.disabled && <Badge variant="outline" className="ml-2 text-muted-foreground">Disabled</Badge>}
                      {/* Only the last enabled Admin cannot change role; the sentence says what would let it. */}
                      {!actions.role.offered && <span className="block text-xs text-muted-foreground">{actions.role.why}</span>}
                    </WrappingCell>
                    <TableCell>{roleName(user.role)}</TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">{lastSignIn(user.lastSignInAt)}</TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      {actions.role.offered && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={change.pending}
                          onClick={() => {
                            const to = actions.role.offered ? actions.role.to : user.role;
                            void apply(user, { role: to }, `${user.username} is now ${to === 'admin' ? 'an Admin' : 'a Viewer'}.`);
                          }}
                        >
                          {actions.role.to === 'admin' ? 'Make Admin' : 'Make Viewer'}
                        </Button>
                      )}
                      {actions.disabled.offered && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={change.pending}
                          onClick={() =>
                            void apply(user, { disabled: !user.disabled }, user.disabled ? `${user.username} can sign in again.` : `${user.username} is disabled; their sessions have ended.`)
                          }
                        >
                          {user.disabled ? 'Enable' : 'Disable'}
                        </Button>
                      )}
                      {actions.password.offered && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Set a new password for ${user.username}`}
                          title={`Set a new password for ${user.username}`}
                          className="text-muted-foreground hover:text-foreground"
                          disabled={settingPassword !== null}
                          onClick={() => {
                            change.clearError();
                            setSettingPassword(user);
                          }}
                        >
                          <KeyRound aria-hidden />
                        </Button>
                      )}
                      {actions.remove.offered && (
                        <DeleteButton
                          label={`Delete ${user.username}`}
                          title={`Delete ${user.username}?`}
                          description={`${user.username} can no longer sign in, and any session they have open ends now. Add them again to let them back.`}
                          error={remove.error}
                          onConfirm={() => removeUser(user)}
                          onDismiss={remove.clearError}
                        />
                      )}
                    </TableCell>
                  </AnimatedRow>
                );
              })}
            </AnimatePresence>
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

interface NewPasswordFormProps {
  user: User;
  onSave: (password: string) => Promise<void>;
  onCancel: () => void;
  error: string | null;
  pending: boolean;
}

/** A new password an Admin sets for someone who forgot theirs, in place of the row. */
function NewPasswordForm({ user, onSave, onCancel, error, pending }: NewPasswordFormProps) {
  const [password, setPassword] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const problem = passwordProblem(password);
  const id = `new-password-${user.id}`;
  return (
    <InlineForm
      aria-label={`Set a new password for ${user.username}`}
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
        if (problem === null) void onSave(password);
      }}
    >
      <div className="space-y-2">
        <Label htmlFor={id}>New password for {user.username}</Label>
        <Input
          id={id}
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-invalid={(submitted && problem !== null) || undefined}
          aria-describedby={`${id}-hint`}
          autoFocus
        />
        <FieldHint id={`${id}-hint`}>At least 8 characters. Their sessions end, and they sign in with this one.</FieldHint>
      </div>
      <InlineError message={submitted ? (problem ?? error) : error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'Saving…' : 'Set password'}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </InlineForm>
  );
}
