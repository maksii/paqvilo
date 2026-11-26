// @test-kind contract: the implicitGrant.signingKeys project setting is Paqvilo's own configuration for the uploaded custom certificate of https://learn.microsoft.com/power-pages/security/oauth-implicit-grant-flow#custom-certificates; the per-test kinds below override it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { handleImplicitGrant } from '../lib/auth-token.mjs';
import { implicitGrantSettings } from '../lib/implicit-grant-settings.mjs';
import { parseSetting, runtimeOptions } from '../lib/config-keys.mjs';
import { resolveProjectConfig } from '../lib/project-config.mjs';
import { signInHeaders } from '../testing/session.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const CONTACT = 'c3000000-0000-4000-8000-000000000020';
const THUMBPRINT_A = '0123456789ABCDEF0123456789ABCDEF01234567';
const THUMBPRINT_B = 'FEDCBA9876543210FEDCBA9876543210FEDCBA98';

const pemPair = (modulusLength = 2048) => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  return { privatePem, publicPem: createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }) };
};
// The base64 body of a PEM block: what a leak of the key would contain in any encoding of the file.
const pemBody = (pem) => pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');

async function workspace(t) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'implicit-grant-key-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const site = path.join(dir, 'site');
  const keys = path.join(dir, 'keys');
  await fs.mkdir(site, { recursive: true });
  await fs.mkdir(keys, { recursive: true });
  await fs.writeFile(path.join(site, 'website.yml'), 'adx_websiteid: site\nadx_name: Invented signing');
  await fs.writeFile(
    path.join(site, 'Home.webpage.yml'),
    'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true',
  );
  return { dir, site, keys };
}
const writeKey = async (file, pem) => (await fs.writeFile(file, pem), file);

async function call(route, { signingKeys, settings = {}, onKeyError } = {}) {
  const url = new URL(`http://127.0.0.1${route}`);
  const req = { method: route.includes('publickey') ? 'GET' : 'POST', headers: {}, async *[Symbol.asyncIterator]() {} };
  const res = {
    writeHead(status, headers) {
      Object.assign(this, { status, headers });
    },
    end(body) {
      this.body = body ?? '';
    },
  };
  await handleImplicitGrant(req, res, url, {
    portal: { settings },
    identity: { contactId: CONTACT },
    contact: { contactid: CONTACT },
    origin: 'http://127.0.0.1:9',
    signingKeys,
    onKeyError,
  });
  return res;
}
const verifies = (token, publicPem) => {
  const [header, payload, signature] = token.split('.');
  return createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(publicPem, signature, 'base64url');
};

// @test-kind contract: the setting's shape, path resolution and refusals are Paqvilo's own configuration contract.
test('implicitGrant validates signing key entries and resolves key files against the project folder', () => {
  const base = path.resolve('invented-project');
  assert.deepEqual(
    parseSetting(
      'implicitGrant',
      { signingKeys: [{ privateKeyFile: 'keys/a.pem', thumbprint: '01:23 45' + THUMBPRINT_A.slice(6) }] },
      { base },
    ),
    { signingKeys: [{ privateKeyFile: path.join(base, 'keys', 'a.pem'), thumbprint: THUMBPRINT_A }] },
  );
  assert.equal(parseSetting('implicitGrant', undefined), undefined);
  assert.deepEqual(runtimeOptions({ project: { implicitGrant: { signingKeys: [] } } }).implicitGrant, {
    signingKeys: [],
  });
  for (const [value, message] of [
    [[], /must be an object/],
    [{ keys: [] }, /Unknown setting implicitGrant\.keys/],
    [{ signingKeys: [] }, /non-empty array/],
    [{ signingKeys: [{ privateKeyFile: '' }] }, /privateKeyFile must be the path/],
    [
      { signingKeys: [{ privateKeyFile: 'a.pem', password: 'x' }] },
      /Unknown setting implicitGrant\.signingKeys\[0\]\.password/,
    ],
    [{ signingKeys: [{ privateKeyFile: 'a.pem', thumbprint: 'abc' }] }, /40 hexadecimal digits/],
    [
      { signingKeys: [{ privateKeyFile: 'a.pem' }, { privateKeyFile: 'b.pem' }] },
      /only one entry without a thumbprint/,
    ],
    [
      {
        signingKeys: [
          { privateKeyFile: 'a.pem', thumbprint: THUMBPRINT_A },
          { privateKeyFile: 'b.pem', thumbprint: THUMBPRINT_A.toLowerCase() },
        ],
      },
      /listed twice/,
    ],
  ])
    assert.throws(() => implicitGrantSettings(value, 'implicitGrant', base), message);
});

