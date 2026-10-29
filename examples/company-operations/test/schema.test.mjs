import test from 'node:test';
import assert from 'node:assert/strict';
import { readManifest, compileManifest } from 'paqvilo/dataverse';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { makeTemporaryDirectorySync } from 'paqvilo/mirage/testing/owned-fixture.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prepare = (args) =>
  spawnSync(process.execPath, [path.join(project, 'prepare-schema.mjs'), ...args], {
    cwd: project,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 150_000,
  });

test('default schema preparation reproduces the committed reviewed cohort', (t) => {
  const directory = makeTemporaryDirectorySync(path.join(os.tmpdir(), 'paqvilo-schema-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'manifest.json'),
    result = prepare(['--out', output]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).cohort, 'source4');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(output, 'utf8')),
    JSON.parse(fs.readFileSync(path.join(project, 'dataverse/manifest.json'), 'utf8')),
  );
});

test('Source5 requires explicit selection and a separate output while preserving the reviewed schema', (t) => {
  const directory = makeTemporaryDirectorySync(path.join(os.tmpdir(), 'paqvilo-schema-source5-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const committed = path.join(project, 'dataverse/manifest.json'),
    before = fs.readFileSync(committed, 'utf8');
  for (const args of [
    ['--cohort', 'source5'],
    ['--cohort', 'source5', '--out', committed],
    ['--cohort', 'unknown'],
  ]) {
    const result = prepare(args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /separate --out|Expected --cohort/);
  }
  const alias = path.join(directory, 'schema-alias');
  fs.symlinkSync(path.dirname(committed), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const refused = prepare(['--cohort', 'source5', '--out', path.join(alias, 'manifest.json')]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /separate --out/);
  const output = path.join(directory, 'source5.json'),
    result = prepare(['--cohort', 'source5', '--out', output]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).cohort, 'source5');
  const planned = JSON.parse(fs.readFileSync(output, 'utf8')),
    current = JSON.parse(before);
  const lookup = planned.relationships.find((r) => r.name === 'pqvd_equipment_crudprobes');
  assert.equal(lookup.lookup.name, 'pqvd_equipmentid');
  assert.equal(lookup.cascade.Delete, 'RemoveLink');
  const variant = planned.tables
    .find((t) => t.name === 'pqvd_testoperation')
    .columns.find((c) => c.name === 'pqvd_variant');
  assert.equal(variant.maxLength, 128);
  planned.relationships = planned.relationships.filter((r) => r.name !== lookup.name);
  variant.maxLength = 40;
  assert.deepEqual(planned, current);
  assert.equal(fs.readFileSync(committed, 'utf8'), before);
});

test('company manifest has complete schema inventory and protected role anchors', async () => {
  const manifest = await readManifest(new URL('../dataverse/manifest.json', import.meta.url));
  assert.equal(manifest.tables.length, 28);
  assert.equal(manifest.tables.filter((t) => !t.existing).length, 25);
  assert.equal(manifest.choices.length, 26);
  assert.equal(manifest.relationships.length, 73);
  assert.equal(
    manifest.tables.reduce((n, t) => n + t.keys.length, 0),
    29,
  );
  assert.equal(
    manifest.relationships.filter(
      (r) => r.kind === 'oneToMany' && r.child === 'pqvd_accesspermission' && r.lookup.name.endsWith('principalid'),
    ).length,
    12,
  );
  assert.equal(
    manifest.tables.find((t) => t.name === 'pqvd_employmentterms').entitySetName,
    'pqvd_employmenttermrecords',
  );
  assert.equal(manifest.tables.find((t) => t.name === 'pqvd_chainnode').ownership, 'user');
  assert.ok(manifest.relationships.filter((r) => r.kind === 'oneToMany').every((r) => r.cascade.Delete === 'Restrict'));
  const nullable = manifest.relationships.filter(
    (r) => r.child === 'pqvd_testoperation' && ['pqvd_runid', 'pqvd_runnercontactid'].includes(r.lookup.name),
  );
  assert.ok(nullable.every((r) => r.lookup.required === 'none'));
});

test('deep path and later extensions keep their declared solution ownership', async () => {
  const manifest = await readManifest(new URL('../dataverse/manifest.json', import.meta.url));
  const chain = [
    'pqvd_accesspermission',
    'account',
    'pqvd_orgcontact',
    'pqvd_employment',
    'pqvd_assignment',
    'pqvd_servicerequest',
    'pqvd_workorder',
    'pqvd_worktask',
    'pqvd_checklistitem',
    'pqvd_inspection',
    'pqvd_finding',
  ];
  for (let i = 1; i < chain.length; i++)
    assert.ok(manifest.relationships.some((r) => r.parent === chain[i - 1] && r.child === chain[i]));
  const plan = compileManifest(manifest);
  const trigger = plan.actions.find((a) => a.key === 'column:pqvd_crudprobe.pqvd_triggernonce');
  assert.equal(trigger.solution, 'PaqviloBehaviorPlugins');
  assert.equal(
    plan.actions.find((a) => a.key === 'relationship:pqvd_testoperation_results').solution,
    'PaqviloBehaviorPlugins',
  );
  const canary = manifest.relationships.find((r) => r.name === 'pqvd_testrun_canaryequipments');
  assert.equal(canary.solution, 'PaqviloBehaviorPlugins');
  assert.equal(canary.lookup.required, 'none');
  const names = plan.actions.map((a) => a.key);
  assert.equal(names.length, new Set(names).size);
  assert.ok(plan.actions.filter((a) => a.kind === 'key').every((a) => a.solution));
  assert.ok(manifest.scope.remaining.includes('Named forms/views'));
});
