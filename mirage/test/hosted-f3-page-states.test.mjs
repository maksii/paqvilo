// @test-kind observation: hosted session F3 (two agreeing runs a and b, D:\Repos\paqvilo-developer\hosted-f3 evidence summary-F3.md, AUTH-07e and PAGE-05c) captured these page-state answers and publishing-state writes; invented exports replay them locally.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { modelDrivenFixture } from './model-driven-fixture.mjs';

const HOME = 'aaaaaaaa-0000-4000-8000-000000000001';
const INACTIVE = 'aaaaaaaa-0000-4000-8000-000000000002';
const INACTIVE_CHILD = 'aaaaaaaa-0000-4000-8000-000000000003';
const ORPHAN = 'aaaaaaaa-0000-4000-8000-000000000004';
const MISSING = 'aaaaaaaa-0000-4000-8000-0000000000ff';
const DRAFT_PARENT = 'aaaaaaaa-0000-4000-8000-000000000005';
const DRAFT_CHILD = 'aaaaaaaa-0000-4000-8000-000000000006';
const LAYOUT = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const TEMPLATE = 'aaaaaaaa-0000-4000-8000-0000000000a2';
const DRAFT = 'aaaaaaaa-0000-4000-8000-0000000000d1';

const page = (id, name, partial, extra = '') =>
  `adx_webpageid: ${id}\nadx_name: ${name}\nadx_title: ${name}\nadx_partialurl: ${partial}\nadx_isroot: true\n` +
  `adx_pagetemplateid: ${LAYOUT}\n${extra}`;

async function start(t) {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'pp-page-states-'));
  ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true }));
  const files = {
    'website.yml': 'adx_websiteid: bbbbbbbb-0000-4000-8000-000000000001\nadx_name: Invented states\n',
    'publishingstate.yml': `- adx_publishingstateid: ${DRAFT}\n  adx_name: Draft\n  adx_isvisible: false\n`,
    'page-templates/Layout.pagetemplate.yml': `adx_pagetemplateid: ${LAYOUT}\nadx_name: Layout\nadx_webtemplateid: ${TEMPLATE}\n`,
    'web-templates/Body.webtemplate.yml': `adx_webtemplateid: ${TEMPLATE}\nadx_name: Body\n`,
    'web-templates/Body.webtemplate.source.html': '<p id="state">[{{ page.title }}|{{ page.parent.title }}]</p>',
    'web-pages/Home.webpage.yml': page(HOME, 'Home', '/'),
    'web-pages/Inactive.webpage.yml': page(
      INACTIVE,
      'Inactive parent',
      'inactive',
      `adx_parentpageid: ${HOME}\nstatecode: 1\n`,
    ),
    'web-pages/InactiveChild.webpage.yml': page(
      INACTIVE_CHILD,
      'Child of inactive',
      'child',
      `adx_parentpageid: ${INACTIVE}\n`,
    ),
    'web-pages/Orphan.webpage.yml': page(ORPHAN, 'Orphan', 'orphan', `adx_parentpageid: ${MISSING}\n`),
    'web-pages/DraftParent.webpage.yml': page(
      DRAFT_PARENT,
      'Draft parent',
      'draft-parent',
      `adx_parentpageid: ${HOME}\nadx_publishingstateid: ${DRAFT}\n`,
    ),
    'web-pages/DraftChild.webpage.yml': page(
      DRAFT_CHILD,
      'Child of draft',
      'child',
      `adx_parentpageid: ${DRAFT_PARENT}\n`,
    ),
  };
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await fs.writeFile(path.join(directory, file), content);
  }
  const app = await createSimulator({ sourceDir: directory, watch: false });
  ownedFixture(t).add(() => app.close());
  return app;
}

test('AUTH-07e: a missing or inactive parent page answers 404 for the page and its child', async (t) => {
  const app = await start(t);
  for (const route of ['/inactive/', '/inactive/child/', '/orphan/']) {
    const response = await fetch(app.url + route, { redirect: 'manual' });
    assert.equal(response.status, 404, route);
  }
  const home = await fetch(app.url + '/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /\[Home\|\]/);
});

test('AUTH-07e: a published child of a draft parent answers 200 with page.parent empty for anonymous', async (t) => {
  const app = await start(t);
  const response = await fetch(app.url + '/draft-parent/child/', { redirect: 'manual' });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /\[Child of draft\|\]/);
});

