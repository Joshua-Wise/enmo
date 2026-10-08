// Every task by keyboard alone, with focus visible at each stop and kept inside dialogs. One line per check.
// Run against a stack with no Campuses (as walk.mjs): it adds a Campus and a Device and deletes them again.
//
//   WEB=http://localhost:8080 ADMIN_TOKEN=... node e2e/keyboard.mjs [chromium|firefox|webkit]
//
// SPREAD_ADDRESSES=1 sends a made-up X-Forwarded-For per context, for a local proxy that passes it through
// (see a11y.mjs), so repeated runs do not meet the API's per-address read limit.
// It signs in by keyboard as a throwaway Admin it adds with ADMIN_TOKEN, and deletes it at the end.
import { chromium, firefox, webkit } from 'playwright';
import { signInContext, throwawayUser } from './session.mjs';

const WEB = process.env.WEB ?? 'http://localhost:8080';
const ADMIN = process.env.ADMIN_TOKEN;
if (!ADMIN) { console.error('set ADMIN_TOKEN'); process.exit(2); }
const name = process.argv[2] ?? 'chromium';
const engine = { chromium, firefox, webkit }[name];
// WebKit, like Safari by default, leaves links out of Tab (Safari users turn on "Press Tab to highlight each item"),
// and Playwright's WebKit has no way to turn that on, so the checks that Tab to a link are skipped there.
const LINKS_TAB = name !== 'webkit';
const typist = await throwawayUser(WEB, ADMIN, 'admin', 'keyboard');
const browser = await engine.launch();
const address = () => (process.env.SPREAD_ADDRESSES ? { extraHTTPHeaders: { 'x-forwarded-for': `10.4.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` } } : {});

const results = [];
async function check(label, fn, { tabsToLinks = false } = {}) {
  if (tabsToLinks && !LINKS_TAB) { console.log('skip ' + label + ' (WebKit leaves links out of Tab)'); return; }
  try { await fn(); results.push(true); console.log('ok   ' + label); }
  catch (error) { results.push(false); console.log('FAIL ' + label + ' :: ' + String(error).split('\n')[0]); }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

/** The focused element: its tag, name, role, and whether it shows a focus indicator (an outline or a ring). */
const focusedIn = (page) => page.evaluate(() => {
  const e = document.activeElement;
  const cs = getComputedStyle(e);
  return {
    tag: e.tagName,
    text: (e.getAttribute('aria-label') || e.innerText || e.id || '').trim().slice(0, 40),
    role: e.getAttribute('role'),
    ring: (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none',
  };
});

const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...address() });
const page = await context.newPage();
const focused = () => focusedIn(page);
const key = (k) => page.keyboard.press(k);
/** Tab until `pred` holds; every control passed on the way must show focus. */
async function tabTo(pred, max = 60) {
  for (let i = 0; i < max; i++) {
    await key('Tab');
    const a = await focused();
    if (a.tag !== 'BODY' && a.tag !== 'H1' && !a.ring) throw new Error(`no visible focus on ${a.tag} "${a.text}"`);
    if (pred(a)) return a;
  }
  throw new Error('never reached');
}
const insideDialog = () => page.evaluate(() => !!document.activeElement.closest('[role=alertdialog],[role=dialog]'));

await page.goto(WEB + '/settings');
await check('sign-in: by keyboard alone, the page asked for comes back after', async () => {
  await page.getByRole('heading', { name: 'Sign in', level: 1 }).waitFor();
  let a = await focused();
  expect(a.tag === 'INPUT' && a.ring, 'focus does not start in the username field: ' + a.tag);
  await page.keyboard.type(typist.username);
  await key('Tab');
  await page.keyboard.type(typist.password);
  await key('Enter');
  await page.getByRole('heading', { name: 'Settings', level: 1 }).waitFor({ timeout: 5000 });
  a = await focused();
  expect(a.tag !== 'INPUT', 'focus left in a field that is gone: ' + a.text);
});
await page.goto(WEB + '/settings');
await page.getByRole('heading', { name: 'Settings', level: 1 }).waitFor();
await page.waitForTimeout(500);

