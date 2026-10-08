import { Router } from 'express';
import { sessionOf } from '../auth';
import type { RouteDeps } from '../deps';
import { createUser, deleteUser, listUsers, updateUser } from '../users';

const userId = (raw: string): number | undefined => {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : undefined;
};

/**
 * Users, for an Admin (docs/adr/0010): GET lists them with their role, whether disabled, and the
 * last sign-in; POST `{username, role, password}` adds one with a starting password; PATCH
 * `{role?, disabled?, password?}` changes a role, disables or enables, or sets a new password;
 * DELETE removes one. Disabling, a new password, and deleting end the user's sessions at once,
 * streams included. The rules that keep an Admin in the system are users.ts's; a refusal is a 409.
 */
export function usersRouter({ pool, auth, sessions, now = () => new Date() }: RouteDeps): Router {
  const router = Router();
  router.use(auth.admin);

  router.get('/', async (_req, res, next) => {
    try {
      res.json(await listUsers(pool));
    } catch (error) {
      next(error);
    }
  });

  router.post('/', async (req, res, next) => {
    const { username, role, password } = (req.body ?? {}) as Record<string, unknown>;
    try {
      const result = await createUser(pool, { username, role, password }, now());
      if ('error' in result) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.status(201).json(result.user);
    } catch (error) {
      next(error);
    }
  });

  router.patch('/:id', async (req, res, next) => {
    const id = userId(req.params.id);
    if (id === undefined) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const { role, disabled, password } = (req.body ?? {}) as Record<string, unknown>;
    try {
      const result = await updateUser(pool, id, { role, disabled, password }, sessionOf(res)?.user.id);
      if ('error' in result) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      if (result.endSessions === true) await sessions.endAllOf(id);
      res.json(result.user);
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:id', async (req, res, next) => {
    const id = userId(req.params.id);
    if (id === undefined) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    try {
      const result = await deleteUser(pool, id, sessionOf(res)?.user.id);
      if ('error' in result) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      // The rows went with the user; this closes the streams they had open.
      await sessions.endAllOf(id);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
}
