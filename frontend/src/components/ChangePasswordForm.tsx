import { useId, useState } from 'react';
import { changeOwnPassword, describeError } from '@/api';
import { InlineError } from '@/components/settings/section';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { setSession } from '@/lib/session';
import { passwordProblem } from '@/lib/users';

interface ChangePasswordFormProps {
  /** Said once the new password is in place. */
  onChanged: () => void;
  /** Put the form away without changing anything; none on the first sign-in, where there is no way round it. */
  onCancel?: () => void;
  submitLabel?: string;
}

/**
 * The signed-in user's own new password: the current one, the new one twice. Used at the first
 * sign-in of `admin` and from the user menu. The server ends the user's other sessions.
 */
export function ChangePasswordForm({ onChanged, onCancel, submitLabel = 'Change password' }: ChangePasswordFormProps) {
  const id = useId();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const problem = current === '' ? 'Give your current password' : (passwordProblem(next) ?? (next !== again ? 'The two new passwords are not the same' : null));
    if (problem !== null) {
      setError(problem);
      return;
    }
    setPending(true);
    setError(null);
    try {
      setSession(await changeOwnPassword(current, next));
      onChanged();
    } catch (thrown) {
      setError(describeError(thrown));
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="grid gap-4" aria-describedby={`${id}-hint`}>
      <div className="space-y-2">
        <Label htmlFor={`${id}-current`}>Current password</Label>
        <Input id={`${id}-current`} type="password" autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} autoFocus />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${id}-new`}>New password</Label>
        <Input id={`${id}-new`} type="password" autoComplete="new-password" value={next} onChange={(event) => setNext(event.target.value)} aria-describedby={`${id}-hint`} />
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          At least 8 characters. Your other sessions end when it changes.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${id}-again`}>New password again</Label>
        <Input id={`${id}-again`} type="password" autoComplete="new-password" value={again} onChange={(event) => setAgain(event.target.value)} />
      </div>
      <InlineError message={error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
