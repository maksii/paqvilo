// Secret resolver: Key Vault reference forms, every status, the fail-closed allow list, versions, expiry with a fixed
// clock, and that values never reach describe(), diagnostics or JSON.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSecretResolver,
  parseSecretReference,
  secretSettings,
  effectiveEnvironmentVariables,
  environmentVariablePayload,
  bindSiteSettings,
} from '../lib/secret-resolver.mjs';

const ALLOWED = '77777777-7777-4777-8777-777777777777';
const OTHER = '88888888-8888-4888-8888-888888888888';
const VALUE = 'invented-secret-value-4f2a';
const ARM =
  '/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/rg-invented/providers/Microsoft.KeyVault/vaults/fx-vault/secrets/func-key';
const URI = 'https://fx-vault.vault.azure.net/secrets/func-key';
const CLOCK = Date.parse('2026-10-22T00:00:00Z');

function resolver(entries, { env = { FX_FUNC_KEY: VALUE }, protect, clock = () => CLOCK } = {}) {
  const diagnostics = [];
  return {
    diagnostics,
    secrets: createSecretResolver({ secrets: entries, env, protect, clock, diagnostic: (d) => diagnostics.push(d) }),
  };
}
const entry = (extra = {}) => ({
  'fx-vault/func-key': { source: 'environment', variable: 'FX_FUNC_KEY', allow: [ALLOWED], ...extra },
});

test('both reference forms normalise to one vault/name key, with an optional version', () => {
  assert.deepEqual(parseSecretReference(ARM), {
    vault: 'fx-vault',
    name: 'func-key',
    version: null,
    key: 'fx-vault/func-key',
  });
  assert.deepEqual(parseSecretReference(URI + '/v2'), {
    vault: 'fx-vault',
    name: 'func-key',
    version: 'v2',
    key: 'fx-vault/func-key',
  });
  assert.equal(parseSecretReference('https://fx-vault.example.test/secrets/func-key'), null);
  assert.equal(parseSecretReference(VALUE), null);
});

test('resolve answers the value to an allowed principal through either form', async () => {
  const { secrets } = resolver(entry());
  for (const reference of [ARM, URI]) {
    const answer = await secrets.resolve(reference, { principalId: ALLOWED.toUpperCase(), purpose: 'test' });
    assert.deepEqual(answer, { status: 'resolved', value: VALUE, version: null });
  }
});

test('the allow list fails closed: absent or not listing the principal is denied', async () => {
  assert.equal((await resolver(entry()).secrets.resolve(URI, { principalId: OTHER })).status, 'denied');
  assert.equal((await resolver(entry()).secrets.resolve(URI, {})).status, 'denied');
  assert.equal(
    (await resolver(entry({ allow: undefined })).secrets.resolve(URI, { principalId: ALLOWED })).status,
    'denied',
  );
});

test('unbound, disabled, missing and expired answer their status with a reason and no value', async () => {
  const cases = [
    [resolver(entry()), 'https://other-vault.vault.azure.net/secrets/func-key', 'unbound'],
    [resolver(entry()), 'not a reference', 'unbound'],
    [resolver(entry({ disabled: true })), URI, 'disabled'],
    [resolver(entry(), { env: {} }), URI, 'missing'],
    [resolver(entry({ expiresOn: '2026-10-21T00:00:00Z' })), URI, 'expired'],
  ];
  for (const [{ secrets }, reference, status] of cases) {
    const answer = await secrets.resolve(reference, { principalId: ALLOWED });
    assert.equal(answer.status, status, reference);
    assert.equal(typeof answer.reason, 'string');
    assert.equal('value' in answer, false);
  }
  const later = resolver(entry({ expiresOn: '2026-10-23T00:00:00Z' }));
  assert.equal((await later.secrets.resolve(URI, { principalId: ALLOWED })).expiresOn, '2026-10-23T00:00:00.000Z');
});

