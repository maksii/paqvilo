import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeDataset } from '../lib/data-generation.mjs';
import { resolvePortalIdentity } from '../lib/permissions.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const contactId = '11111111-1111-4111-8111-111111111111';
const roleId = '22222222-2222-4222-8222-222222222222';
const portal = { records: [{ kind: 'webrole', id: roleId, name: 'Reviewer' }] };
const initial = () => ({ mappings: { contact: { idColumn: 'contactid' } }, tables: { contact: [] }, permissions: [], simulator: { identity: { contactId: 'existing', roles: ['Local override'] }, contactRoles: [{ contactId: 'existing', roleId: 'existing-role', local: true }] } });
const fragment = () => ({ tables: { contact: [{ contactid: contactId, fullname: 'Generated', statecode: 0 }] }, personaRoles: [{ contactId, roles: ['Reviewer'] }], personaCatalog: { version: 1, groups: [{ id: 'review', label: 'Review' }], personas: [{ key: 'reviewer', contactId, group: 'review' }] } });

test('additive generation grants no memberships from role descriptors or catalogue metadata by default', () => {
  const state = initial(), output = mergeDataset(state, fragment());
  assert.deepEqual(output.state.simulator, state.simulator);
  assert.equal(output.report.addedMemberships, 0);
  const metadataOnly = fragment(); delete metadataOnly.personaRoles;
  assert.deepEqual(mergeDataset(state, metadataOnly, { materializePersonaMemberships: true, portal }).state.simulator, state.simulator);
});

test('explicit membership materialization adds only named exported roles and preserves edits and identity', () => {
  const state = initial(), data = fragment();
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
  const state = initial(), before = structuredClone(state), options = { materializePersonaMemberships: true, portal };
  const bad = fragment(); bad.personaRoles[0].roles.push('Missing');
  assert.throws(() => mergeDataset(state, bad, options), /absent or ambiguous/);
  const duplicate = { records: [...portal.records, { ...portal.records[0], id: 'other-role' }] };
  assert.throws(() => mergeDataset(state, fragment(), { ...options, portal: duplicate }), /absent or ambiguous/);
  const missing = fragment(); missing.tables.contact = [];
  assert.throws(() => mergeDataset(state, missing, options), /missing or inactive/);
  const inactive = fragment(); inactive.tables.contact[0].statecode = 1;
  assert.throws(() => mergeDataset(state, inactive, options), /missing or inactive/);
  const existing = initial(); existing.tables.contact.push(fragment().tables.contact[0]);
  assert.throws(() => mergeDataset(existing, { ...fragment(), tables: {} }, options), /supplied by this dataset/);
  assert.throws(() => mergeDataset(state, fragment(), { materializePersonaMemberships: true }), /portal export/);
  assert.throws(() => mergeDataset(state, fragment(), { ...options, materializePersonaMemberships: 'true' }), /boolean/);
  const malformed = fragment(); malformed.personaRoles[0].roles = [''];
  assert.throws(() => mergeDataset(state, malformed, options), /role-name arrays/);
  assert.deepEqual(state, before);
});

test('materialization and membership identity agree on decorated contact and exported role GUIDs',()=>{
  const data=fragment();data.tables.contact[0].contactid=`(${contactId.toUpperCase()})`;
  const decoratedPortal={records:[{kind:'webrole',id:`(${roleId.toUpperCase()})`,name:'Reviewer'}]};
  const merged=mergeDataset(initial(),data,{materializePersonaMemberships:true,portal:decoratedPortal});
  assert.deepEqual(merged.state.simulator.contactRoles.at(-1),{contactId,roleId});
  const identity=resolvePortalIdentity(decoratedPortal,merged.state,{contactId:`{${contactId}}`,roleSource:'memberships'});
  assert.equal(identity.contactId,contactId);
  assert.deepEqual(identity.roles,['Reviewer']);
});

test('data generate CLI materializes memberships only when opted in and remains idempotent', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'generate-memberships-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'portal'), stateFile = path.join(directory, 'state.json'), packFile = path.join(directory, 'pack.mjs');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'website.yml'), 'adx_websiteid: site\nadx_name: Generated fixture');
  await fs.writeFile(path.join(source, 'webrole.yml'), `- adx_webroleid: ${roleId}\n  adx_name: Reviewer`);
  await fs.writeFile(stateFile, JSON.stringify(initial()));
  await fs.writeFile(path.join(directory, 'dataset.json'), JSON.stringify(fragment()));
  await fs.writeFile(packFile, `import fs from 'node:fs/promises';
const dataset = JSON.parse(await fs.readFile(new URL('./dataset.json', import.meta.url), 'utf8'));
export default { id: 'fixture', name: 'Fixture', description: 'Invented data', matches: () => true, presets: () => ({}), dataset: () => structuredClone(dataset) };`);
  const execute = async extra => {
    const cli = fileURLToPath(new URL('../../bin/paqvilo.mjs', import.meta.url));
    const { stdout } = await promisify(execFile)(process.execPath, [cli, 'mirage', 'data', 'generate', '--pack', 'fixture', '--pack-module', packFile, '--state', stateFile, ...extra], { windowsHide: true, timeout: 30000 });
    return JSON.parse(stdout);
  };
  assert.equal((await execute([])).addedMemberships, 0);
  const before = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  assert.equal((await execute(['--materialize-persona-memberships', '--source', source, '--data-model', 'enhanced'])).addedMemberships, 1);
  const after = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  assert.deepEqual(after.simulator.identity, before.simulator.identity);
  assert.deepEqual(after.simulator.contactRoles, [...before.simulator.contactRoles, { contactId, roleId }]);
  assert.equal((await execute(['--materialize-persona-memberships', '--source', source])).addedMemberships, 0);
  const unchanged=await fs.readFile(stateFile,'utf8');
  await assert.rejects(execute(['unexpected']),/unexpected positional arguments/);
  await assert.rejects(execute(['--rows','3']),/--rows is supported only by data scaffold/);
  assert.equal(await fs.readFile(stateFile,'utf8'),unchanged,'unknown positional arguments cannot write state');
  await fs.writeFile(path.join(directory,'dataset.json'),JSON.stringify({tables:{contact:[null]}}));
  await assert.rejects(execute([]),/Dataset.tables.contact rows must be objects/);
  assert.equal(await fs.readFile(stateFile,'utf8'),unchanged,'malformed dataset rows cannot replace state');
  for(const invalid of [null,[],false]){
    await fs.writeFile(path.join(directory,'dataset.json'),JSON.stringify(invalid));
    await assert.rejects(execute([]),/Dataset must be a dataset object/);
    assert.equal(await fs.readFile(stateFile,'utf8'),unchanged,'invalid pack output cannot replace state');
  }
});