await check('settings: loading the page leaves focus at its start', async () => {
  const a = await focused();
  expect(a.tag === 'BODY', `focus on ${a.tag} ${a.text}`);
});
await check('skip link: the first stop, and it moves focus to the page heading', async () => {
  await key('Tab');
  let a = await focused();
  expect(a.text === 'Skip to content' && a.ring, 'first stop: ' + a.text);
  await key('Enter');
  await page.waitForTimeout(100);
  a = await focused();
  expect(a.tag === 'H1' && a.text === 'Settings', `after skip: ${a.tag} ${a.text}`);
}, { tabsToLinks: true });
await check('settings: a Campus is added by keyboard', async () => {
  await tabTo((a) => a.text === 'Add campus');
  await key('Enter');
  await page.waitForTimeout(200);
  if ((await focused()).tag !== 'INPUT') await tabTo((a) => a.tag === 'INPUT');
  await page.keyboard.type('Keyboard High');
  await key('Tab');
  await page.keyboard.type('kbh');
  await key('Enter');
  await page.getByRole('cell', { name: 'KBH', exact: true }).waitFor({ timeout: 5000 });
});
await check('settings: the Devices tab is reached with the arrow keys', async () => {
  await page.getByRole('tab', { name: 'Campuses' }).focus();
  await key('ArrowRight');
  await page.waitForTimeout(300);
  const a = await focused();
  expect(a.text === 'Devices' && /tab=devices/.test(page.url()), `tab: ${a.text} ${page.url()}`);
});
await check('settings: a Device is added by keyboard, its Campus picked from the list with the arrows', async () => {
  await tabTo((a) => a.text === 'Add device');
  await key('Enter');
  await page.waitForTimeout(200);
  if ((await focused()).tag !== 'INPUT') await tabTo((a) => a.tag === 'INPUT');
  await page.keyboard.type('ESP_ABCDEF');
  await key('Tab');
  let a = await focused();
  expect(a.role === 'combobox', `expected the Campus list, got ${a.tag} ${a.text}`);
  await key('Enter');
  await page.getByRole('listbox').waitFor();
  await key('ArrowDown');
  await key('Enter');
  await page.waitForTimeout(200);
  a = await focused();
  expect(a.role === 'combobox' && /Keyboard High/.test(a.text), 'after the pick: ' + a.text);
  await key('Tab');
  await page.keyboard.type('IDF 9');
  await key('Enter');
  await page.getByRole('cell', { name: 'ESP_ABCDEF', exact: true }).waitFor({ timeout: 5000 });
});
await check('settings: a delete dialog keeps focus inside, Escape cancels it, and focus returns to its button', async () => {
  await page.getByRole('button', { name: 'Delete ESP_ABCDEF' }).focus();
  await key('Enter');
  await page.getByRole('alertdialog').waitFor();
  for (let i = 0; i < 4; i++) {
    await key('Tab');
    expect(await insideDialog(), 'focus left the dialog');
    expect((await focused()).ring, 'no visible focus in the dialog');
  }
  await key('Escape');
  await page.getByRole('alertdialog').waitFor({ state: 'detached' });
  const a = await focused();
  expect(a.text === 'Delete ESP_ABCDEF', 'focus returned to ' + a.text);
});
await check('navigation: a sidebar link by keyboard moves focus to the new page heading', async () => {
  await page.getByRole('navigation', { name: 'Pages' }).getByRole('link', { name: 'Dashboard' }).focus();
  await key('Enter');
  await page.getByRole('heading', { name: 'Dashboard', level: 1 }).waitFor();
  await page.waitForTimeout(300);
  const a = await focused();
  expect(a.tag === 'H1' && a.text === 'Dashboard', `focus on ${a.tag} ${a.text}`);
});
await check('history: opened from a card by keyboard; the Reset dialog closes on Escape back to its button', async () => {
  await tabTo((a) => /^History for/.test(a.text));
  await key('Enter');
  await page.getByRole('button', { name: 'Previous day' }).waitFor();
  await page.waitForTimeout(500);
  let a = await focused();
  expect(a.tag === 'H1', `focus on ${a.tag} ${a.text}`);
  await tabTo((x) => x.text === 'Reset history');
  await key('Enter');
  await page.getByRole('alertdialog').waitFor();
  await key('Escape');
  await page.getByRole('alertdialog').waitFor({ state: 'detached' });
  a = await focused();
  expect(a.text === 'Reset history', 'focus back on ' + a.text);
}, { tabsToLinks: true });
await check('history: Previous day, then Today, by keyboard', async () => {
  await tabTo((a) => a.text === 'Previous day');
  await key('Enter');
  await page.getByText(/No Readings on/).waitFor({ timeout: 5000 });
  await tabTo((a) => a.text === 'Today');
  await key('Enter');
  await page.waitForURL((url) => !/date=/.test(String(url)), { timeout: 5000 });
}, { tabsToLinks: true });
await check('incidents: the window by the arrow keys, Previous by Enter', async () => {
  await page.goto(WEB + '/incidents');
  await page.getByRole('heading', { name: 'Incidents', level: 1 }).waitFor();
  await tabTo((a) => a.role === 'tab');
  await key('ArrowRight');
  await page.waitForURL(/window=today/);
  await tabTo((a) => /^Previous/.test(a.text));
  await key('Enter');
  await page.waitForURL(/date=/);
});
await check('campuses and the 404: every stop shows focus, and the 404 leads home by keyboard', async () => {
  await page.goto(WEB + '/campuses');
  await page.getByRole('heading', { name: 'Campuses', level: 1 }).waitFor();
  for (let i = 0; i < 15; i++) {
    await key('Tab');
    const a = await focused();
    if (a.tag === 'BODY') break;
    expect(a.ring, 'no visible focus on ' + a.text);
  }
  await page.goto(WEB + '/nowhere');
  await page.getByRole('heading', { name: 'Page not found', level: 1 }).waitFor();
  await tabTo((a) => a.text === 'Go to the dashboard');
  await key('Enter');
  await page.getByRole('heading', { name: 'Dashboard', level: 1 }).waitFor();
}, { tabsToLinks: true });
await check('settings: the Device and the Campus are deleted by keyboard through their dialogs', async () => {
  await page.goto(WEB + '/settings?tab=devices');
  for (const [tab, target] of [['devices', 'ESP_ABCDEF'], ['campuses', 'Keyboard High']]) {
    if (tab === 'campuses') await page.goto(WEB + '/settings');
    await page.getByRole('button', { name: 'Delete ' + target }).focus();
    await key('Enter');
    await page.getByRole('alertdialog').waitFor();
    await tabTo((a) => /^Delete/.test(a.text) && a.text !== 'Delete ' + target, 5);
    await key('Enter');
    await page.getByRole('cell', { name: target, exact: true }).waitFor({ state: 'detached', timeout: 5000 });
  }
});

