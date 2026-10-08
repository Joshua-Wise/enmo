import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import type { RowDataPacket } from 'mysql2/promise';
import { parseAddressList, type NotificationsConfig } from '../config';
import type { RouteDeps } from '../deps';
import { MailerError, type Email } from '../mailer';
import { monthBefore, serverTimeZone } from '../localDay';
import { MonotonicStore } from '../monotonicStore';
import { queueMonthlyReport } from '../monthlyReport';
import { listKey, recipientLists } from '../outbox';
import { outboxStatus, type ListResult } from '../outboxStore';
import { dailyWindowText } from '../quietHours';

/** The email the Settings button sends: proof that the relay, the sender, and the recipients work. */
export function testEmail({ smtp, publicUrl }: NotificationsConfig, sentAt: Date): Email {
  return {
    subject: '[Temperature Alarms] Test email',
    text: [
      'This is a test email from Temperature Alarms, sent from the Settings page.',
      '',
      `If you are reading it, the relay at ${smtp.host}:${smtp.port} delivers to this address, and Incident emails will arrive the same way.`,
      '',
      `Dashboard: ${publicUrl}`,
      `Sent: ${sentAt.toISOString()}`,
    ].join('\n'),
  };
}

/** The later of two results, either of which may be missing. */
function latest<T extends { at: Date }>(a: T | null, b: T | null): T | null {
  if (a === null) return b;
  if (b === null) return a;
  return b.at.getTime() > a.at.getTime() ? b : a;
}

const serialised = <T extends { at: Date }>(result: T | null) => (result === null ? null : { ...result, at: result.at.toISOString() });

interface CampusListRow extends RowDataPacket {
  shortcode: string;
  notifyTo: string;
}

/**
 * Email notifications (docs/adr/0008), all for an Admin. GET /api/notifications/status
 * says whether they are on, through which relay, to whom, whether the monthly report is, when quiet
 * hours are, how the last send went, and how many wait in the outbox (and how many of those quiet
 * hours hold, until when) or were given up on; and for each recipient list (NOTIFY_TO, and each
 * Campus's own), which Campuses email it and how its last try went.
 * POST /api/notifications/test sends a test email now, at most one a minute, and returns the relay's reply.
 * POST /api/notifications/report queues the report on last month in the outbox, at most one a
 * minute, and answers 202 with the month; the sender emails it to NOTIFY_TO within seconds.
 */
export function notificationsRouter({ config, pool, auth, mailer, now = () => new Date() }: RouteDeps): Router {
  const router = Router();
  const adminOnly = auth.admin;
  const notifications = config.notifications;

  // The test email skips the outbox, so its result is kept here, for this process only. Incident
  // emails are read from the outbox's rows, which a restart keeps.
  let testSent: { at: Date; subject: string } | null = null;
  let testFailure: { at: Date; error: string } | null = null;
  // The test email goes to NOTIFY_TO, so its result is also the default list's latest.
  let testResult: ListResult | null = null;

  router.get('/status', adminOnly, async (_req, res, next) => {
    try {
      const outbox = await outboxStatus(pool, now());
      const [campuses] = await pool.query<CampusListRow[]>('SELECT shortcode, notify_to AS notifyTo FROM campuses ORDER BY name');
      const lists =
        notifications === undefined
          ? []
          : recipientLists(
              campuses.map((c) => ({ shortcode: c.shortcode, notifyTo: parseAddressList(c.notifyTo).addresses })),
              notifications.to,
              notifications.toAll,
            ).map((list) => ({
              ...list,
              lastResult: serialised(latest(outbox.lastByList.get(listKey(list.recipients)) ?? null, list.isDefault ? testResult : null)),
            }));
      res.json({
        enabled: notifications !== undefined,
        // Addresses are shown: an Admin sees what .env names. The password never is.
        relay: notifications === undefined ? null : { host: notifications.smtp.host, port: notifications.smtp.port, secure: notifications.smtp.secure },
        from: notifications?.from ?? null,
        recipients: notifications?.to ?? [],
        toAll: notifications?.toAll ?? false,
        lists,
        monthlyReport: notifications?.monthlyReport ?? false,
        quietHours:
          notifications === undefined
            ? null
            : { hours: notifications.quietHours.daily === null ? null : dailyWindowText(notifications.quietHours.daily), weekends: notifications.quietHours.weekends },
        lastSent: serialised(latest(outbox.lastSent, testSent)),
        lastFailure: serialised(latest(outbox.lastFailure, testFailure)),
        pending: outbox.pending,
        held: outbox.held?.count ?? 0,
        heldUntil: outbox.held?.until.toISOString() ?? null,
        failed: outbox.failed,
      });
    } catch (error) {
      next(error);
    }
  });

  // One a minute whoever asks: every press emails every recipient. Counted only once the token is
  // accepted and notifications are on, so neither a refusal nor a press while off spends it.
  const testLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 1,
    store: new MonotonicStore(),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: () => 'test-email',
    message: { error: 'Only one test email a minute: wait a minute and try again.' },
    validate: false,
  });

  // The same allowance for the report: every press emails NOTIFY_TO a month's worth.
  const reportLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 1,
    store: new MonotonicStore(),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: () => 'report-email',
    message: { error: 'Only one report a minute: wait a minute and try again.' },
    validate: false,
  });

  if (notifications === undefined || mailer === undefined) {
    const off = (_req: Request, res: Response) => {
      res.status(409).json({ error: 'Email notifications are off: set SMTP_HOST, NOTIFY_FROM, NOTIFY_TO, and PUBLIC_URL in .env and restart the server.' });
    };
    router.post('/test', adminOnly, off);
    router.post('/report', adminOnly, off);
    return router;
  }

  router.post('/test', adminOnly, testLimiter, async (_req, res, next) => {
    const sentAt = now();
    const email = testEmail(notifications, sentAt);
    try {
      const { accepted, rejected, response } = await mailer.send(email);
      testSent = { at: sentAt, subject: email.subject };
      testResult = { at: sentAt, sent: true, subject: email.subject };
      res.json({ sentAt: sentAt.toISOString(), accepted, rejected, response });
    } catch (error) {
      if (error instanceof MailerError) {
        testFailure = { at: sentAt, error: error.message };
        testResult = { at: sentAt, sent: false, error: error.message };
        res.status(502).json({ error: `The relay did not take the test email: ${error.message}` });
        return;
      }
      next(error);
    }
  });

  // Queued, not sent here: it goes the way of the scheduled one, retried and shown in the status
  // above, and building a month of Readings is no work for a request.
  router.post('/report', adminOnly, reportLimiter, async (_req, res, next) => {
    const queuedAt = now();
    const { month } = monthBefore(queuedAt, serverTimeZone());
    try {
      await queueMonthlyReport(pool, month, queuedAt);
      res.status(202).json({ month, queuedAt: queuedAt.toISOString() });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
