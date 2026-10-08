import { describeError, signOut } from '@/api';
import { AuthScreen } from '@/components/AuthScreen';
import { ChangePasswordForm } from '@/components/ChangePasswordForm';
import { Button } from '@/components/ui/button';
import { usePageTitle } from '@/hooks/use-page-title';
import { sessionEnded } from '@/lib/session';

/**
 * The first sign-in of a fresh install, as `admin` / `admin`: nothing but choosing a new password,
 * which the server enforces too, then on to the page that was asked for.
 */
export default function ChoosePassword() {
  usePageTitle('Choose a new password');
  const leave = async () => {
    try {
      await signOut();
    } catch (thrown) {
      console.warn(describeError(thrown));
    }
    sessionEnded();
  };

  return (
    <AuthScreen
      title="Choose a new password"
      description="You signed in with the password every new install starts with. Choose your own before going on; admin will not work again."
    >
      <ChangePasswordForm submitLabel="Save and go on" onChanged={() => {}} />
      <Button type="button" variant="ghost" size="sm" className="-ml-2.5" onClick={() => void leave()}>
        Sign out instead
      </Button>
    </AuthScreen>
  );
}