const APP_ID = 'aaaaaaaa-0000-4000-8000-0000000000c1';
const MD_HOME = '22222222-2222-4222-8222-222222222222';
const PUBLISHED = 'cccccccc-0000-4000-8000-000000000001';
const REVIEW = 'cccccccc-0000-4000-8000-000000000002';
const STAGED = 'cccccccc-0000-4000-8000-000000000003';

// The organization API as an application user with the System Administrator role.
async function organization(sim) {
  const registered = await fetch(`${sim.url}/_sim/api/dataverse/applications`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.csrf },
    body: JSON.stringify({ appId: APP_ID, displayName: 'Invented admin client', roles: ['System Administrator'] }),
  });
  assert.equal(registered.status, 201);
  const issued = await fetch(`${sim.dataverse.authority}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: APP_ID,
      client_secret: (await registered.json()).secret,
      scope: `${sim.dataverse.origin}/.default`,
    }),
  });
  const { access_token: token } = await issued.json();
  return (method, suffix, body) =>
    fetch(`${sim.dataverse.origin}/api/data/v9.2${suffix}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
}

test('PAGE-05c: publishing-state writes apply without a transition rule, and the portal follows', async (t) => {
  for (const dataModel of ['standard', 'enhanced'])
    await t.test(dataModel, async (t) => {
      const fixture = await modelDrivenFixture(t, { defer: true });
      await fs.writeFile(
        path.join(fixture.sourceDir, 'publishingstate.yml'),
        [
          [PUBLISHED, 'Published', true],
          [REVIEW, 'Review', false],
          [STAGED, 'Staged', false],
        ]
          .map(
            ([id, name, visible]) =>
              `- adx_publishingstateid: ${id}\n  adx_name: ${name}\n  adx_isvisible: ${visible}\n`,
          )
          .join(''),
      );
      // The only transition rule: Published to Review. Hosted, the other transitions have no rule and still apply.
      await fs.mkdir(path.join(fixture.sourceDir, 'publishing-state-transition-rules'));
      await fs.writeFile(
        path.join(fixture.sourceDir, 'publishing-state-transition-rules/Review.publishingstatetransitionrule.yml'),
        `adx_publishingstatetransitionruleid: cccccccc-0000-4000-8000-0000000000e1\nadx_name: Published to Review\n` +
          `adx_fromstate_publishingstateid: ${PUBLISHED}\nadx_tostate_publishingstateid: ${REVIEW}\n`,
      );
      await fs.appendFile(
        path.join(fixture.sourceDir, 'web-pages/Home.webpage.yml'),
        `\nadx_publishingstateid: ${PUBLISHED}\n`,
      );
      const sim = await fixture.start({ dataModel, dataverse: { enabled: true } });
      const org = await organization(sim);
      const prefix = dataModel === 'enhanced' ? 'mspp_' : 'adx_';
      const pages = sim.store.resolveMapping(`${prefix}webpage`).entitySet;
      const states = sim.store.resolveMapping(`${prefix}publishingstate`).entitySet;
      const rules = sim.store.resolveMapping(`${prefix}publishingstatetransitionrule`).entitySet;
      const exported = await (await org('GET', `/${rules}?$select=${prefix}name`)).json();
      assert.deepEqual(
        exported.value.map((rule) => rule[`${prefix}name`]),
        ['Published to Review'],
      );
      for (const [label, target, visible] of [
        ['Published -> Review (rule exists)', REVIEW, false],
        ['Review -> Staged (no rule)', STAGED, false],
        ['Staged -> Published (no rule)', PUBLISHED, true],
      ]) {
        const write = await org('PATCH', `/${pages}(${MD_HOME})`, {
          [`${prefix}publishingstateid@odata.bind`]: `/${states}(${target})`,
        });
        assert.equal(write.status, 204, `${label}: ${await write.text()}`);
        const row = await (await org('GET', `/${pages}(${MD_HOME})?$select=_${prefix}publishingstateid_value`)).json();
        assert.equal(row[`_${prefix}publishingstateid_value`], target, label);
        const anonymous = await fetch(sim.url + '/', { redirect: 'manual' });
        assert.equal(anonymous.status, visible ? 200 : 302, label);
        if (!visible) assert.match(anonymous.headers.get('location'), /\/signin\?ReturnUrl=%2F$/i, label);
      }
    });
});
