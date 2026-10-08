// Signing the e2e scripts in (docs/adr/0010). They hold only the Admin token, which is no user, so each
// makes a throwaway user with it, signs a browser context in as that user, and deletes it at the end.
import { randomBytes } from 'node:crypto';

/** A new user with a random name and password, made with the Admin token. `remove()` deletes it again. */
export async function throwawayUser(api, adminToken, role = 'admin', prefix = 'walk') {
  const username = `${prefix}-${randomBytes(3).toString('hex')}`;
  const password = randomBytes(18).toString('base64url');
  const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + adminToken };
  const response = await fetch(api + '/api/users', { method: 'POST', headers, body: JSON.stringify({ username, role, password }) });
  if (response.status !== 201) throw new Error(`could not add the throwaway user ${username}: ${response.status} ${await response.text()}`);
  const { id } = await response.json();
  return {
    username,
    password,
    remove: () => fetch(api + '/api/users/' + id, { method: 'DELETE', headers }),
  };
}

/** Sign a Playwright browser context in as `user`, through the API: its pages then share the session cookie. */
export async function signInContext(context, web, user) {
  const response = await context.request.post(web + '/api/session', { data: { username: user.username, password: user.password } });
  if (response.status() !== 200) throw new Error(`could not sign in as ${user.username}: ${response.status()}`);
}
