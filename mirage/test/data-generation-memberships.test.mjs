import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeDataset, runDataCommand } from '../lib/data-generation.mjs';
import { resolvePortalIdentity } from '../lib/permissions.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const contactId = '11111111-1111-4111-8111-111111111111';
const roleId = '22222222-2222-4222-8222-222222222222';
const portal = { records: [{ kind: 'webrole', id: roleId, name: 'Reviewer' }] };
const initial = () => ({
  mappings: { contact: { idColumn: 'contactid' } },
  tables: { contact: [] },
  permissions: [],
  simulator: {
    identity: { contactId: 'existing', roles: ['Local override'] },
    contactRoles: [{ contactId: 'existing', roleId: 'existing-role', local: true }],
  },
});
const fragment = () => ({
  tables: { contact: [{ contactid: contactId, fullname: 'Generated', statecode: 0 }] },
  personaRoles: [{ contactId, roles: ['Reviewer'] }],
  personaCatalog: {
    version: 1,
    groups: [{ id: 'review', label: 'Review' }],
    personas: [{ key: 'reviewer', contactId, group: 'review' }],
  },
});

test('additive generation grants no memberships from role descriptors or catalogue metadata by default', () => {
  const state = initial(),
    output = mergeDataset(state, fragment());
  assert.deepEqual(output.state.simulator, state.simulator);
  assert.equal(output.report.addedMemberships, 0);
  const metadataOnly = fragment();
  delete metadataOnly.personaRoles;
  assert.deepEqual(
    mergeDataset(state, metadataOnly, { materializePersonaMemberships: true, portal }).state.simulator,
    state.simulator,
  );
});

test('explicit membership materialization adds only named exported roles and preserves edits and identity', () => {
  const state = initial(),
    data = fragment();
  state.tables.contact.push({ contactid: contactId.toUpperCase(), fullname: 'Local edit', statecode: 0 });
  const options = { materializePersonaMemberships: true, portal };
  const output = mergeDataset(state, data, options);
  assert.equal(output.report.addedMemberships, 1);
  assert.deepEqual(output.state.simulator.identity, state.simulator.identity);
  assert.deepEqual(output.state.simulator.contactRoles, [...state.simulator.contactRoles, { contactId, roleId }]);
  assert.equal(output.state.tables.contact[0].fullname, 'Local edit');
  const identity = resolvePortalIdentity(portal, output.state, { contactId, roleSource: 'memberships' });
  assert.deepEqual(identity.roles, ['Reviewer']);
  const repeated = mergeDataset(output.state, data, options);
  assert.equal(repeated.report.addedMemberships, 0);
  assert.deepEqual(repeated.state.simulator, output.state.simulator);
  assert.equal(state.simulator.contactRoles.length, 1, 'input is never changed');
});

test('materialization rejects absent or ambiguous roles and missing or inactive contacts atomically', () => {
  const state = initial(),
    before = structuredClone(state),
    options = { materializePersonaMemberships: true, portal };
  const bad = fragment();
  bad.personaRoles[0].roles.push('Missing');
  assert.throws(() => mergeDataset(state, bad, options), /absent or ambiguous/);
  const duplicate = { records: [...portal.records, { ...portal.records[0], id: 'other-role' }] };
  assert.throws(() => mergeDataset(state, fragment(), { ...options, portal: duplicate }), /absent or ambiguous/);
  const missing = fragment();
  missing.tables.contact = [];
  assert.throws(() => mergeDataset(state, missing, options), /missing or inactive/);
  const inactive = fragment();
  inactive.tables.contact[0].statecode = 1;
  assert.throws(() => mergeDataset(state, inactive, options), /missing or inactive/);
  const existing = initial();
  existing.tables.contact.push(fragment().tables.contact[0]);
  assert.throws(() => mergeDataset(existing, { ...fragment(), tables: {} }, options), /supplied by this dataset/);
  assert.throws(() => mergeDataset(state, fragment(), { materializePersonaMemberships: true }), /portal export/);
  assert.throws(
    () => mergeDataset(state, fragment(), { ...options, materializePersonaMemberships: 'true' }),
    /boolean/,
  );
  const malformed = fragment();
  malformed.personaRoles[0].roles = [''];
  assert.throws(() => mergeDataset(state, malformed, options), /role-name arrays/);
  assert.deepEqual(state, before);
});

