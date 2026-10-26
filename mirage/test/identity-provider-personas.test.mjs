import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'parse5';
import { startIdentityProvider } from '../lib/identity-provider.mjs';
import { identityProviderSettings, newUserPolicy } from '../lib/identity-provider-settings.mjs';

import { identityChooserFixture } from './fixtures/identity-chooser.mjs';
import { personaFixture } from './fixtures/persona-catalog.mjs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../lense/config.mjs';
import { identityProviderAssets } from '../lib/identity-provider-settings.mjs';
import { chooserSearch, chooserSelection, chooserResults, chooserReport } from '../lib/persona-chooser.mjs';
import { indexPersonaCatalog } from '../lib/persona-search.mjs';
const nodes = (html) => {
  const all = [];
  const visit = (node) => {
    all.push(node);
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(parse(html));
  return all;
};
const attr = (node, name) => node.attrs?.find((a) => a.name === name)?.value;

test('bounded account facets retain a selected value when URL spelling differs in case', () => {
  const { report } = identityChooserFixture(250);
  report.personas.forEach((persona, index) => (persona.account = { id: `account-${index}`, name: `Account ${index}` }));
  for (const account of ['ACCOUNT-249', 'ACCOUNT 249']) {
    const html = chooserSearch(report, new URLSearchParams({ account }), '/', '');
    const selected = nodes(html).find((node) => node.tagName === 'option' && attr(node, 'value') === 'account-249');
    assert.ok(selected);
    assert.equal(attr(selected, 'selected'), '');
    assert.match(html, /first 100 values/);
  }
});

// Wall time is compared across sizes, never against an absolute budget: 10x the personas may cost at most 30x the time
// (linear work measures about 2-5x; a quadratic chooser would be about 100x).
const chooserMs = {};
for (const count of [500, 5000])
  test(`identity chooser bounds markup and search at ${count} personas`, async (t) => {
    const { users, report, provider, params } = identityChooserFixture(count);
    const idp = await startIdentityProvider({
      providers: () => [provider],
      users: () => users,
      personaCatalog: () => report,
      registration: () => ({ registration: false }),
    });
    t.after(() => idp.close());
    const url = new URL(idp.authority(provider) + 'oauth2/authorize');
    url.search = new URLSearchParams(params);
    // The best of three identical requests, so one scheduling stall on a loaded runner does not decide the ratio.
    let response, html;
    chooserMs[count] = Infinity;
    for (let sample = 0; sample < 3; sample++) {
      const started = performance.now();
      response = await fetch(url);
      html = await response.text();
      chooserMs[count] = Math.min(chooserMs[count], performance.now() - started);
    }
    assert.equal(response.status, 200);
    assert.ok(Buffer.byteLength(html) <= 150000);
    if (count === 5000)
      assert.ok(
        chooserMs[5000] < Math.max(30 * chooserMs[500], 50),
        `5000 personas took ${chooserMs[5000]}ms, 500 took ${chooserMs[500]}ms`,
      );
    const all = nodes(html);
    assert.equal(all.filter((n) => n.tagName === 'form').length, 2);
    assert.equal(all.filter((n) => n.tagName === 'button' && attr(n, 'name') === 'subject').length, 50);
    assert.match(html, /Group 19/);
    assert.match(html, /Show more/);
    assert.doesNotMatch(html, /id="paqvilo-mirage-idp-create"/);
    url.searchParams.set('q', 'orsted unique');
    const filtered = await fetch(url).then((r) => r.text());
    assert.match(filtered, /1–1 of 1 matching/);
    assert.match(filtered, /Ørsted Unique/);
    assert.doesNotMatch(filtered, /name="subject" value="subject-1"/);
    url.searchParams.delete('q');
    url.searchParams.append('role', 'Reviewer');
    url.searchParams.append('tag', 'special');
    const narrowed = await fetch(url).then((r) => r.text());
    assert.match(narrowed, new RegExp(`of ${users.filter((u, i) => i % 2 && i % 3 === 0).length} matching`));
    const forged = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ...params,
        subject: 'new',
        given_name: 'New',
        family_name: 'User',
        email: 'new@example.test',
      }),
    });
    assert.equal(forged.status, 403);
    assert.match(await forged.text(), /Registration is disabled.*Enabled/);
    const signed = await fetch(url, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, subject: 'subject-49' }),
    });
    assert.equal(signed.status, 302);
    assert.ok(new URL(signed.headers.get('location')).searchParams.get('code'));
    url.searchParams.set('prompt', 'create');
    assert.match(await fetch(url).then((r) => r.text()), /Forced registration test/);
  });