// @test-kind contract: a configured key signs and is served on the existing public key endpoint; without one the per-process key is unchanged.
test('tokens verify with the configured public key, which the public key endpoint serves', async (t) => {
  const { keys } = await workspace(t);
  const pair = pemPair();
  const signingKeys = [
    { privateKeyFile: await writeKey(path.join(keys, 'default.pem'), pair.privatePem), thumbprint: null },
  ];
  const published = await call('/_services/auth/publickey', { signingKeys });
  assert.equal(published.status, 200);
  assert.equal(published.body, pair.publicPem);
  const token = await call('/_services/auth/token', { signingKeys });
  assert.equal(token.status, 200);
  assert.equal(verifies(token.body, pair.publicPem), true);
  // Default behaviour: no configured key keeps the per-process key, which the configured key does not verify.
  const generated = await call('/_services/auth/publickey');
  assert.notEqual(generated.body, pair.publicPem);
  const local = await call('/_services/auth/token');
  assert.equal(verifies(local.body, generated.body), true);
  assert.equal(verifies(local.body, pair.publicPem), false);
});

// @test-kind compatibility: CustomCertificates/ImplicitGrantflow names the certificate by thumbprint, https://learn.microsoft.com/power-pages/security/oauth-implicit-grant-flow#custom-certificates
test('CustomCertificates/ImplicitGrantflow selects the configured key with that thumbprint', async (t) => {
  const { keys } = await workspace(t);
  const [fallback, first, second] = [pemPair(), pemPair(), pemPair()];
  const signingKeys = [
    { privateKeyFile: await writeKey(path.join(keys, 'fallback.pem'), fallback.privatePem), thumbprint: null },
    { privateKeyFile: await writeKey(path.join(keys, 'a.pem'), first.privatePem), thumbprint: THUMBPRINT_A },
    { privateKeyFile: await writeKey(path.join(keys, 'b.pem'), second.privatePem), thumbprint: THUMBPRINT_B },
  ];
  const named = (value) => ({ signingKeys, settings: { 'CustomCertificates/ImplicitGrantflow': value } });
  assert.equal((await call('/_services/auth/publickey', named(THUMBPRINT_B.toLowerCase()))).body, second.publicPem);
  assert.equal(verifies((await call('/_services/auth/token', named(THUMBPRINT_A))).body, first.publicPem), true);
  // Not named, or named but not configured: the entry without a thumbprint.
  assert.equal((await call('/_services/auth/publickey', { signingKeys })).body, fallback.publicPem);
  assert.equal((await call('/_services/auth/publickey', named('99'.repeat(20)))).body, fallback.publicPem);
  // A thumbprinted key alone applies only when the setting names it.
  const only = [signingKeys[1]];
  assert.notEqual((await call('/_services/auth/publickey', { signingKeys: only })).body, first.publicPem);
  assert.equal(
    (
      await call('/_services/auth/publickey', {
        signingKeys: only,
        settings: { 'CustomCertificates/ImplicitGrantflow': THUMBPRINT_A },
      })
    ).body,
    first.publicPem,
  );
});

