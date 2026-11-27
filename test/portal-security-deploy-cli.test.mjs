// @test-kind security: invented offline deployment targets must be explicit and plans/failures must preserve tracked blueprint bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { boundedCommand } from './helpers/bounded-command.mjs';

const site = '11111111-2222-3333-4444-555555555555';
const organisation = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const contact = '99999999-8888-7777-6666-555555555555';
const blueprintBytes = Buffer.from('{"owner":"preserve exact bytes"}\r\n');

// The fixture mirrors a toolkit checkout (root) holding the example; commands run from the checkout as documented.
async function fixture(t) {
  // The physical path: the script derives the checkout from its own location, which Node reports through links (macOS
  // /var is a link into /private).
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-security-cli-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const example = path.join(root, 'examples/company-operations');
  for (const dir of ['portal-security', 'dataverse', 'data'])
    await fs.mkdir(path.join(example, dir), { recursive: true });
  await fs.mkdir(path.join(root, '.paqvilo/dataverse'), { recursive: true });
  for (const name of [
    'portal-security/deploy.mjs',
    'portal-security/blueprint.mjs',
    'portal-security/reference-projections.mjs',
    'cli.mjs',
    'paths.mjs',
  ])
    await fs.copyFile(new URL(`../examples/company-operations/${name}`, import.meta.url), path.join(example, name));
  await fs.copyFile(
    new URL('../examples/company-operations/dataverse/manifest.json', import.meta.url),
    path.join(example, 'dataverse/manifest.json'),
  );
  const base = await fs.readFile(new URL('../examples/company-operations/data/catalogue.json', import.meta.url));
  await fs.writeFile(path.join(example, 'data/catalogue.json'), base);
  const selected = JSON.parse(base);
  selected.version = 'invented-explicit-catalogue';
  selected.personas = [{ key: 'invented-selected-persona', contactId: contact, webRoles: ['EMPLOYEE'] }];
  await fs.writeFile(path.join(root, 'selected.json'), JSON.stringify(selected));
  const blueprint = path.join(example, 'portal-security/blueprint.json');
  await fs.writeFile(blueprint, blueprintBytes);
  const ownerFile = path.join(example, 'portal-security/owner-untracked.txt');
  await fs.writeFile(ownerFile, 'owner content');
  const connection = path.join(root, '.paqvilo/dataverse/provisioning.connection.json');
  await fs.writeFile(connection, JSON.stringify({ organisationId: organisation }));
  const calls = path.join(root, 'calls.jsonl');
  const fake = path.join(root, 'fake-dataverse.mjs');
  await fs.writeFile(
    fake,
    `
    import fs from 'node:fs/promises';
    const record = async (kind, value) => fs.appendFile(${JSON.stringify(calls)}, JSON.stringify({kind,value})+'\\n');
    export async function loadConnection(file) { await record('connection',file); return JSON.parse(await fs.readFile(file)); }
    export function connectedClient(connection) { return {
      async verify(id) { await record('verify',id); if(connection.rejectOrganisation) throw new Error('Invented organisation mismatch'); },
      async get(target) { await record('get',target); return {datamodelversion:'2.0',enhancedauthorization:0,name:'Invented site',primarydomainname:'invented.invalid'}; },
      async list(target) { await record('list',target); return []; },
      async request() { throw new Error('OFFLINE PLAN ATTEMPTED A REMOTE WRITE'); }
    }; }
  `,
  );
  const hook = path.join(root, 'hook.mjs');
  await fs.writeFile(
    hook,
    `
    import {registerHooks} from 'node:module';
    registerHooks({resolve(specifier,context,next) {
      if(specifier==='paqvilo/dataverse') {
        if(process.env.DEPLOY_DENY_CONNECTION==='1') throw new Error('CONNECTION MODULE LOADED');
        return {url:${JSON.stringify(pathToFileURL(fake).href)},shortCircuit:true};
      }
      return next(specifier,context);
    }});
  `,
  );
  return {
    root,
    example,
    connection,
    calls,
    run: (args, deny = false, cwd = root) =>
      boundedCommand(
        t,
        process.execPath,
        ['--import', pathToFileURL(hook).href, path.join(example, 'portal-security/deploy.mjs'), ...args],
        {
          cwd,
          env: { ...process.env, DEPLOY_DENY_CONNECTION: deny ? '1' : '0' },
        },
      ),
    async preserved() {
      assert.ok((await fs.readFile(blueprint)).equals(blueprintBytes), 'tracked blueprint bytes changed');
      assert.ok(
        (await fs.readFile(path.join(example, 'data/catalogue.json'))).equals(base),
        'base catalogue bytes changed',
      );
      assert.equal(await fs.readFile(ownerFile, 'utf8'), 'owner content');
    },
  };
}

