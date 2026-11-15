// @test-kind contract: Paqvilo's own simulator administration, CLI, configuration and runtime behaviour
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELP, helpFor, SETUP_STAGES } from '../admin/help-content.mjs';
import { DOC_PATHS } from '../lib/docs-links.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CURRENT_VIEWS = [
  'home',
  'records',
  'portal',
  'platform',
  'overrides',
  'endpoints',
  'operations',
  'mappings',
  'plugins',
  'access',
  'dataverse',
  'scenarios',
  'environment',
  'connection',
  'runtime',
];
const NEW_VIEWS = ['health', 'activity', 'services', 'flows', 'capabilities', 'packs'];
const strings = (value) =>
  typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
const slug = (heading) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/ /g, '-');

test('every current and new view, its main panels and every setup stage have guidance', async () => {
  const app = await fs.readFile(path.join(root, 'mirage/admin/app.mjs'), 'utf8');
  // View ids the app declares: the built-in view table and the sidebar groups (module views are listed there too).
  const declared = [
    ...new Set(
      ['const builtInViews = [', 'const views = [', 'const NAV_GROUPS = ['].flatMap((marker) => {
        const start = app.indexOf(marker);
        if (start < 0) return [];
        return [...app.slice(start, app.indexOf('];', start)).matchAll(/(['"])([a-z-]+)\1/g)].map((match) => match[2]);
      }),
    ),
  ];
  assert.ok(declared.length >= CURRENT_VIEWS.length);
  for (const id of [...new Set([...CURRENT_VIEWS, ...declared, ...NEW_VIEWS])])
    assert.ok(helpFor(id).intro.length > 20, `view ${id}`);
  for (const key of [
    'home.checklist',
    'home.sign-in',
    'home.next',
    'health.topology',
    'health.tiles',
    'health.blocking',
    'health.drawer',
    'activity.filters',
    'activity.activities',
    'activity.log',
    'activity.findings',
    'activity.pages',
    'activity.stats',
    'activity.detail',
    'activity.separate',
    'runtime.workspace',
    'services.storage',
    'services.messaging',
    'services.outbox',
    'services.connectors',
    'services.secrets',
    'services.local-services',
    'services.service-fixtures',
    'flows.runs',
    'flows.waits',
    'flows.background',
    'flows.webhooks',
    'capabilities.report',
    'capabilities.preflight',
    'packs.registered',
    'packs.presets',
    'packs.lifecycle',
    'operations.mode',
    'records.table',
    'dataverse.applications',
    'dataverse.users',
    'environment.variables',
    'access.catalogue',
    'scenarios.saved',
  ])
    assert.ok(helpFor(key).intro, key);
  for (const stage of SETUP_STAGES) assert.ok(helpFor(`setup.${stage}`).intro.length > 20, `setup.${stage}`);
  for (const key of Object.keys(HELP)) assert.match(key, /^(?:setup|[a-z-]+)(?:\.[A-Za-z-]+){0,2}$/, key);
  assert.deepEqual(helpFor('no-such-view'), { intro: '' });
  assert.ok(Object.isFrozen(HELP) && Object.isFrozen(HELP.operations.fields));
});

test('required topics are covered', () => {
  for (const mode of ['placeholder', 'exported', 'mock', 'handler', 'clr', 'disabled'])
    assert.ok(HELP.operations.fields[mode], mode);
  for (const grant of [
    'client_credentials',
    'authorization_code',
    'device_code',
    'refresh_token',
    'password',
    'on_behalf_of',
  ])
    assert.ok(HELP['dataverse.applications'].fields[grant], grant);
  assert.equal(Object.keys(HELP['dataverse.users'].fields).length, 6);
  for (const type of ['startup', 'request', 'liquid', 'data', 'plugin', 'diagnostic', 'reload'])
    assert.ok(HELP['activity.log'].fields[type], type);
  assert.match(HELP['activity.log'].fields.type, /one line per declarative plugin rule/);
  for (const kind of ['api', 'liquid-fetchxml', 'form', 'page', 'entity-read', 'entity-query'])
    assert.ok(HELP['activity.activities'].fields[kind], kind);
  // The vocabulary of the Monitor area: what stays separate says why, and "plugin" names two different things.
  for (const place of ['Health', 'Flows & jobs', 'Backend operations', 'Organization identity & API', 'Runtime state'])
    assert.match(HELP['activity.separate'].intro, new RegExp(place), place);
  assert.match(HELP['health.tiles'].intro, /not the declarative plugin rules/);
  assert.match(HELP['health.tiles'].intro, /Dataverse Web API counts the organization API/);
  for (const gone of ['overview', 'logs', 'audit', 'evidence', 'dashboard'])
    assert.equal(Object.hasOwn(HELP, gone), false, `${gone} was replaced`);
  for (const level of ['inventory', 'contract', 'behaviour', 'native-qualified'])
    assert.ok(HELP.capabilities.fields[level], level);
  assert.match(HELP.scenarios.intro, /Three different things/);
  assert.deepEqual(HELP['packs.lifecycle'].steps, ['write', 'register', 'restart', 'verify']);
  assert.match(HELP['environment.variables'].fields.secret, /Key Vault reference/);
  assert.match(HELP['access.catalogue'].intro, /first registered definition wins/);
});

test('every help doc path exists, is in the docs map and its anchor matches a heading', async () => {
  const known = new Set(Object.values(DOC_PATHS));
  const docs = [
    ...new Set(
      Object.values(HELP)
        .map((entry) => entry.doc)
        .filter(Boolean),
    ),
  ];
  assert.ok(docs.length > 20);
  for (const doc of docs) {
    const [file, anchor] = doc.split('#');
    await fs.access(path.join(root, file));
    assert.ok(known.has(file), `${file} is not in docs-links`);
    if (anchor) {
      const headings = (await fs.readFile(path.join(root, file), 'utf8'))
        .split('\n')
        .filter((line) => /^#{1,6} /.test(line))
        .map((line) => slug(line.replace(/^#+ /, '')));
      assert.ok(headings.includes(anchor), `${doc}: no heading`);
    }
  }
});

test('help text states current behaviour only', () => {
  for (const [key, entry] of Object.entries(HELP))
    for (const text of strings(entry)) {
      assert.doesNotMatch(text, /\blater\b|\bphase\b|TODO|FIXME/i, key);
      assert.doesNotMatch(text, /\b0\.\d+/, key);
    }
});