test('versions: the current version resolves, any other version is missing', async () => {
  const { secrets } = resolver(entry({ versions: { current: 'v2' } }));
  assert.deepEqual(await secrets.resolve(URI + '/v2', { principalId: ALLOWED }), {
    status: 'resolved',
    value: VALUE,
    version: 'v2',
  });
  assert.equal((await secrets.resolve(URI, { principalId: ALLOWED })).version, 'v2');
  assert.equal((await secrets.resolve(URI + '/v1', { principalId: ALLOWED })).status, 'missing');
  assert.equal((await resolver(entry()).secrets.resolve(URI + '/v1', { principalId: ALLOWED })).status, 'missing');
});

test('a protected source reads through the injected unprotect adapter; a failing adapter is missing', async () => {
  const protectedEntry = { 'fx-vault/func-key': { source: 'protected', protectedValue: 'AAAA', allow: [ALLOWED] } };
  const ok = resolver(protectedEntry, { protect: { unprotect: async (blob) => (blob === 'AAAA' ? VALUE : null) } });
  assert.equal((await ok.secrets.resolve(URI, { principalId: ALLOWED })).value, VALUE);
  const broken = resolver(protectedEntry, {
    protect: {
      unprotect: async () => {
        throw new Error(`boom ${VALUE}`);
      },
    },
  });
  const answer = await broken.secrets.resolve(URI, { principalId: ALLOWED });
  assert.equal(answer.status, 'missing');
  assert.doesNotMatch(JSON.stringify([answer, broken.diagnostics]), new RegExp(VALUE));
});

test('describe reports status only, and no value reaches describe, diagnostics, errors or JSON', async () => {
  const { secrets, diagnostics } = resolver(entry({ versions: { current: 'v2' }, expiresOn: '2027-01-01T00:00:00Z' }));
  assert.deepEqual(secrets.describe(URI), {
    bound: true,
    status: 'available',
    version: 'v2',
    expiresOn: '2027-01-01T00:00:00.000Z',
  });
  assert.deepEqual(secrets.describe('https://none.vault.azure.net/secrets/x'), {
    bound: false,
    status: 'unbound',
    version: null,
    expiresOn: null,
  });
  await secrets.resolve(URI, { principalId: OTHER });
  await secrets.resolve(URI + '/v9', { principalId: ALLOWED });
  assert.equal(diagnostics.length, 2);
  assert.deepEqual(
    diagnostics.map((d) => d.code),
    ['SECRET_DENIED', 'SECRET_MISSING'],
  );
  assert.deepEqual(secrets.keys(), ['fx-vault/func-key']);
  assert.doesNotMatch(
    JSON.stringify({ describe: secrets.describe(URI), diagnostics, keys: secrets.keys(), resolver: secrets }),
    new RegExp(VALUE),
  );
});

test('secretSettings rejects literal values and malformed entries', () => {
  assert.throws(() => secretSettings({ 'fx-vault/func-key': { value: VALUE } }), /never live in config/);
  assert.throws(() => secretSettings({ 'fx-vault/func-key': { secret: VALUE } }), /never live in config/);
  assert.throws(() => secretSettings({ 'no-slash': { variable: 'X' } }), /keys are/);
  assert.throws(() => secretSettings({ 'a/b': { variable: 'bad name' } }), /variable/);
  assert.throws(() => secretSettings({ 'a/b': { variable: 'X', allow: ['someone'] } }), /allow/);
  assert.throws(() => secretSettings({ 'a/b': { variable: 'X', expiresOn: 'soon' } }), /expiresOn/);
  assert.throws(() => secretSettings({ 'a/b': { variable: 'X', extra: 1 } }), /Unknown/);
  assert.deepEqual(secretSettings({ 'A/B': { variable: 'X' } }), {
    'a/b': { source: 'environment', variable: 'X', allow: [], disabled: false },
  });
});

