// @test-kind observation: paqvilo-developer hosted-f2 summary-F2 "PCF subgrid chain" (runs/s0a, s0b and s0c pcfchain.json; runs/pcf1 and pcf2 pcfvariants.json, 2026-11-27): a dataset code component subgrid is hosted in div.entity-grid.subgrid with data-default-pcf-controlid, data-ref-entity, data-ref-id (the zero GUID in insert mode), data-ref-rel (with data-ref-rel-role="Referenced" for a self-referential relationship, none without a relationship), data-selected-view, data-get-url, data-update-url, data-view-layouts and data-user-*, under div#<name>.subgrid, div.control and td.clearfix.cell.subgrid-cell; the sources and rows are the recorded inputs of the pcf-grid-data parent-variants replay cases
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { signInHeaders } from '../testing/session.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { platformLibraryFiles } from './parity/adapters/pcf-form-admission.mjs';

const CASES = JSON.parse(
  await fs.readFile(new URL('./parity/cases/pcf-grid-data/parent-variants.json', import.meta.url), 'utf8'),
).cases;
const VISITOR = '70000000-0000-4000-8000-0000000000e1';
const ZERO = '00000000-0000-0000-0000-000000000000';
const EDIT_PAGE = '/pqf2-pcf-edit/?id=f2f2f2f2-0000-4000-8000-000000007001';

/** The page of a recorded case, served by a simulator over the case's sources and rows, as a signed-in visitor. The
 * page path is the test's own literal, checked against the case. */
async function served(t, id, page) {
  const { input } = CASES.find((entry) => entry.id === id);
  assert.equal(input.page, page, `${id} records this page`);
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'pcf-subgrid-host-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  for (const [folder, files] of [
    ['portal', input.portal],
    ['solution', input.solution],
  ])
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(root, folder, name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content);
    }
  const app = await createSimulator({
    sourceDir: path.join(root, 'portal'),
    solutionRoots: [path.join(root, 'solution')],
    pcf: { platformLibraries: await platformLibraryFiles(root) },
    port: 0,
    watch: false,
  });
  ownedFixture(t).add(() => app.close());
  for (const { entity, id, data } of input.rows) {
    const { idColumn } = app.store.resolveMapping(entity);
    await app.store.create(entity, { [idColumn]: id, ...structuredClone(data) }, { admin: true });
  }
  for (const { entity, id, navigation, targetId } of input.links)
    await app.store.associate(entity, id, navigation, targetId, { admin: true });
  const role = /adx_name: (.+)/.exec(input.portal['webrole.yml'])?.[1]?.trim();
  const { cookie } = signInHeaders(app, VISITOR, { roles: [role] });
  const response = await fetch(app.url + page, { headers: { cookie } });
  assert.equal(response.status, 200);
  return response.text();
}

/** The grid element of the named subgrid, its attributes and its parent chain up to the cell. */
function host(html, name) {
  const chain = new RegExp(
    `<td([^>]*)>(?:(?!<td\\b)[\\s\\S])*?<div class="control"><div id="${name}" class="subgrid"><div (class="entity-grid subgrid"[^>]*)>`,
  ).exec(html);
  assert.ok(chain, `the ${name} subgrid has its grid element`);
  const attributes = Object.fromEntries(
    [...chain[2].matchAll(/([\w-]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]),
  );
  return { cell: chain[1], attributes, names: Object.keys(attributes) };
}

const CAPTURED_ORDER = [
  'class',
  'data-column-width-style',
  'data-default-pcf-controlid',
  'data-defer-loading',
  'data-enable-actions',
  'data-get-url',
  'data-grid-class',
  'data-mobile-view-enabled',
  'data-ref-entity',
  'data-ref-id',
  'data-ref-rel',
  'data-ref-rel-role',
  'data-select-mode',
  'data-selected-view',
  'data-update-url',
  'data-user-isauthenticated',
  'data-user-parent-account-name',
  'data-view-layouts',
];
const inCapturedOrder = (names) => names.filter((name) => CAPTURED_ORDER.includes(name));

test('a dataset code component subgrid is hosted in the captured grid element, in edit and insert mode', async (t) => {
  const edit = await served(t, 'selfref-subgrid', EDIT_PAGE);
  const selfref = host(edit, 'selfref');
  assert.match(selfref.cell, /class="clearfix cell subgrid-cell"/);
  assert.deepEqual(
    inCapturedOrder(selfref.names),
    CAPTURED_ORDER.filter((name) => name !== 'data-user-parent-account-name'),
  );
  assert.equal(selfref.attributes['data-default-pcf-controlid'], 'selfref');
  assert.equal(selfref.attributes['data-ref-entity'], 'pqpcf_probe');
  assert.equal(selfref.attributes['data-ref-id'], 'f2f2f2f2-0000-4000-8000-000000007001');
  assert.equal(selfref.attributes['data-ref-rel'], 'pqpcf_related_pqpcf_probe_pqpcf_probe');
  assert.equal(selfref.attributes['data-ref-rel-role'], 'Referenced');
  assert.equal(selfref.attributes['data-selected-view'], '9c7f0a11-0000-4000-8000-000000000101');
  assert.match(selfref.attributes['data-get-url'], /^\/_services\/entity-subgrid-data\.json\/[^/]+$/);
  assert.match(selfref.attributes['data-update-url'], /^\/_services\/entity-grid-update-entity\/[^/]+$/);
  assert.equal(selfref.attributes['data-user-isauthenticated'], 'true');
  assert.ok(selfref.attributes['data-view-layouts'].length > 0);
  // A 1:N subgrid has no referenced role; a subgrid without a relationship names no parent.
  const items = host(edit, 'items');
  assert.equal(items.attributes['data-ref-rel'], 'pqpcf_probe_pqpcf_probe_pqpcf_item');
  assert.equal(items.attributes['data-ref-rel-role'], undefined);
  const norel = host(edit, 'norel');
  assert.deepEqual(
    norel.names.filter((name) => name.startsWith('data-ref-')),
    [],
  );
  // Insert mode: the same element, with the zero GUID as the parent.
  const insert = await served(t, 'insert-mode-selfref-subgrid', '/pqf2-pcf-insert/');
  for (const name of ['selfref', 'items']) {
    const grid = host(insert, name);
    assert.match(grid.cell, /class="clearfix cell subgrid-cell"/, name);
    assert.equal(grid.attributes['data-ref-id'], ZERO, name);
  }
  assert.equal(host(insert, 'selfref').attributes['data-ref-rel-role'], 'Referenced');
  // A polymorphic regarding relationship names its relationship without a role.
  const regarding = host(
    await served(t, 'regarding-subgrid', '/pqf2-pcf-regarding/?id=f2f2f2f2-0000-4000-8000-000000007101'),
    'regarding',
  );
  assert.equal(regarding.attributes['data-ref-rel'], 'pqf2_case_pqpcf_activities');
  assert.equal(regarding.attributes['data-ref-rel-role'], undefined);
});
