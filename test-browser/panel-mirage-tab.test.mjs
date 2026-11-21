// @test-kind contract: the Lense panel's Mirage tab and Tweaks persona picker are Paqvilo's own designed user interface
// The runtime card left Inspect and Tweaks for a Mirage tab; Tweaks says who this browser is on one line and signs in
// from the persona row itself, with the panel's rows, group headers, icon buttons and toggle chips.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { panelUi } from '../lense/panel-ui.mjs';
import { panelSession } from './helpers/panel-session.mjs';

// Routed entirely by page.route; nothing listens on this loopback port.
const origin = 'http://127.0.0.1:11113';
let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

const people = [
  {
    contactId: 'ann',
    key: 'ann',
    name: 'Ann Invented',
    group: 'g1',
    subgroup: 's1',
    roles: ['Readers'],
    tags: ['reader'],
  },
  {
    contactId: 'bo',
    key: 'bo',
    label: 'Bo the writer',
    name: 'Bo Invented',
    description: 'Writes invented records.\nSecond line.',
    group: 'g1',
    subgroup: 's1',
    roles: ['Writers'],
  },
  { contactId: 'cy', key: 'cy', name: 'Cy Invented', group: '__other', roles: [] },
];
const tweaks = (session) => ({
  ok: true,
  permissionMode: 'enforce',
  permissionSource: 'exported',
  personas: people,
  personaIndex: people.map((person) => ({
    key: person.key,
    text: person.name.toLowerCase(),
    roles: person.roles.map((role) => role.toLowerCase()),
    tags: person.tags ?? [],
    accounts: [],
    group: person.group,
    subgroup: person.subgroup,
  })),
  personaCatalog: { groups: [{ id: 'g1', label: 'Invented group', subgroups: [{ id: 's1', label: 'Signed in' }] }] },
  session,
  presets: [],
  scenarios: [],
  tables: ['sample_entry'],
  status: { confinePortalPages: false, contentPolicySource: 'runtime state' },
});
const anonymous = {
  supported: true,
  signedIn: false,
  roles: ['Anonymous Users'],
  identityProvider: { available: false, reason: 'No external identity provider is configured.' },
};

test('Inspect starts with the inspection, and the Mirage tab holds the runtime and its _sim pages as rows', async (t) => {
  const { state, page } = await panelSession(t, browser, origin);
  const calls = [];
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/__paqvilo/api/')) {
      const action = url.pathname.split('/').at(-1);
      calls.push(action);
      return route.fulfill({ json: action === 'tweaks' ? tweaks(anonymous) : { ok: true } });
    }
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><main>Invented page</main>' });
  });
  await page.goto(origin + '/entries/');
  const panel = (selector) => page.locator('#paqvilo-panel').locator(selector);
  state.ui = { open: true, tab: 'mirage' };
  state.mirageMode = true;
  state.mirage = {
    active: true,
    version: 1,
    mode: 'local-runtime',
    status: {
      site: 'Invented site',
      format: 'standard',
      revision: 3,
      sourceFingerprint: 'abcdef0123456789',
      diagnostics: 2,
    },
  };
  await page.evaluate(panelUi, state);
  const runtime = panel('.row').filter({ hasText: 'Invented site' });
  // The revision says the runtime moved on; a source fingerprint says nothing to the user.
  await runtime.getByText('revision 3', { exact: true }).waitFor();
  assert.deepEqual(await panel('.body .row .name > span:first-child').allInnerTexts(), [
    'Invented site',
    'Diagnostics',
    'Requests for this page',
    'Content policy',
    'Personas & permissions',
    'Settings & snippets',
    'Administration',
    'Local URL',
    'sample_entry',
  ]);
  // Every _sim page is one row: its name opens it, and so does its icon button.
  const requests = panel('.row').filter({ hasText: 'Requests for this page' });
  assert.equal(await requests.locator('[data-act="sim"]').count(), 2);
  assert.equal(
    await requests.locator('[data-act="sim"]').first().getAttribute('data-hash'),
    'audit?path=%2Fentries%2F',
  );
  assert.equal(await panel('.row').filter({ hasText: 'Local URL' }).locator('.ib[data-act="copypage"]').count(), 1);
  assert.equal(await panel('.body .src, .body .srcs').count(), 0, 'no text-link rows');

  state.ui = { open: true, tab: 'runtime' };
  await page.evaluate(panelUi, state);
  await panel('[role=tab][data-v=runtime]').click();
  assert.equal(
    await panel('.body').getByText('Invented site', { exact: false }).count(),
    0,
    'Inspect has no runtime card',
  );
  assert.equal(await panel('.body [data-act="copypage"]').count(), 0);
  assert.equal(await panel('.body [data-act="sim"], .body [data-act="admin"]').count(), 0, 'no _sim rows in Inspect');
});