const state = () => ({
  tables: {
    environmentvariabledefinition: [
      {
        environmentvariabledefinitionid: 'def-url',
        schemaname: 'fx_ApiUrl',
        type: 100000000,
        defaultvalue: 'https://default.example.test',
      },
      { environmentvariabledefinitionid: 'def-count', schemaname: 'fx_Count', type: 100000001, defaultvalue: '1' },
      { environmentvariabledefinitionid: 'def-key', schemaname: 'fx_Key', type: 100000005, secretstore: 0 },
      {
        environmentvariabledefinitionid: 'def-store',
        schemaname: 'fx_Stored',
        type: 100000000,
        secretstore: 1,
        defaultvalue: VALUE,
      },
    ],
    environmentvariablevalue: [
      {
        environmentvariablevalueid: 'v1',
        environmentvariabledefinitionid: { id: 'def-url' },
        value: 'https://solution.example.test',
      },
      { environmentvariablevalueid: 'v2', environmentvariabledefinitionid: 'def-key', value: URI },
    ],
  },
});

test('effectiveEnvironmentVariables layers default, value row and overrides, and marks secrets with their reference only', () => {
  const plain = effectiveEnvironmentVariables(state());
  assert.equal(plain.fx_apiurl.value, 'https://solution.example.test');
  assert.equal(plain.fx_count.value, '1');
  assert.deepEqual(plain.fx_key, {
    schemaName: 'fx_Key',
    id: 'def-key',
    type: 100000005,
    secret: true,
    reference: URI,
  });
  assert.deepEqual(plain.fx_stored, {
    schemaName: 'fx_Stored',
    id: 'def-store',
    type: 100000000,
    secret: true,
    reference: null,
  });
  const layered = effectiveEnvironmentVariables(state(), {
    overrides: [{ FX_APIURL: 'http://127.0.0.1:7071' }, { fx_Count: '3' }],
  });
  assert.equal(layered.fx_apiurl.value, 'http://127.0.0.1:7071');
  assert.equal(layered.fx_count.value, '3');
  const payload = environmentVariablePayload(state());
  assert.deepEqual(payload, {
    fx_apiurl: 'https://solution.example.test',
    fx_count: '1',
    fx_key: { secret: true },
    fx_stored: { secret: true },
  });
  assert.doesNotMatch(JSON.stringify([plain, payload]), new RegExp(VALUE));
});

test('bindSiteSettings applies non-secret values and resolves secret bindings as the portal principal', async () => {
  const effective = effectiveEnvironmentVariables(state());
  const { secrets } = resolver({ 'fx-vault/func-key': { variable: 'FX_FUNC_KEY', allow: [ALLOWED] } });
  const diagnostics = [];
  const bound = await bindSiteSettings(
    { 'Api/Url': '', Static: 'x' },
    { 'Api/Url': 'fx_apiurl', 'Api/Key': 'def-key', Missing: 'fx_nothing' },
    effective,
    { resolver: secrets, principalId: ALLOWED, diagnostic: (d) => diagnostics.push(d) },
  );
  assert.deepEqual(bound.settings, { 'Api/Url': 'https://solution.example.test', Static: 'x', 'Api/Key': VALUE });
  assert.deepEqual(bound.secretNames, ['Api/Key']);
  assert.deepEqual(
    diagnostics.map((d) => d.code),
    ['SITE_SETTING_ENVIRONMENT_VARIABLE_UNMATCHED'],
  );
  const without = await bindSiteSettings({}, { 'Api/Key': 'fx_key' }, effective);
  assert.deepEqual(without.settings, {});
});

test('the importer records site settings bound to an environment variable', async (t) => {
  const fs = await import('node:fs/promises'),
    os = await import('node:os'),
    path = await import('node:path');
  const { importPortal } = await import('../lib/importer.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'site-setting-env-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'website.yml'), 'adx_websiteid: site\nadx_name: Bound settings');
  await fs.writeFile(
    path.join(dir, 'sitesetting.yml'),
    '- adx_sitesettingid: s1\n  adx_name: Api/Url\n  adx_environmentvariable: def-url\n  adx_source: 1\n- adx_sitesettingid: s2\n  adx_name: Static\n  adx_value: x',
  );
  const portal = await importPortal(dir);
  assert.deepEqual(portal.settingEnvironmentVariables, { 'Api/Url': 'def-url' });
  const bound = await bindSiteSettings(
    portal.settings,
    portal.settingEnvironmentVariables,
    effectiveEnvironmentVariables(state()),
  );
  assert.deepEqual(bound.settings, { 'Api/Url': 'https://solution.example.test', Static: 'x' });
});