// @test-kind security: a key file that cannot be used is a clear configuration error naming the file and reason, never its content, and a key inside the sources is refused.
test('a missing, invalid, encrypted, short or in-source key file is refused when the project loads', async (t) => {
  const { dir, site, keys } = await workspace(t);
  const good = pemPair();
  const short = pemPair(1024);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const encrypted = privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'invented' });
  const { privateKey: ecKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const files = {
    garbage: await writeKey(
      path.join(keys, 'garbage.pem'),
      '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n',
    ),
    encrypted: await writeKey(path.join(keys, 'encrypted.pem'), encrypted),
    short: await writeKey(path.join(keys, 'short.pem'), short.privatePem),
    ec: await writeKey(path.join(keys, 'ec.pem'), ecKey.export({ type: 'pkcs8', format: 'pem' })),
    inside: await writeKey(path.join(site, 'signing.pem'), good.privatePem),
  };
  const project = (privateKeyFile) =>
    resolveProjectConfig(
      { version: 2, portals: [{ id: 'invented', path: 'site' }], implicitGrant: { signingKeys: [{ privateKeyFile }] } },
      path.join(dir, 'mirage.project.yml'),
    );
  for (const [file, reason] of [
    [path.join(keys, 'absent.pem'), /does not exist/],
    [files.garbage, /is not a PEM private key/],
    [files.encrypted, /is encrypted/],
    [files.short, /shorter than 2048 bits/],
    [files.ec, /does not hold an RSA key/],
    [files.inside, /inside a portal export or Solution folder/],
  ]) {
    const refusal = await project(file).then(
      () => assert.fail(`${file} was accepted`),
      (error) => error,
    );
    assert.equal(refusal.code, 'IMPLICIT_GRANT_SIGNING_KEY_INVALID', file);
    assert.match(refusal.message, /^implicitGrant\.signingKeys\[0\]\.privateKeyFile: /);
    assert.match(refusal.message, reason);
    assert.ok(refusal.message.includes(file), 'the message names the file');
    for (const pem of [good.privatePem, short.privatePem, encrypted])
      assert.ok(!refusal.message.includes(pemBody(pem).slice(0, 40)));
  }
  const accepted = await project(await writeKey(path.join(keys, 'good.pem'), good.privatePem));
  assert.deepEqual(accepted.implicitGrant.signingKeys, [
    { privateKeyFile: path.join(keys, 'good.pem'), thumbprint: null },
  ]);
  assert.ok(!JSON.stringify(accepted).includes(pemBody(good.privatePem).slice(0, 40)), 'the project holds paths only');
});

// @test-kind security: the private key never appears in a response, the runtime status, diagnostics or the log stream, and a key file lost at run time is reported without its path in the response.
test('a runtime signs with the configured key and never exposes the private key', async (t) => {
  const { site, keys } = await workspace(t);
  const pair = pemPair();
  const keyFile = await writeKey(path.join(keys, 'runtime.pem'), pair.privatePem);
  const initial = {
    version: 1,
    mappings: { contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' } },
    tables: { contact: [{ contactid: CONTACT, fullname: 'Invented Contact', firstname: 'Invented' }] },
    permissions: [],
    settings: { permissionMode: 'enforce' },
    simulator: { mode: 'local', pageMode: 'local', identity: { roles: [] }, live: { origin: null }, endpoints: [] },
  };
  const app = await createSimulator({
    sourceDir: site,
    stateFile: path.join(site, '..', 'state.json'),
    initial,
    watch: false,
    implicitGrant: { signingKeys: [{ privateKeyFile: keyFile, thumbprint: null }] },
  });
  ownedFixture(t).add(() => app.close());
  const session = signInHeaders(app, CONTACT, { roles: ['Authenticated Users'] });
  const seen = [];
  const read = async (response) => {
    const text = await response.text();
    seen.push(text, JSON.stringify([...response.headers]));
    return { status: response.status, text };
  };
  const publicKey = await read(await fetch(`${app.url}/_services/auth/publickey`));
  assert.equal(publicKey.text, pair.publicPem);
  const token = await read(await fetch(`${app.url}/_services/auth/token`, { method: 'POST', headers: session }));
  assert.equal(token.status, 200);
  assert.equal(verifies(token.text, pair.publicPem), true);

  await fs.rm(keyFile);
  const lost = await read(await fetch(`${app.url}/_services/auth/token`, { method: 'POST', headers: session }));
  assert.equal(lost.status, 500);
  assert.equal(JSON.parse(lost.text).ErrorId, 'PortalSTS0006');
  assert.ok(!lost.text.includes(keys), 'the response does not name the key file');
  const diagnostics = await read(await fetch(`${app.url}/__sim/api/diagnostics`));
  assert.ok(
    JSON.parse(diagnostics.text).diagnostics.some(
      (item) => item.code === 'IMPLICIT_GRANT_SIGNING_KEY_INVALID' && item.file === keyFile,
    ),
  );
  await read(await fetch(`${app.url}/__sim/api/status`));
  await read(await fetch(`${app.url}/__sim/api/logs?limit=1000`));
  seen.push(JSON.stringify(app.state()));
  const secret = pemBody(pair.privatePem);
  for (const text of seen)
    for (let at = 0; at + 40 <= secret.length; at += 40) assert.ok(!text.includes(secret.slice(at, at + 40)));
});