test('Tweaks says who this browser is on one line, and each persona row signs in', async (t) => {
  const { state, page } = await panelSession(t, browser, origin);
  let session = anonymous;
  const signins = [];
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/__paqvilo/api/')) {
      const action = url.pathname.split('/').at(-1);
      if (action === 'signin') signins.push(route.request().postDataJSON());
      return route.fulfill({ json: action === 'tweaks' ? tweaks(session) : { ok: true } });
    }
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><main>Invented page</main>' });
  });
  await page.goto(origin);
  const panel = (selector) => page.locator('#paqvilo-panel').locator(selector);
  state.ui = { open: true, tab: 'tweaks' };
  state.mirageMode = true;
  state.mirage = { active: true, version: 1, status: {} };
  await page.evaluate(panelUi, state);
  const card = panel('.card').filter({ hasText: 'Browser session' });
  const who = card.locator('.who');
  await who.waitFor();
  assert.equal(await who.innerText(), 'Not signed in · Anonymous Users');
  // "Anonymous" once, on that line; how the portal signs in is its tooltip.
  assert.equal((await card.locator('.path, .who, .dim').allInnerTexts()).join(' ').match(/anonymous/gi).length, 1);
  assert.equal(
    await who.getAttribute('title'),
    'Signs in on the local sign-in page; no external identity provider is configured.',
  );
  assert.equal(await card.getByText('Selected:', { exact: false }).count(), 0);
  assert.equal(await card.locator('select, input[type=checkbox], details').count(), 0, 'no native filter boxes');

  // One header per group and subgroup, in the panel's group-header style; rows are the panel's rows.
  assert.deepEqual(await card.locator('.gh > span:not(.n):not(.line)').allInnerTexts(), [
    'Invented group / Signed in',
    'Other contacts',
  ]);
  const bo = card.locator('[data-panel-persona-row="bo"]');
  assert.equal(await bo.locator('.name > span:first-child').innerText(), 'Bo the writer');
  assert.equal(
    await bo.locator('.name .what').innerText(),
    'Bo Invented',
    'the contact name only where the label differs',
  );
  assert.deepEqual(await bo.locator('.sub').allInnerTexts(), ['Writes invented records.', 'Writers']);
  const ann = card.locator('[data-panel-persona-row="ann"]');
  assert.equal(await ann.locator('.name .what').count(), 0, 'a name is shown once');
  // The persona list scrolls with the tab: no scroll box of its own.
  assert.equal(
    await card.locator('[data-panel-persona-results]').evaluate((node) => getComputedStyle(node).overflowY),
    'visible',
  );
  // The count is announced, and shown only when the list is paged.
  assert.equal(await card.locator('[data-panel-persona-count]').getAttribute('class'), 'sr');

  // Filters are toggle chips behind the filter icon button; clearing is an icon shown only while something is set.
  assert.equal(await card.locator('[data-act="persona-clear"]').count(), 0);
  await card.locator('[data-act="persona-filters"]').click();
  // Every facet starts with the same "any" chip, its values beside it in a column of their own.
  const facets = card.locator('.pp-facet');
  for (const facet of await facets.all()) {
    assert.equal(await facet.locator('.pp-chips > :first-child').innerText(), 'any');
    assert.equal(await facet.locator('.pp-chips > :first-child').getAttribute('data-act'), 'persona-any');
  }
  await card.locator('[data-act="persona-any"][data-facet="tags"]').click();
  assert.deepEqual(
    await card
      .locator('[data-panel-persona-row]')
      .evaluateAll((rows) => rows.map((row) => row.dataset.panelPersonaRow)),
    ['ann'],
    'only personas with a tag',
  );
  await card.locator('[data-act="persona-any"][data-facet="tags"]').click();
  await card.locator('[data-act="persona-facet"][data-facet="roles"][data-v="Writers"]').click();
  assert.deepEqual(
    await card
      .locator('[data-panel-persona-row]')
      .evaluateAll((rows) => rows.map((row) => row.dataset.panelPersonaRow)),
    ['bo'],
  );
  assert.equal(await card.locator('[data-act="persona-filters"]').getAttribute('aria-label'), 'Filters · 1 active');
  await card.locator('[data-act="persona-clear"]').click();
  assert.equal(await card.locator('[data-panel-persona-row]').count(), 3);
  // The clear button is gone with the filters: focus stays in the picker, on its search, not on the tab strip.
  const search = card.locator('[data-panel-persona-query]');
  assert.equal(await search.evaluate((node) => node.matches(':focus')), true);

  // Esc in a filled persona search clears it, and the list with it; the panel stays open.
  await search.fill('ann');
  assert.equal(await card.locator('[data-panel-persona-row]').count(), 1);
  await search.press('Escape');
  assert.equal(await search.inputValue(), '');
  assert.equal(await card.locator('[data-panel-persona-row]').count(), 3);
  assert.equal(await panel('.panel').isVisible(), true);
  // "/" on Tweaks goes to the persona search.
  await panel('[role=tab][data-v=tweaks]').focus();
  await page.keyboard.press('/');
  assert.equal(await search.evaluate((node) => node.matches(':focus')), true);

  // The search shows its "/" key like the other tabs' filter boxes.
  assert.equal(await card.locator('.search kbd').innerText(), '/');
  // The star makes a persona a favorite: it moves to Favorites and is not listed twice.
  assert.match(await ann.locator('[data-act="pinpersona"]').getAttribute('title'), /^Add Ann Invented to favorites/);
  await ann.locator('[data-act="pinpersona"]').click();
  assert.match(await card.locator('[data-group="persona:pinned"] .gh').innerText(), /^Favorites/);
  assert.match(
    await card.locator('[data-act="pinpersona"][data-key="ann"]').getAttribute('title'),
    /^Remove Ann Invented from favorites/,
  );
  assert.equal(await card.locator('[data-panel-persona-row="ann"]').count(), 1);
  assert.equal(await card.locator('[data-group="persona:pinned"] [data-panel-persona-row="ann"]').count(), 1);
  assert.equal(await card.locator('[data-act="pinpersona"][data-key="ann"]').getAttribute('aria-pressed'), 'true');

  // The row's own button signs this browser in as that persona.
  const signIn = card.locator('[data-panel-persona-row="bo"] [data-act="signin"]');
  assert.equal(await signIn.getAttribute('aria-label'), 'Sign in as Bo the writer');
  await signIn.click();
  await page.waitForFunction(() => document.getElementById('paqvilo-panel').shadowRoot.querySelector('.toast.show'));
  assert.deepEqual(signins, [{ contactId: 'bo' }]);

  // Signed in: one line with the name and roles, and Sign out beside it.
  session = {
    supported: true,
    signedIn: true,
    contactId: 'bo',
    name: 'Bo Invented',
    roles: ['Authenticated Users', 'Writers'],
  };
  state.mirage = { active: true, version: 2, status: {} };
  await page.evaluate(panelUi, state);
  await who.getByText('Bo Invented', { exact: true }).waitFor();
  assert.equal(await who.innerText(), 'Signed in as Bo Invented · Authenticated Users, Writers\nSign out');
  // The persona this browser is signed in as is marked in the list; signing in as it again is not offered.
  const current = card.locator('[data-panel-persona-row="bo"]');
  assert.equal(await current.getAttribute('aria-current'), 'true');
  assert.equal(await current.locator('.c.ok').innerText(), 'signed in');
  assert.equal(await current.locator('[data-act="signin"]').isDisabled(), true);
  assert.equal(await card.locator('[data-panel-persona-row="ann"]').getAttribute('aria-current'), null);
  assert.equal(await card.locator('[data-panel-persona-row="ann"] [data-act="signin"]').isDisabled(), false);
});