test('explicit catalogue plan uses its distinct persona and safe default connection without rewriting sources', async (t) => {
  const f = await fixture(t);
  const result = await f.run(['--site', site, '--catalogue', 'selected.json']);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(summary.state, 'Planned');
  const journal = JSON.parse(await fs.readFile(summary.journal));
  const assignments = journal.entries.filter((entry) => entry.kind === 'assignment');
  assert.deepEqual(
    assignments.map((entry) => [entry.persona, entry.contactId, entry.role]),
    [
      ['invented-selected-persona', contact, 'EMPLOYEE'],
      ['invented-selected-persona', contact, 'TESTRUNNER'],
    ],
  );
  const calls = (await fs.readFile(f.calls, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(
    calls.filter((c) => c.kind === 'verify').map((c) => c.value),
    [organisation],
  );
  assert.deepEqual(
    calls.filter((c) => c.kind === 'get').map((c) => c.value),
    [`powerpagesites(${site})`],
  );
  assert.deepEqual(
    calls.filter((c) => c.kind === 'list' && c.value.startsWith('contacts(')).map((c) => c.value),
    [`contacts(${contact})/powerpagecomponent_mspp_webrole_contact?$select=powerpagecomponentid,name`],
  );
  assert.deepEqual(
    calls.filter((c) => c.kind === 'connection').map((c) => c.value),
    [f.connection],
  );
  await f.preserved();
});

test('the default connection resolves from the toolkit checkout whatever the working directory', async (t) => {
  const f = await fixture(t);
  const result = await f.run(['--site', site, '--catalogue', path.join(f.root, 'selected.json')], false, f.example);
  assert.equal(result.status, 0, result.stderr);
  const calls = (await fs.readFile(f.calls, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(
    calls.filter((c) => c.kind === 'connection').map((c) => c.value),
    [f.connection],
  );
  await f.preserved();
});

test('ambiguous or malformed arguments reject before connection and leave all source bytes unchanged', async (t) => {
  const f = await fixture(t);
  const valid = ['--site', site, '--catalogue', 'selected.json'];
  for (const args of [
    ['--site', site],
    ['--site', '-'.repeat(36), '--catalogue', 'selected.json'],
    [...valid, '--unknown'],
    [...valid, '--connection'],
    [...valid, '--catalogue', 'other.json'],
    [...valid, '--apply', '--apply'],
    [...valid, '--variant', 'parent-only'],
    ['--site', site, '--catalogue', ''],
    [...valid, '--connection', ''],
  ]) {
    const result = await f.run(args, true);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.match(result.stderr, /^[^\n]+\n$/, 'one line on stderr');
    assert.doesNotMatch(result.stderr, /CONNECTION MODULE LOADED|\n\s+at |ERR_PARSE_ARGS/);
    await f.preserved();
  }
  await assert.rejects(fs.stat(f.calls), { code: 'ENOENT' });
});

test('help needs no schema, catalogue, blueprint or connection and causes no evidence writes', async (t) => {
  const f = await fixture(t);
  for (const target of ['dataverse', 'data', 'portal-security/blueprint.json'])
    await fs.rm(path.join(f.example, target), { recursive: true, force: true });
  for (const target of ['.paqvilo', 'selected.json'])
    await fs.rm(path.join(f.root, target), { recursive: true, force: true });
  const result = await f.run(['--help'], true);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--catalogue FILE/);
  await assert.rejects(fs.stat(path.join(f.root, '.paqvilo')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(f.example, '.paqvilo')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(f.calls), { code: 'ENOENT' });
});

test('invalid local inputs or unverified organisation fail without blueprint mutation or remote calls', async (t) => {
  const f = await fixture(t);
  const absent = await f.run(['--site', site, '--catalogue', 'missing.json'], true);
  assert.notEqual(absent.status, 0);
  assert.doesNotMatch(absent.stderr, /CONNECTION MODULE LOADED/);
  await f.preserved();
  await fs.writeFile(f.connection, '{}');
  const result = await f.run(['--site', site, '--catalogue', 'selected.json', '--connection', f.connection, '--apply']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /organisationId GUID is required/);
  const calls = (await fs.readFile(f.calls, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(
    calls.map((c) => c.kind),
    ['connection'],
  );
  await f.preserved();
});

test('failed organisation verification preserves all source bytes before site inspection or writes', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.connection, JSON.stringify({ organisationId: organisation, rejectOrganisation: true }));
  const result = await f.run(['--site', site, '--catalogue', 'selected.json', '--apply']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invented organisation mismatch/);
  const calls = (await fs.readFile(f.calls, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(
    calls.map((call) => call.kind),
    ['connection', 'verify'],
  );
  await assert.rejects(fs.stat(path.join(f.example, '.paqvilo/portal-security')), { code: 'ENOENT' });
  await f.preserved();
});
