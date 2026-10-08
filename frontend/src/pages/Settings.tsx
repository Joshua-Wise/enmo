import { usePageTitle } from '@/hooks/use-page-title';
import { useSearchParams } from 'react-router-dom';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CampusesSection } from '@/components/settings/CampusesSection';
import { DevicesSection } from '@/components/settings/DevicesSection';
import { FirmwareSection } from '@/components/settings/FirmwareSection';
import { NewDevicesSection } from '@/components/settings/NewDevicesSection';
import { NotificationsSection } from '@/components/settings/NotificationsSection';
import { RotationLine } from '@/components/settings/RotationLine';
import { SystemSection } from '@/components/settings/SystemSection';
import { UsersSection } from '@/components/settings/UsersSection';
import { useSession } from '@/hooks/use-session';

/** Every tab, an Admin's view; a Viewer sees the first two, as lists without their controls. */
const TABS = ['campuses', 'devices', 'new', 'firmware', 'notifications', 'system', 'users'] as const;
const VIEWER_TABS: readonly Tab[] = ['campuses', 'devices'];
type Tab = (typeof TABS)[number];

function isTab(value: string | null): value is Tab {
  return TABS.includes(value as Tab);
}

/** A session that ends takes the page to sign-in by itself (api.ts); a section has nothing to put away first. */
const onUnauthorised = () => {};

/**
 * Settings: Campuses, Devices, firmware, notifications, the system's own health, and who may sign in.
 * An Admin changes them; a Viewer reads the Campus and Device lists, and the server refuses a
 * Viewer's change whatever the page shows (docs/adr/0010).
 */
export default function Settings() {
  usePageTitle('Settings');
  const session = useSession();
  const me = session.status === 'signed-in' ? session.user : null;
  const canEdit = me?.role === 'admin';
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('tab');
  const offered = canEdit ? TABS : VIEWER_TABS;
  const tab: Tab = isTab(requested) && offered.includes(requested) ? requested : 'campuses';

  return (
    <div className="mx-auto w-full max-w-4xl flex-1 space-y-6">
      <header className="space-y-1">
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">
          {canEdit ? 'Campuses and Devices the dashboard shows, and who may sign in.' : 'Campuses and Devices the dashboard shows. Only an Admin can change them.'}
        </p>
      </header>

      {canEdit && <RotationLine />}

      <Tabs value={tab} onValueChange={(next) => setSearchParams(next === 'campuses' ? {} : { tab: next }, { replace: true })}>
        <TabsList aria-label="Settings sections" className="max-w-full justify-start overflow-x-auto">
          <TabsTrigger value="campuses">Campuses</TabsTrigger>
          <TabsTrigger value="devices">Devices</TabsTrigger>
          {canEdit && (
            <>
              <TabsTrigger value="new">New devices</TabsTrigger>
              <TabsTrigger value="firmware">Firmware</TabsTrigger>
              <TabsTrigger value="notifications">Notifications</TabsTrigger>
              <TabsTrigger value="system">System</TabsTrigger>
              <TabsTrigger value="users">Users</TabsTrigger>
            </>
          )}
        </TabsList>
        <TabsContent value="campuses" tabIndex={-1} className="pt-4">
          <CampusesSection canEdit={canEdit} onUnauthorised={onUnauthorised} />
        </TabsContent>
        <TabsContent value="devices" tabIndex={-1} className="pt-4">
          <DevicesSection canEdit={canEdit} onUnauthorised={onUnauthorised} />
        </TabsContent>
        {canEdit && me !== null && (
          <>
            <TabsContent value="new" tabIndex={-1} className="pt-4">
              <NewDevicesSection canEdit onUnauthorised={onUnauthorised} />
            </TabsContent>
            <TabsContent value="firmware" tabIndex={-1} className="pt-4">
              <FirmwareSection canEdit onUnauthorised={onUnauthorised} />
            </TabsContent>
            <TabsContent value="notifications" tabIndex={-1} className="pt-4">
              <NotificationsSection canEdit onUnauthorised={onUnauthorised} />
            </TabsContent>
            <TabsContent value="system" tabIndex={-1} className="pt-4">
              <SystemSection canEdit />
            </TabsContent>
            <TabsContent value="users" tabIndex={-1} className="pt-4">
              <UsersSection me={me} />
            </TabsContent>
          </>
        )}
      </Tabs>
    </div>
  );
}