const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, ...address() });
await signInContext(phone, WEB, typist);
const small = await phone.newPage();
await check('phone: the sidebar sheet opens by keyboard, keeps focus, and Escape closes it back to its trigger', async () => {
  await small.goto(WEB + '/');
  await small.getByRole('heading', { name: 'Dashboard', level: 1 }).waitFor();
  await small.waitForTimeout(600);
  let a;
  for (let i = 0; i < 4; i++) {
    await small.keyboard.press('Tab');
    a = await focusedIn(small);
    if (a.text === 'Toggle Sidebar') break;
  }
  expect(a.text === 'Toggle Sidebar', 'did not reach the trigger: ' + a.text);
  await small.keyboard.press('Enter');
  await small.getByRole('dialog').waitFor();
  for (let i = 0; i < 10; i++) {
    await small.keyboard.press('Tab');
    expect(await small.evaluate(() => !!document.activeElement.closest('[role=dialog]')), 'focus left the sheet');
  }
  await small.keyboard.press('Escape');
  await small.getByRole('dialog').waitFor({ state: 'detached' });
  a = await focusedIn(small);
  expect(a.text === 'Toggle Sidebar', 'focus returned to ' + a.text);
});

await browser.close();
await typist.remove();
const passed = results.filter(Boolean).length;
console.log(`\n${name}: ${passed} of ${results.length} keyboard checks passed`);
process.exit(passed === results.length ? 0 : 1);
