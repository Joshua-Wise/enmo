import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronsUpDown, KeyRound, LogOut, UserRound } from 'lucide-react';
import { describeError, signOut } from '@/api';
import { ChangePasswordForm } from '@/components/ChangePasswordForm';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { useSession } from '@/hooks/use-session';
import { sessionEnded } from '@/lib/session';
import { SIGN_IN_PATH } from '@/lib/signIn';
import { roleName } from '@/lib/users';

/**
 * Who is signed in, at the foot of the sidebar: their name and role, and a menu to change their
 * own password or sign out. Signing out goes to the sign-in page, not back to the page it left.
 */
export function UserMenu() {
  const session = useSession();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const [changing, setChanging] = useState(false);
  if (session.status !== 'signed-in') return null;
  const { username, role } = session.user;

  const leave = async () => {
    setOpenMobile(false);
    try {
      await signOut();
    } catch (thrown) {
      // The cookie may outlive a failed request; the server ends the session at its own expiry.
      console.warn(describeError(thrown));
    }
    navigate(SIGN_IN_PATH, { replace: true });
    sessionEnded();
  };

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        {/* Not modal: a modal menu that opens a dialog leaves the page unclickable once both close. */}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" aria-label={`${username}, ${roleName(role)}: account menu`}>
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-accent">
                <UserRound className="size-4" aria-hidden />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{username}</span>
                <span className="truncate text-xs text-muted-foreground">{roleName(role)}</span>
              </div>
              <ChevronsUpDown className="ml-auto size-4" aria-hidden />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side={isMobile ? 'top' : 'right'} align="end" sideOffset={4} className="min-w-56">
            <DropdownMenuLabel className="font-normal">
              Signed in as <span className="font-medium">{username}</span>, {roleName(role)}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setChanging(true)}>
              <KeyRound aria-hidden />
              Change password
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void leave()}>
              <LogOut aria-hidden />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Dialog open={changing} onOpenChange={setChanging}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Change your password</DialogTitle>
              <DialogDescription>Your other sessions, on other browsers, end when it changes; this one stays signed in.</DialogDescription>
            </DialogHeader>
            {changing && <ChangePasswordForm onChanged={() => setChanging(false)} onCancel={() => setChanging(false)} />}
          </DialogContent>
        </Dialog>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