test('registration modes and presentation settings are explicit and validated', () => {
  assert.equal(newUserPolicy(identityProviderSettings(), { registration: false }, { key: 'Local' }).allowed, false);
  assert.equal(
    newUserPolicy(
      identityProviderSettings(),
      { registration: true, openRegistration: false, invitation: false },
      { key: 'Local' },
    ).allowed,
    false,
  );
  assert.equal(
    newUserPolicy(identityProviderSettings({ newUser: 'always' }), { registration: false }, { key: 'Local' }).forced,
    true,
  );
  assert.equal(
    newUserPolicy(identityProviderSettings({ newUser: 'never' }), {}, {}, { prompt: 'create' }).allowed,
    false,
  );
  for (const [value, message] of [
    [{ newUser: 'maybe' }, /newUser must be auto, always or never/],
    [{ presentation: 'iframe' }, /presentation must be page or dialog/],
    [{ accentColor: 'red;url(x)' }, /six-digit hex color/],
    [{ unexpected: true }, /Unknown mirage\.identityProvider\.unexpected/],
    [{ head: { scripts: 'x.js' } }, /head\.scripts must be an array of project file paths/],
  ])
    assert.throws(() => identityProviderSettings(value), message);
});

test('runtime identity provider receives the effective state/pack catalogue and site registration flags', async (t) => {
  const { app, call } = await personaFixture(t, { count: 500, curated: 490, groupCount: 20 });
  const settings = {
    'Authentication/Registration/Enabled': 'False',
    'Authentication/Registration/LocalLoginEnabled': 'False',
    'Authentication/OpenIdConnect/Local/Authority': 'https://idp.example.test/tenant/',
    'Authentication/OpenIdConnect/Local/ClientId': 'synthetic-client',
    'Authentication/OpenIdConnect/Local/ResponseType': 'id_token',
    'Authentication/OpenIdConnect/Local/Scope': 'openid profile',
  };
  const updated = await call('/config', 'PATCH', {
    portalOverrides: { settings },
    identity: { ...app.state().config.identity, roles: [] },
  });
  assert.equal(updated.response.status, 200, JSON.stringify(updated.value));
  const session = await fetch(app.url + '/_sim/api/session').then((r) => r.json()),
    provider = session.identityProvider.providers[0];
  assert.ok(provider);
  const challenge = await fetch(app.url + '/Account/Login/ExternalLogin?returnUrl=%2F', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ provider: provider.id, __RequestVerificationToken: app.csrf }),
  });
  assert.equal(challenge.status, 302);
  const html = await fetch(challenge.headers.get('location')).then((r) => r.text());
  assert.match(html, /Group 19/);
  assert.match(html, /Default/);
  assert.match(html, /500 available/);
  assert.match(html, /Other contacts/);
  assert.doesNotMatch(html, /id="paqvilo-mirage-idp-create"/);
});

