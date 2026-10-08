import { Router } from 'express';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { RouteDeps } from '../deps';
import { parseCampus, parseRecipients } from '../campusInput';
import { isDuplicateKey, isForeignKeyInUse } from '../db';

interface CampusRow extends RowDataPacket {
  id: number;
  name: string;
  shortcode: string;
}

interface RecipientsRow extends RowDataPacket {
  id: number;
  notifyTo: string;
}

/** A stored recipient list, `a@x, b@y` or empty, as the addresses it names. */
const addressesOf = (stored: string): string[] => stored.split(',').map((a) => a.trim()).filter((a) => a !== '');

/**
 * Campus routes: any signed-in user may list; adding, changing, deleting, and reading the recipient lists need
 * an Admin (auth.ts). A Campus's own recipients (docs/adr/0008) are read apart from it, so the
 * list never carries an address.
 */
export function campusesRouter({ pool, auth }: RouteDeps): Router {
  const router = Router();
  const adminOnly = auth.admin;

  router.get('/', async (_req, res, next) => {
    try {
      const [rows] = await pool.query<CampusRow[]>('SELECT id, name, shortcode FROM campuses ORDER BY name');
      res.json(rows.map(({ id, name, shortcode }) => ({ id, name, shortcode })));
    } catch (error) {
      next(error);
    }
  });

  // Every Campus's own list, empty for one that emails NOTIFY_TO, in the order the list above gives.
  router.get('/recipients', adminOnly, async (_req, res, next) => {
    try {
      const [rows] = await pool.query<RecipientsRow[]>('SELECT id, notify_to AS notifyTo FROM campuses ORDER BY name');
      res.json(rows.map(({ id, notifyTo }) => ({ id, notifyTo: addressesOf(notifyTo) })));
    } catch (error) {
      next(error);
    }
  });

  router.post('/', adminOnly, async (req, res, next) => {
    const parsed = parseCampus(req.body);
    if ('error' in parsed) {
      res.status(422).json({ error: parsed.error });
      return;
    }
    const recipients = parseRecipients(((req.body ?? {}) as Record<string, unknown>).notifyTo);
    if ('error' in recipients) {
      res.status(422).json({ error: recipients.error });
      return;
    }
    const { name, shortcode } = parsed;
    try {
      const [result] = await pool.query<ResultSetHeader>('INSERT INTO campuses (name, shortcode, notify_to) VALUES (?, ?, ?)', [
        name,
        shortcode,
        recipients.notifyTo.join(', '),
      ]);
      res.status(201).json({ id: result.insertId, name, shortcode });
    } catch (error) {
      if (isDuplicateKey(error)) {
        res.status(409).json({ error: `A campus with the shortcode ${shortcode} already exists` });
        return;
      }
      next(error);
    }
  });

  // Only its own recipients can change, replaced whole; an empty list sends its email to NOTIFY_TO again.
  router.patch('/:id', adminOnly, async (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(404).json({ error: 'Campus not found' });
      return;
    }
    const { notifyTo } = (req.body ?? {}) as Record<string, unknown>;
    // Nothing to change is more likely a broken request than a wish to clear the list.
    const parsed = notifyTo === undefined ? { error: 'Give notifyTo: the addresses, or an empty list to use NOTIFY_TO' } : parseRecipients(notifyTo);
    if ('error' in parsed) {
      res.status(422).json({ error: parsed.error });
      return;
    }
    try {
      const [result] = await pool.query<ResultSetHeader>('UPDATE campuses SET notify_to = ? WHERE id = ?', [parsed.notifyTo.join(', '), id]);
      if (result.affectedRows === 0) {
        res.status(404).json({ error: 'Campus not found' });
        return;
      }
      const [[{ name, shortcode }]] = await pool.query<CampusRow[]>('SELECT id, name, shortcode FROM campuses WHERE id = ?', [id]);
      res.json({ id, name, shortcode, notifyTo: parsed.notifyTo });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:id', adminOnly, async (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(404).json({ error: 'Campus not found' });
      return;
    }
    try {
      const [result] = await pool.query<ResultSetHeader>('DELETE FROM campuses WHERE id = ?', [id]);
      if (result.affectedRows === 0) {
        res.status(404).json({ error: 'Campus not found' });
        return;
      }
      res.status(204).end();
    } catch (error) {
      if (isForeignKeyInUse(error)) {
        res.status(409).json({ error: 'This campus still has devices. Delete them first.' });
        return;
      }
      next(error);
    }
  });

  return router;
}
