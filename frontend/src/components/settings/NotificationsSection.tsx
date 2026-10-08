import { useEffect, useRef, useState } from 'react';
import { AlertCircle, FileText, Mail } from 'lucide-react';
import { getNotificationStatus, sendMonthlyReport, sendTestEmail } from '@/api';
import { Button } from '@/components/ui/button';
import { useChange } from '@/hooks/use-change';
import { useResource } from '@/hooks/use-resource';
import { notificationsSummary, reportQueued, testEmailSent } from '@/lib/notifications';
import { InlineError, SectionHeader, StatusLine } from './section';

interface NotificationsSectionProps {
  /** True for an Admin: the status is an Admin's to read. */
  canEdit: boolean;
  onUnauthorised: () => void;
}

const timeOf = (iso: string): string => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

/** How long after a report is queued the status is read again: the server's sender takes it within seconds, then builds and sends it. */
const REPORT_SENT_CHECK_MS = 20_000;

/**
 * Email notifications (docs/adr/0008): whether Incidents are emailed, to which lists and how the
 * last send to each went, whether the monthly report is, when quiet hours hold warnings, what waits
 * to be sent (and until when quiet hours hold it) or was given up on, a test email to prove the
 * relay works, and last month's report on request. The settings themselves live in the server's
 * .env, a Campus's own list on Campuses.
 */
export function NotificationsSection({ canEdit, onUnauthorised }: NotificationsSectionProps) {
  return (
    <section className="space-y-4" aria-labelledby="notifications-heading">
      <SectionHeader
        id="notifications-heading"
        title="Notifications"
        description="Emails to technicians when an Incident opens, gets worse, or ends, and a monthly report, sent through the district's SMTP relay. The relay and the default recipients are set in the server's .env; a Campus can name its own under Campuses."
      />
      {canEdit ? (
        <NotificationStatusAndTest onUnauthorised={onUnauthorised} />
      ) : (
        <p className="text-sm text-muted-foreground">Only an Admin sees whether notifications are on and sends a test email.</p>
      )}
    </section>
  );
}

function NotificationStatusAndTest({ onUnauthorised }: { onUnauthorised: () => void }) {
  const { state, reload } = useResource(getNotificationStatus);
  const test = useChange(onUnauthorised);
  const report = useChange(onUnauthorised);
  const [status, setStatus] = useState<string | null>(null);
  const sentCheck = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(sentCheck.current), []);

  const send = async () => {
    setStatus(null);
    await test.run(async () => setStatus(testEmailSent(await sendTestEmail())));
    // A failure is recorded too, so the last result below changes either way.
    await reload();
  };

  // Queued, not sent: the status shows it waiting now, and sent (or why not) once the server's sender has run.
  const sendReport = async () => {
    setStatus(null);
    const result = await report.run(async () => setStatus(reportQueued(await sendMonthlyReport())));
    if (!result.ok) return;
    await reload();
    clearTimeout(sentCheck.current);
    sentCheck.current = setTimeout(() => void reload(), REPORT_SENT_CHECK_MS);
  };

  const summary = state.status === 'ready' ? notificationsSummary(state.data, timeOf) : null;
  const enabled = state.status === 'ready' && state.data.enabled;

  return (
    <>
      {state.status === 'loading' && <p className="text-sm text-muted-foreground">Loading…</p>}
      {state.status === 'error' && <InlineError message={`Could not load the notification status. ${state.message}`} />}
      {summary !== null && (
        <div className="flex flex-col items-start gap-3 rounded-lg border px-4 py-3 text-sm sm:flex-row">
          <div className="w-full min-w-0 flex-1 space-y-1">
            <p className="break-words">
              <span className="font-medium">{summary.state}</span> {summary.detail}
            </p>
            {summary.monthlyReport !== null && <p className="break-words text-muted-foreground">{summary.monthlyReport}</p>}
            {summary.quietHours !== null && <p className="break-words text-muted-foreground">{summary.quietHours}</p>}
            {summary.lists.length > 0 && (
              <ul className="space-y-2 py-1" aria-label="Recipient lists">
                {summary.lists.map((list) => (
                  <li key={list.recipients} className="space-y-0.5">
                    <p className="break-words">{list.recipients}</p>
                    <p className="break-words text-muted-foreground">{list.campuses}</p>
                    {list.failed ? (
                      <p className="flex items-start gap-2 text-destructive">
                        <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
                        <span className="min-w-0 break-words">{list.lastResult}</span>
                      </p>
                    ) : (
                      <p className="break-words text-muted-foreground">{list.lastResult}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {summary.pending !== null && <p className="text-muted-foreground">{summary.pending}</p>}
            {summary.held !== null && <p className="text-muted-foreground">{summary.held}</p>}
            {summary.failed !== null && (
              <p className="flex items-start gap-2 text-destructive">
                <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span className="min-w-0 break-words">{summary.failed}</span>
              </p>
            )}
          </div>
          {enabled && (
            <div className="flex flex-wrap gap-2 sm:flex-col sm:items-stretch">
              <Button variant="outline" size="sm" onClick={send} disabled={test.pending}>
                <Mail aria-hidden />
                {test.pending ? 'Sending…' : 'Send test email'}
              </Button>
              <Button variant="outline" size="sm" onClick={sendReport} disabled={report.pending}>
                <FileText aria-hidden />
                {report.pending ? 'Queuing…' : "Send last month's report now"}
              </Button>
            </div>
          )}
        </div>
      )}
      <InlineError message={test.error} />
      <InlineError message={report.error} />
      <StatusLine message={status} />
    </>
  );
}