test('catalogue/default chooser settings and project-local head assets are validated', async (t) => {
  const parent = await fs.mkdtemp(path.join(tmpdir(), 'chooser-project-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'project');
  await fs.mkdir(root);
  await fs.writeFile(path.join(parent, 'outside.css'), 'body{}');
  await fs.writeFile(path.join(root, 'identity.css'), 'body{}');
  const file = path.join(root, 'paqvilo.config.yml');
  await fs.writeFile(
    file,
    'defaults:\n  mirage:\n    identityProvider:\n      presentation: dialog\n      newUser: never\n      head:\n        stylesheets: [./identity.css]\nsites:\n  demo:\n    source: portal\n    environments:\n      dev: https://example.test\n',
  );
  const cfg = await loadConfig({ config: file, site: 'demo' }, {}, { checkSource: false });
  assert.equal(cfg.mirageConfig.identityProvider.presentation, 'dialog');
  assert.equal(cfg.mirageConfig.identityProvider.newUser, 'never');
  assert.throws(
    () => identityProviderAssets(identityProviderSettings({ head: { stylesheets: ['../outside.css'] } }), root),
    /inside the project/,
  );
  await fs.symlink(parent, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(
    () => identityProviderAssets(identityProviderSettings({ head: { stylesheets: ['escape/outside.css'] } }), root),
    /inside the project/,
  );
});

test('chooser pages follow groups and subgroups while the matching default remains discoverable', () => {
  const { report } = identityChooserFixture(500);
  report.personas.forEach((p, i) => {
    p.label = `Label ${String(499 - i).padStart(3, '0')}`;
    p.default = i === 499;
  });
  const selected = chooserSelection(report);
  assert.deepEqual([...new Set(selected.rows.map((row) => row.persona.group))], ['group-0', 'group-1']);
  assert.equal(selected.rows.filter((row) => row.persona.group === 'group-0').length, 25);
  const html = chooserResults(report, new URLSearchParams(), '/authorize');
  const all = nodes(html),
    defaults = all
      .filter((n) => n.tagName === 'section')
      .find((n) => n.childNodes?.some((c) => c.tagName === 'h2' && c.childNodes?.[0]?.value === 'Default'));
  assert.ok(defaults);
  assert.match(html, /<h2>Default<\/h2>[\s\S]*?value="subject-499"/);
  for (const group of report.groups.slice(2))
    assert.ok(
      all.some(
        (n) =>
          n.tagName === 'a' &&
          attr(n, 'data-chooser-group-link') !== undefined &&
          new URL(attr(n, 'href'), 'http://localhost').searchParams.get('group') === group.id,
      ),
    );
  report.other = Array.from({ length: 9 }, (_, i) => ({
    contactId: `other-${i}`,
    subject: `other-${i}`,
    name: `A Other ${i}`,
  }));
  const withOther = { ...report },
    initialPage = chooserResults(withOther, new URLSearchParams(), '/authorize');
  const otherLink = nodes(initialPage).find(
    (node) =>
      node.tagName === 'a' &&
      attr(node, 'data-chooser-group-link') !== undefined &&
      new URL(attr(node, 'href'), 'http://localhost').searchParams.get('group') === '__other',
  );
  assert.ok(otherLink);
  const followed = new URL(attr(otherLink, 'href'), 'http://localhost').searchParams;
  const others = chooserResults(withOther, followed, '/authorize');
  assert.match(others, /1–9 of 9 matching/);
  const selectedOther = nodes(chooserSearch(withOther, followed, '/authorize', '')).find(
    (node) => node.tagName === 'option' && attr(node, 'value') === '__other',
  );
  assert.ok(selectedOther);
  assert.equal(attr(selectedOther, 'selected'), '');
  assert.equal(selectedOther.childNodes[0].value, 'Other contacts');
  assert.equal(
    nodes(chooserSearch({ ...report, other: [] }, new URLSearchParams(), '/authorize', '')).some(
      (node) => node.tagName === 'option' && attr(node, 'value') === '__other',
    ),
    false,
  );
  const filtered = chooserResults(report, new URLSearchParams({ group: 'group-0' }), '/authorize');
  assert.doesNotMatch(filtered, /<h2>Default<\/h2>/);
});

test('persona authorize requests reuse an ordered index and invalidate changed contacts', (t) => {
  const report = {
    groups: [{ id: 'members' }],
    personas: Array.from({ length: 5000 }, (_, i) => ({
      key: 'p' + i,
      contactId: String(i),
      label: 'Person ' + (5000 - i),
      group: 'members',
    })),
    enabled: true,
  };
  const users = report.personas.map((persona) => ({
    contactId: persona.contactId,
    subject: 'subject-' + persona.contactId,
  }));
  const localeCompare = String.prototype.localeCompare,
    sort = Array.prototype.sort;
  let catalogueSorts = 0;
  t.mock.method(String.prototype, 'localeCompare', function (other, ...options) {
    assert.equal(
      options.length,
      0,
      'display comparisons must reuse the module collator rather than supply locales/options per comparison',
    );
    return localeCompare.call(this, other);
  });
  // MockTracker rejects arrays as method targets, including Array.prototype.
  t.after(() => {
    Array.prototype.sort = sort;
  });
  Array.prototype.sort = function (...args) {
    if (this.length === 5000) catalogueSorts++;
    return sort.apply(this, args);
  };
  const first = chooserReport(report, users),
    second = chooserReport(report, structuredClone(users));
  const index = chooserSelection(first).index;
  assert.equal(first, second);
  assert.equal(index.length, 5000);
  assert.equal(index, chooserSelection(second, new URLSearchParams('q=Person')).index);
  assert.equal(
    index,
    chooserSelection(structuredClone(first)).index,
    'equal catalogue contents reuse ordering across report objects',
  );
  assert.equal(catalogueSorts, 1, 'unchanged authorize queries sort the catalogue once');
  users[0].subject = 'changed';
  const changed = chooserReport(report, users);
  assert.notEqual(changed, first);
  assert.equal(chooserSelection(changed).index.find((entry) => entry.key === 'p0').persona.subject, 'changed');
  assert.equal(catalogueSorts, 2, 'a changed contact invalidates the cached index');
  const refreshed = {
    ...report,
    personas: report.personas.map((persona) => (persona.key === 'p0' ? { ...persona, label: 'AAA' } : persona)),
  };
  assert.equal(chooserSelection(chooserReport(refreshed, users)).index[0].key, 'p0');
  assert.equal(catalogueSorts, 3, 'a changed catalogue invalidates display ordering');
  const direct = indexPersonaCatalog(report);
  assert.deepEqual(
    direct.slice(0, 3).map((entry) => entry.persona.label),
    ['Person 1', 'Person 10', 'Person 100'],
  );
});
