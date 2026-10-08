import { useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { describeError, signIn } from '@/api';
import { AuthScreen } from '@/components/AuthScreen';
import { InlineError } from '@/components/settings/section';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { usePageTitle } from '@/hooks/use-page-title';
import { setSession } from '@/lib/session';
import { returnPath } from '@/lib/signIn';

/**
 * Sign in with a username and password (docs/adr/0010), then on to the page that was asked for
 * (`?next=`), or the dashboard. A refusal says only what the server said: "Wrong username or
 * password", or that there were too many tries.
 */
export default function SignIn() {
  usePageTitle('Sign in');
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const passwordInput = useRef<HTMLInputElement>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (username.trim() === '' || password === '') {
      setError('Give your username and password');
      return;
    }
    setPending(true);
    setError(null);
    try {
      setSession(await signIn(username.trim(), password));
      navigate(returnPath(location.search), { replace: true });
    } catch (thrown) {
      setError(describeError(thrown));
      setPassword('');
      passwordInput.current?.focus();
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthScreen title="Sign in" description="Temperature and humidity in the district's network closets.">
      <form onSubmit={submit} noValidate className="grid gap-4" aria-label="Sign in">
        <div className="space-y-2">
          <Label htmlFor="sign-in-username">Username</Label>
          <Input
            id="sign-in-username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            aria-invalid={error !== null || undefined}
            autoFocus
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="sign-in-password">Password</Label>
          <Input
            ref={passwordInput}
            id="sign-in-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            aria-invalid={error !== null || undefined}
          />
        </div>
        <InlineError message={error} />
        <Button type="submit" disabled={pending} className="w-full">
          {pending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </AuthScreen>
  );
}