test('materialization and membership identity agree on decorated contact and exported role GUIDs', () => {
  const data = fragment();
  data.tables.contact[0].contactid = `(${contactId.toUpperCase()})`;
  const decoratedPortal = { records: [{ kind: 'webrole', id: `(${roleId.toUpperCase()})`, name: 'Reviewer' }] };
  const merged = mergeDataset(initial(), data, { materializePersonaMemberships: true, portal: decoratedPortal });
  assert.deepEqual(merged.state.simulator.contactRoles.at(-1), { contactId, roleId });
  const identity = resolvePortalIdentity(decoratedPortal, merged.state, {
    contactId: `{${contactId}}`,
    roleSource: 'memberships',
  });
  assert.equal(identity.contactId, contactId);
  assert.deepEqual(identity.roles, ['Reviewer']);
});

test('data generate materializes memberships only when opted in, remains idempotent and never writes state from bad input', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'generate-memberships-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'portal'),
    stateFile = path.join(directory, 'state.json'),
    packFile = path.join(directory, 'pack.mjs'),
    datasetFile = path.join(directory, 'dataset.json');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'website.yml'), 'adx_websiteid: site\nadx_name: Generated fixture');
  await fs.writeFile(path.join(source, 'webrole.yml'), `- adx_webroleid: ${roleId}\n  adx_name: Reviewer`);
  await fs.writeFile(stateFile, JSON.stringify(initial()));
  await fs.writeFile(datasetFile, JSON.stringify(fragment()));
  // Read on every call: the module stays cached across the in-process runs below.
  await fs.writeFile(
    packFile,
    `import fs from 'node:fs';
export default { id: 'fixture', name: 'Fixture', description: 'Invented data', matches: () => true, presets: () => ({}), dataset: () => JSON.parse(fs.readFileSync(new URL('./dataset.json', import.meta.url), 'utf8')) };`,
  );
  const generate = (args = {}, subcommands = ['generate']) =>
    runDataCommand(subcommands, { pack: 'fixture', 'pack-module': [packFile], state: stateFile, ...args });
  assert.equal((await generate()).addedMemberships, 0);
  const before = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  // The CLI parses the opt-in and source flags into the same command.
  const cli = fileURLToPath(new URL('../../bin/paqvilo.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      cli,
      'mirage',
      'data',
      'generate',
      '--pack',
      'fixture',
      '--pack-module',
      packFile,
      '--state',
      stateFile,
      '--materialize-persona-memberships',
      '--source',
      source,
      '--data-model',
      'enhanced',
    ],
    { windowsHide: true, timeout: 30000 },
  );
  assert.equal(JSON.parse(stdout).addedMemberships, 1);
  const after = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  assert.deepEqual(after.simulator.identity, before.simulator.identity);
  assert.deepEqual(after.simulator.contactRoles, [...before.simulator.contactRoles, { contactId, roleId }]);
  assert.equal((await generate({ 'materialize-persona-memberships': true, source })).addedMemberships, 0);
  const unchanged = await fs.readFile(stateFile, 'utf8');
  await assert.rejects(generate({}, ['generate', 'unexpected']), /unexpected positional arguments/);
  await assert.rejects(generate({ rows: '3' }), /--rows is supported only by data scaffold/);
  assert.equal(await fs.readFile(stateFile, 'utf8'), unchanged, 'rejected arguments cannot write state');
  for (const [invalid, message] of [
    [{ tables: { contact: [null] } }, /Dataset.tables.contact rows must be objects/],
    [null, /Dataset must be a dataset object/],
    [[], /Dataset must be a dataset object/],
    [false, /Dataset must be a dataset object/],
  ]) {
    await fs.writeFile(datasetFile, JSON.stringify(invalid));
    await assert.rejects(generate(), message);
    assert.equal(
      await fs.readFile(stateFile, 'utf8'),
      unchanged,
      `invalid pack output ${JSON.stringify(invalid)} cannot replace state`,
    );
  }
});
