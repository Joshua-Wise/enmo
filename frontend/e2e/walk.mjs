// End-to-end walk of the site and backend on a fresh (empty) database. One line per check.
// WEB and API default to the Compose stack on one port; ADMIN_TOKEN and DEVICE_TOKEN come from the environment.
// The site needs a signed-in user (docs/adr/0010): the walk adds a throwaway Admin with the Admin token, signs
// in as it, and deletes it at the end, so admin's own password is never touched.
import { chromium } from 'playwright';
import { signInContext, throwawayUser } from './session.mjs';

const WEB = process.env.WEB ?? 'http://localhost:8080';
const API = process.env.API ?? WEB;
const ADMIN = process.env.ADMIN_TOKEN;
const DEVICE = process.env.DEVICE_TOKEN;
const SHOTS = process.argv[2];
if (!ADMIN || !DEVICE) { console.error('set ADMIN_TOKEN and DEVICE_TOKEN'); process.exit(2); }

const results = [];
async function check(name, fn) {
  try { await fn(); results.push([true, name]); console.log('ok   ' + name); }
  catch (error) { results.push([false, name]); console.log('FAIL ' + name + ' :: ' + String(error).split('\n')[0]); }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const post = (path, token, body) => fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
const reading = (token, temp, humidity = 41, device = 'ESP_C0FFEE') => post('/api/readings', token, { device, temp, humidity });

const walker = await throwawayUser(API, ADMIN, 'admin');
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
const failedRequests = [];
page.on('response', (r) => { if (r.status() >= 500) failedRequests.push(r.status() + ' ' + r.url()); });

await check('api: no session reads nothing', async () => expect((await fetch(API + '/api/dashboard')).status === 401, 'status'));
await check('sign-in: a page asked for without a session shows the sign-in page', async () => {
  await page.goto(WEB + '/settings');
  await page.getByRole('heading', { name: 'Sign in', level: 1 }).waitFor();
  expect(/\/sign-in\?next=%2Fsettings$/.test(page.url()), 'url: ' + page.url());
  expect((await page.title()) === 'Sign in · Temperature Alarms', 'title: ' + (await page.title()));
});
await check('sign-in: a wrong password says only Wrong username or password', async () => {
  await page.getByLabel('Username').fill(walker.username);
  await page.getByLabel('Password').fill('not-the-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('alert').getByText('Wrong username or password').waitFor({ timeout: 5000 });
});
await check('sign-in: the right password returns to the page asked for', async () => {
  await page.getByLabel('Password').fill(walker.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Settings', level: 1 }).waitFor({ timeout: 5000 });
  expect(new URL(page.url()).pathname === '/settings', 'url: ' + page.url());
});
await check('fresh database: dashboard shows the empty state', async () => {
  await page.goto(WEB + '/');
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
  await page.waitForTimeout(800);
  expect(!/ESP_/.test(await page.locator('main').innerText()), 'expected no Device on the dashboard');
  await page.goto(WEB + '/settings');
  await page.getByRole('heading', { name: 'Settings', level: 1 }).waitFor();
});
await check('settings: a Campus is added and its shortcode is upper-cased', async () => {
  const form = page.getByRole('form', { name: 'Add a campus' });
  if (!(await form.isVisible().catch(() => false))) await page.getByRole('button', { name: 'Add campus' }).click();
  if ((await page.getByLabel('Name').inputValue()) === '') {
    await page.getByLabel('Name').fill('Central High School');
    await page.getByLabel('Shortcode').fill('chs');
  }
  await page.getByRole('button', { name: 'Save campus' }).click();
  await page.getByRole('cell', { name: 'CHS', exact: true }).waitFor({ timeout: 5000 });
});
await check('settings: a duplicate shortcode is refused with a message', async () => {
  await page.getByRole('button', { name: 'Add campus' }).click();
  await page.getByLabel('Name').fill('Another');
  await page.getByLabel('Shortcode').fill('CHS');
  await page.getByRole('button', { name: 'Save campus' }).click();
  await page.getByText(/already exists/).waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: 'Cancel' }).click();
});
await check('settings: a second Campus for the filter', async () => {
  await page.getByRole('button', { name: 'Add campus' }).click();
  await page.getByLabel('Name').fill('West Elementary');
  await page.getByLabel('Shortcode').fill('wes');
  await page.getByRole('button', { name: 'Save campus' }).click();
  await page.getByRole('cell', { name: 'WES', exact: true }).waitFor({ timeout: 5000 });
});
await check('settings: a bad hostname is refused before it is sent', async () => {
  await page.getByRole('tab', { name: 'Devices' }).click();
  await page.getByRole('button', { name: 'Add device' }).click();
  await page.getByLabel('Hostname').fill('NOTAHOST');
  await page.locator('#device-campus').click();
  await page.getByRole('option', { name: 'Central High School' }).click();
  await page.getByLabel('Closet').fill('IDF 2');
  await page.getByRole('button', { name: 'Save device' }).click();
  await page.getByText(/ESP_ followed by six hex digits/).waitFor({ timeout: 5000 });
});
await check('settings: a Device is added under the Campus', async () => {
  await page.getByLabel('Hostname').fill('esp_c0ffee');
  await page.getByRole('button', { name: 'Save device' }).click();
  await page.getByRole('cell', { name: 'ESP_C0FFEE', exact: true }).waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: 'Done' }).click();
});
await check('settings: the Device closet can be edited', async () => {
  await page.getByRole('button', { name: 'Edit ESP_C0FFEE' }).click();
  const form = page.getByRole('form', { name: 'Edit ESP_C0FFEE' });
  await form.getByLabel('Closet').fill('MDF');
  await form.getByRole('button', { name: /Save/ }).click();
  await page.getByRole('cell', { name: 'MDF', exact: true }).waitFor({ timeout: 5000 });
});
await check('settings: a Campus with Devices cannot be deleted', async () => {
  await page.getByRole('tab', { name: 'Campuses' }).click();
  await page.getByRole('button', { name: 'Delete Central High School' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: /Delete/ }).click();
  await page.getByText(/still has devices/i).first().waitFor({ timeout: 5000 });
});
if (SHOTS) await page.screenshot({ path: SHOTS + '/settings.png', fullPage: true });
await check('settings: a Viewer sees the lists without the controls that change them, and no Users tab', async () => {
  const viewer = await throwawayUser(API, ADMIN, 'viewer', 'walk-viewer');
  const looking = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    await signInContext(looking, WEB, viewer);
    const viewerPage = await looking.newPage();
    await viewerPage.goto(WEB + '/settings');
    await viewerPage.getByRole('cell', { name: 'CHS', exact: true }).waitFor({ timeout: 5000 });
    expect(!(await viewerPage.getByRole('button', { name: 'Add campus' }).isVisible().catch(() => false)), 'Add campus shown to a Viewer');
    expect(!(await viewerPage.getByRole('button', { name: /^Delete / }).first().isVisible().catch(() => false)), 'Delete shown to a Viewer');
    expect(!(await viewerPage.getByRole('tab', { name: 'Users' }).isVisible().catch(() => false)), 'Users tab shown to a Viewer');
    const refused = await looking.request.post(WEB + '/api/campuses', { data: { name: 'X', shortcode: 'X' } });
    expect(refused.status() === 403, "a Viewer's change: " + refused.status());
  } finally {
    await looking.close();
    await viewer.remove();
  }
});
await check('dashboard: the new Device shows with no readings yet', async () => {
  await page.goto(WEB + '/');
  await page.getByRole('article', { name: /MDF/ }).waitFor({ timeout: 5000 });
  await page.getByText(/No readings yet/).first().waitFor();
});
await check('api: a Reading with a wrong Device token is 401', async () => expect((await reading('nope', 72)).status === 401, 'status'));
await check('api: a Reading with no token is 401', async () => expect((await reading(null, 72)).status === 401, 'status'));
await check('api: a Reading with the Admin token is 401', async () => expect((await reading(ADMIN, 72)).status === 401, 'status'));
await check('api: a Campus with the Device token is 401', async () => expect((await post('/api/campuses', DEVICE, { name: 'X', shortcode: 'X' })).status === 401, 'status'));
await check('api: a Reading for an unknown hostname is 404', async () => expect((await reading(DEVICE, 72, 41, 'ESP_000000')).status === 404, 'status'));
await check('api: a Reading missing a number is 422', async () => expect((await post('/api/readings', DEVICE, { device: 'ESP_C0FFEE', temp: 72 })).status === 422, 'status'));
await check('live: a Reading with the Device token is 201 and the card goes Online without a reload', async () => {
  const r = await reading(DEVICE, 72);
  expect(r.status === 201, 'status ' + r.status);
  const card = page.getByRole('article', { name: /MDF/ });
  await card.getByText('Online', { exact: true }).waitFor({ timeout: 8000 });
  await page.waitForTimeout(1500);
  // NumberFlow keeps each digit's value in a CSS variable inside its shadow DOM.
  const shown = await card.evaluate((el) => Array.from(el.querySelectorAll('*')).filter((n) => n.shadowRoot).map((n) => Array.from(n.shadowRoot.querySelectorAll('[part~="digit"]')).map((d) => d.style.getPropertyValue('--current').trim()).join('')));
  expect(shown[0] === '72' && shown[1] === '41', 'card digits: ' + JSON.stringify(shown));
});
await check('live: a 91 F Reading turns the card Hot, critical, live', async () => {
  expect((await reading(DEVICE, 91)).status === 201, 'status');
  const card = page.getByRole('article', { name: /MDF/ });
  await card.getByText(/Hot/).waitFor({ timeout: 8000 });
  expect(/critical/i.test(await card.innerText()), 'expected critical');
});
if (SHOTS) { await page.waitForTimeout(2000); await page.screenshot({ path: SHOTS + '/dashboard.png', fullPage: true }); }
await check('dashboard: the Campus filter narrows to one Campus and the other is empty', async () => {
  await page.getByRole('tab', { name: 'West Elementary' }).click();
  await page.waitForTimeout(600);
  expect(!(await page.getByRole('article', { name: /MDF/ }).isVisible().catch(() => false)), 'card still visible under WES');
  await page.getByRole('tab', { name: 'Central High School' }).click();
  await page.getByRole('article', { name: /MDF/ }).waitFor({ timeout: 5000 });
  await page.getByRole('tab', { name: 'All campuses' }).click();
});
await check('campuses: the sidebar opens Campuses, titled, worst first, with the Hot Campus and its week', async () => {
  await page.getByRole('navigation', { name: 'Pages' }).getByRole('link', { name: 'Campuses' }).click();
  await page.getByRole('heading', { name: 'Campuses', level: 1 }).waitFor();
  expect((await page.title()) === 'Campuses · Temperature Alarms', 'title: ' + (await page.title()));
  const rows = page.getByRole('table', { name: 'Campuses, worst first' }).getByRole('row');
  await rows.nth(1).waitFor({ timeout: 8000 });
  const first = await rows.nth(1).innerText();
  expect(/Central High School/.test(first) && /Hot/.test(first) && /critical/.test(first) && /Ongoing/.test(first), 'first row: ' + first.slice(0, 200));
  expect(/West Elementary/.test(await rows.nth(2).innerText()), 'West Elementary should follow');
  expect(/1 Campus has/.test(await page.locator('main').innerText()), 'summary does not count the Campus');
  const chart = rows.nth(1).getByRole('img');
  expect(/Today 91°F so far/.test(await chart.getAttribute('aria-label')), 'chart label: ' + (await chart.getAttribute('aria-label')));
  await page.getByText(/threshold the server uses, 82°F/).waitFor();
});
if (SHOTS) await page.screenshot({ path: SHOTS + '/campuses.png', fullPage: true });
await check('campuses: by keyboard, the Campus link opens the Dashboard filtered to it', async () => {
  const link = page.getByRole('link', { name: 'Central High School on the Dashboard' });
  await link.focus();
  await page.keyboard.press('Enter');
  await page.waitForURL(/\?campus=CHS/, { timeout: 5000 });
  await page.getByRole('article', { name: /MDF/ }).waitFor({ timeout: 5000 });
  await page.goBack();
  await page.getByRole('link', { name: /^History today: MDF, Central High School/ }).waitFor({ timeout: 5000 });
});
await check('incidents: the sidebar opens Incidents, titled, with the Hot incident ongoing today', async () => {
  await page.getByRole('navigation', { name: 'Pages' }).getByRole('link', { name: 'Incidents' }).click();
  await page.getByRole('heading', { name: 'Incidents', level: 1 }).waitFor();
  expect((await page.title()) === 'Incidents · Temperature Alarms', 'title: ' + (await page.title()));
  await page.getByRole('tab', { name: 'Today' }).click();
  expect(/window=today/.test(page.url()), 'window not in the URL: ' + page.url());
  const log = page.getByRole('region', { name: 'Incidents, oldest first' });
  const row = log.getByRole('listitem').filter({ hasText: 'ESP_C0FFEE' }).first();
  await row.waitFor({ timeout: 8000 });
  const text = await row.innerText();
  expect(/Hot/.test(text) && /ongoing/.test(text) && /critical/.test(text), 'row: ' + text.slice(0, 200));
  await log.getByRole('link', { name: /^History, / }).first().waitFor();
});
await check('incidents: a new incident arrives live at the end of the log', async () => {
  expect((await reading(DEVICE, 91, 15)).status === 201, 'status');
  const log = page.getByRole('region', { name: 'Incidents, oldest first' });
  await log.getByRole('listitem').filter({ hasText: /Dry/ }).waitFor({ timeout: 8000 });
  const rows = await log.getByRole('listitem').allInnerTexts();
  expect(/Dry/.test(rows.at(-1)), 'Dry is not the last row: ' + JSON.stringify(rows));
});
if (SHOTS) { await page.waitForTimeout(1000); await page.screenshot({ path: SHOTS + '/incidents.png', fullPage: true }); }
await check('incidents: 7 days, Previous, and Next stopping at the present, by keyboard', async () => {
  await page.getByRole('tab', { name: 'Today' }).focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForURL(/window=week/, { timeout: 5000 });
  const next = page.getByRole('button', { name: 'Next 7 days' });
  expect(await next.isDisabled(), 'Next should stop at the present');
  await page.getByRole('button', { name: 'Previous 7 days' }).focus();
  await page.keyboard.press('Enter');
  await page.waitForURL(/date=/, { timeout: 5000 });
  await page.getByText('No incidents in the 7 days to', { exact: false }).first().waitFor({ timeout: 5000 });
  expect(!(await next.isDisabled()), 'Next should be enabled on a past week');
  await next.click();
  await page.waitForURL((url) => !/date=/.test(String(url)), { timeout: 5000 });
  await page.goto(WEB + '/');
  await page.getByRole('article', { name: /MDF/ }).waitFor({ timeout: 5000 });
});
await check('api: the per-Device rate limit answers 429 after 20 Readings a minute', async () => {
  let last = 0;
  for (let i = 0; i < 20; i++) last = (await reading(DEVICE, 75)).status;
  expect(last === 429, 'expected 429, got ' + last);
});
await check('history: the day shows the Readings and the summary', async () => {
  await page.getByRole('link', { name: 'History for MDF' }).click();
  await page.getByRole('button', { name: 'Previous day' }).waitFor();
  await page.waitForTimeout(1200);
  const text = await page.locator('main').innerText();
  expect(/91/.test(text) && /72/.test(text), 'summary missing 72 or 91');
  expect((await page.getByRole('row').count()) >= 3, 'expected rows in the table');
});
if (SHOTS) await page.screenshot({ path: SHOTS + '/history.png', fullPage: true });
await check('history: the previous day is empty and Next day comes back to today', async () => {
  await page.getByRole('button', { name: 'Previous day' }).click();
  await page.getByText(/No Readings on/).waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: 'Next day' }).click();
  await page.waitForTimeout(800);
  expect(/91/.test(await page.locator('main').innerText()), 'today did not come back');
});
await check('history: after a reload the page still shows the day', async () => {
  await page.reload();
  await page.getByRole('button', { name: 'Previous day' }).waitFor();
  await page.waitForTimeout(1000);
  expect(/91/.test(await page.locator('main').innerText()), 'lost after reload');
});
await check('history: Reset history asks for confirmation and then empties the day', async () => {
  await page.getByRole('button', { name: 'Reset history' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: /Delete all Readings/ }).click();
  await page.getByText(/No Readings on/).waitFor({ timeout: 5000 });
});
await check('dashboard: after the reset the card has no readings again', async () => {
  await page.goto(WEB + '/');
  await page.getByRole('article', { name: /MDF/ }).waitFor({ timeout: 5000 });
  await page.getByText(/No readings yet/).first().waitFor({ timeout: 5000 });
});
await check('phone width: the dashboard, Incidents, and Campuses have no horizontal scroll', async () => {
  const phone = await context.newPage();
  await phone.setViewportSize({ width: 400, height: 800 });
  await phone.goto(WEB + '/');
  await phone.getByRole('heading', { name: 'Dashboard' }).waitFor();
  await phone.waitForTimeout(1000);
  const wide = await phone.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (SHOTS) await phone.screenshot({ path: SHOTS + '/dashboard-phone.png', fullPage: true });
  expect(!wide, 'page scrolls horizontally at 400px');
  await phone.goto(WEB + '/incidents?window=today');
  await phone.getByRole('heading', { name: 'Incidents', level: 1 }).waitFor();
  await phone.waitForTimeout(1000);
  const wideIncidents = await phone.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (SHOTS) await phone.screenshot({ path: SHOTS + '/incidents-phone.png', fullPage: true });
  expect(!wideIncidents, 'Incidents scrolls horizontally at 400px');
  await phone.goto(WEB + '/campuses');
  await phone.getByRole('heading', { name: 'Campuses', level: 1 }).waitFor();
  await phone.waitForTimeout(1000);
  const wideCampuses = await phone.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (SHOTS) await phone.screenshot({ path: SHOTS + '/campuses-phone.png', fullPage: true });
  expect(!wideCampuses, 'Campuses scrolls horizontally at 400px');
  await phone.close();
});
await check('settings: the Device and then the Campuses can be deleted', async () => {
  await page.goto(WEB + '/settings');
  await page.getByRole('tab', { name: 'Devices' }).click();
  await page.getByRole('button', { name: 'Delete ESP_C0FFEE' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: /Delete/ }).click();
  await page.getByRole('cell', { name: 'ESP_C0FFEE', exact: true }).waitFor({ state: 'detached', timeout: 5000 });
  await page.getByRole('tab', { name: 'Campuses' }).click();
  for (const name of ['Central High School', 'West Elementary']) {
    await page.getByRole('button', { name: 'Delete ' + name }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: /Delete/ }).click();
    await page.getByRole('cell', { name, exact: true }).waitFor({ state: 'detached', timeout: 5000 });
  }
});
await check('a11y: Skip to content is the first Tab stop and lands on the page heading', async () => {
  await page.goto(WEB + '/incidents');
  await page.getByRole('heading', { name: 'Incidents', level: 1 }).waitFor();
  await page.keyboard.press('Tab');
  expect((await page.evaluate(() => document.activeElement.textContent)) === 'Skip to content', 'first stop is not the skip link');
  await page.keyboard.press('Enter');
  expect((await page.evaluate(() => document.activeElement.tagName + ' ' + document.activeElement.textContent)) === 'H1 Incidents', 'focus did not land on the h1');
});
await check('a11y: an unknown address is a titled Page not found with a way home', async () => {
  await page.goto(WEB + '/no-such-page');
  await page.getByRole('heading', { name: 'Page not found', level: 1 }).waitFor();
  expect((await page.title()) === 'Page not found · Temperature Alarms', 'title: ' + (await page.title()));
  await page.getByRole('link', { name: 'Go to the dashboard' }).click();
  await page.getByRole('heading', { name: 'Dashboard', level: 1 }).waitFor();
});
await check('sign out: the user menu signs out to the sign-in page, and the session is over', async () => {
  await page.goto(WEB + '/');
  await page.getByRole('heading', { name: 'Dashboard', level: 1 }).waitFor();
  await page.getByRole('button', { name: /account menu/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.getByRole('heading', { name: 'Sign in', level: 1 }).waitFor({ timeout: 5000 });
  expect(new URL(page.url()).pathname === '/sign-in', 'url: ' + page.url());
  expect((await context.request.get(WEB + '/api/session')).status() === 401, 'still signed in');
});
await check('no server errors (5xx) and no console errors during the walk', async () => {
  expect(failedRequests.length === 0, 'server errors: ' + failedRequests.join(', '));
  const real = consoleErrors.filter((e) => !/401|403|404|409|422|429|Failed to load resource/.test(e));
  expect(real.length === 0, 'console: ' + real.join(' | '));
});
await browser.close();
await walker.remove();
const passed = results.filter((r) => r[0]).length;
console.log(`\n${passed} of ${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
