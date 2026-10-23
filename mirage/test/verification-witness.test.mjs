import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { verificationWitness, compareVerificationWitnesses } from '../lib/verification-witness.mjs';
import { createSimulator } from '../server.mjs';
import { connectRuntime, createPortalSession } from '../testing.mjs';
import { ownedFixture } from "../testing/owned-fixture.mjs";

const initial = () => ({ version: 1, mappings: { contact: { entitySet: 'contacts', idColumn: 'contactid' },
  fixture: { entitySet: 'fixtures', idColumn: 'fixtureid' }, recording: { entitySet: 'recordings', idColumn: 'recordingid' } },
  tables: { contact: [{ contactid: 'visitor-one', fullname: 'Secret row one' }, { contactid: 'visitor-two', fullname: 'Secret row two' }],
    fixture: [{ fixtureid: 'item', name: 'Sensitive fixture', password: 'Private field' }], recording: [] },
  settings: { permissionMode: 'enforce' }, permissions: [], simulator: { mode: 'local', pageMode: 'local',
    identity: { contactId: 'visitor-two', roles: ['Configured administrator'] }, permissionSource: 'configured',
    contactRoles: [{ contactId: 'visitor-one', roleId: 'reader' }, { contactId: 'visitor-two', roleId: 'reader' }], endpoints: [] } });
const runtime = { origin: 'http://127.0.0.1:12345', revision: 1, storeRevision: 1, loadedSourceFingerprint: 'a'.repeat(64),
  currentSourceFingerprint: 'a'.repeat(64), loadedImplementationFingerprint: 'b'.repeat(64), currentImplementationFingerprint: 'b'.repeat(64) };

test('explicit fixture hashes preserve duplicates, observe chosen fields/config/actor and never expose bodies or secrets', () => {
  const state = initial(), identity = { contactId: 'visitor-one', roleSource: 'memberships', roles: ['Reader'], roleIds: ['reader'], fullname: 'Actor private name' };
  const take = () => verificationWitness({ state, identity, tables: ['fixture'], runtime });
  const before = take(); assert.doesNotMatch(JSON.stringify(before), /Sensitive fixture|Private field|Actor private name|Configured administrator/);
  state.tables.recording.push({ recordingid: 'log', content: 'Unchosen history' });
  assert.equal(compareVerificationWitnesses(before, take()).stable, true);
  state.tables.fixture.push({ ...state.tables.fixture[0] });
  assert.deepEqual(compareVerificationWitnesses(before, take()).changed, ['fixtures']);
  state.tables.fixture.pop(); state.tables.fixture[0].name = 'Changed';
  assert.ok(compareVerificationWitnesses(before, take()).changed.includes('fixtures'));
  state.settings.fetchXmlMaxLinks = 20;
  assert.ok(compareVerificationWitnesses(before, take()).changed.includes('settings'));
  identity.roleIds = ['other']; assert.ok(compareVerificationWitnesses(before, take()).changed.includes('actor'));
  assert.throws(() => verificationWitness({ state, tables: [], runtime }), /one and 32/);
  assert.throws(() => verificationWitness({ state, tables: ['unknown'], runtime }), /must exist/);
  assert.throws(() => verificationWitness({ state, tables: ['fixture','fixture'], runtime }), /distinct/);
});

test('receipt comparison rejects incomplete/tampered hashes and row order is ordinal with explicit undefined preserved', () => {
  const state = initial(), take = runtimeValue => verificationWitness({ state, tables: ['fixture'], runtime: runtimeValue ?? runtime });
  const first = take();
  for (const malformed of [{ kind: first.kind, schemaVersion: 1, hashes: {} },
    { ...first, hashes: { ...first.hashes, actor: 'invalid' } }, { ...first, scopeSha256: '0'.repeat(64) },
    { ...first, selection: { ...first.selection, rows: { fixture: { count: 99, sha256: 'a'.repeat(64) } } } },
    { ...first, actor: { ...first.actor, contactId: 'tampered' } }])
    assert.throws(() => compareVerificationWitnesses(first, malformed), /complete compatible/);
  const otherInstance = take({ ...runtime, origin: 'http://127.0.0.1:12346', instanceId: 'another-runtime' });
  assert.equal(compareVerificationWitnesses(first, otherInstance).stable, true);
  assert.equal(compareVerificationWitnesses(first, otherInstance).runtimeInstanceChanged, true);
  state.tables.fixture = [{ fixtureid: 'z', name: '\u00e4' }, { fixtureid: 'a', name: 'A' }];
  const ordered = take(); state.tables.fixture.reverse(); assert.equal(compareVerificationWitnesses(ordered, take()).stable, true);
  state.tables.fixture[0].missing = undefined;
  assert.ok(compareVerificationWitnesses(ordered, take()).changed.includes('fixtures'));
});

test('pending visitor session inspections protect role changes and closing just like portal requests', async () => {
  let finish;
  const fetchImpl = async url => new URL(url).pathname.endsWith('/state')
    ? Response.json({ csrf: 'fixture-csrf', config: { mode: 'local', pageMode: 'local' } })
    : new Promise(resolve => { finish = () => resolve(Response.json({ contactId: 'fixture-visitor' })); });
  const visitor = await createPortalSession({ origin: 'http://127.0.0.1:12345', fetchImpl });
  const pending = visitor.session(); await Promise.resolve();
  await assert.rejects(visitor.setRoles(['Changed']), error => error.code === 'PortalSessionBusy');
  assert.throws(() => visitor.close(), error => error.code === 'PortalSessionBusy');
  finish(); await pending; visitor.close();
});

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mirage-witness-')); ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'website.yml'), 'adx_name: Witness fixture\nadx_websiteid: source-site');
  await fs.writeFile(path.join(directory, 'webrole.yml'), '- adx_webroleid: reader\n  adx_name: Reader');
  const app = await createSimulator({ sourceDir: directory, stateFile: path.join(directory, '.paqvilo', 'state.json'), initial: initial(), watch: false, port: 0 });
  ownedFixture(t).add(() => app.close()); return { app, runtime: await connectRuntime({ origin: app.url }) };
}

test('real witness route binds cookie-isolated visitors, remains anonymous without cookie and does not run queries/plugins', async t => {
  const { app, runtime } = await fixture(t), one = await runtime.createSession({ contactId: 'visitor-one' }), two = await runtime.createSession({ contactId: 'visitor-two' });
  t.after(() => { one.close(); two.close(); });
  app.store.get = app.store.query = app.store.fetchXml = () => { throw new Error('Witness must not invoke SDK/query flow'); };
  const anonymous = await runtime.witness({ tables: ['fixture'] });
  assert.equal(anonymous.actor.contactId, null); assert.equal(anonymous.actor.roleSource, 'memberships');
  const [left,right] = await Promise.all([one.witness({ tables: ['fixture'] }), two.witness({ tables: ['fixture'] })]);
  assert.equal(left.actor.contactId, 'visitor-one'); assert.equal(right.actor.contactId, 'visitor-two');
  assert.notEqual(left.hashes.actor, right.hashes.actor); assert.equal(left.actor.roleSource, 'memberships');
  assert.equal(left.hashes.fixtures, right.hashes.fixtures); assert.equal(left.nativeParityQualified, false);
  assert.doesNotMatch(JSON.stringify(left), /Private field|Sensitive fixture/);
  await assert.rejects(one.witness({ tables: [] }), /HTTP 400/);
  const response = await fetch(app.url + '/_sim/api/verification-witness?tables=fixture&unknown=1'); assert.equal(response.status, 400);
});

test('witness waits for actual in-flight mutation and catches chosen row/settings drift while leaving excluded history unobserved', async t => {
  const { app, runtime } = await fixture(t), before = await runtime.witness({ tables: ['fixture'] });
  let release, started; const ready = new Promise(resolve => started = resolve), gate = new Promise(resolve => release = resolve);
  const write = app.store.transact(async () => { app.store.state.tables.fixture[0].name = 'Committed fixture'; started(); await gate; });
  await ready; let returned = false; const pending = runtime.witness({ tables: ['fixture'] }).then(value => { returned = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(returned, false); release(); await write;
  const after = await pending; assert.ok(compareVerificationWitnesses(before, after).changed.includes('fixtures'));
  await app.store.transact(() => { app.store.state.tables.recording.push({ recordingid: 'new', content: 'Private history' }); });
  const recording = await runtime.witness({ tables: ['fixture'] });
  assert.equal(compareVerificationWitnesses(after, recording).stable, true);
  assert.equal(compareVerificationWitnesses(after, recording).runtimeRevisionChanged, true);
  await runtime.setSiteSetting('Feature/Witness', 'true');
  const settings = await runtime.witness({ tables: ['fixture'] }); assert.ok(compareVerificationWitnesses(recording, settings).changed.includes('settings'));
});
