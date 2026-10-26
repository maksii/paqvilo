import assert from 'node:assert/strict';
import { spawnSync, execFile } from 'node:child_process';
import crypto from 'node:crypto';
import https from 'node:https';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { createSelfSignedCertificate, ensureCertificate } from '../lib/dataverse-tls.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';

const DAY = 86_400_000;
const HOUR = 3_600_000;
// A fixed issue time (whole seconds, as X.509 times are) so validity bounds are exact, not wall-clock dependent.
const ISSUED = Date.parse('2026-01-01T00:00:00.000Z');
const execFileAsync = promisify(execFile);
// The first interpreter that runs: python3 (Linux, macOS), python (Windows) or the Windows py launcher. A Windows
// app-execution alias that only opens the Store exits non-zero, so it counts as not installed.
const python = ['python3', 'python', 'py'].find((name) => spawnSync(name, ['--version']).status === 0) ?? null;
const openssl = spawnSync('openssl', ['version']).status === 0;
// DER of the nameConstraints OID (2.5.29.30).
const NAME_CONSTRAINTS_OID = Buffer.from('0603551d1e', 'hex');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function get(port, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port, path: '/', method: 'GET', ...options }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('generated certificate is a CA-flagged self-signed loopback certificate', () => {
  const { key, cert, fingerprint256, notAfter } = createSelfSignedCertificate({ clock: () => ISSUED });
  const x509 = new crypto.X509Certificate(cert);

  assert.match(x509.subject, /CN=Paqvilo Mirage Dataverse simulator/);
  assert.equal(x509.checkIP('127.0.0.1'), '127.0.0.1');
  assert.equal(x509.checkIP('::1'), '::1');
  assert.equal(x509.checkHost('localhost'), 'localhost');
  assert.equal(x509.ca, true);
  assert.match(x509.subjectAltName, /DNS:localhost/);
  assert.equal(x509.verify(crypto.createPublicKey(cert)), true);
  assert.equal(x509.checkPrivateKey(crypto.createPrivateKey(key)), true);
  assert.match(x509.fingerprint256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  assert.equal(fingerprint256, x509.fingerprint256);
  assert.equal(new Date(notAfter).getTime(), new Date(x509.validTo).getTime());
  // Valid for 825 days from issue, and from one hour before it (tolerates a client clock running behind).
  assert.equal(new Date(x509.validTo).getTime(), ISSUED + 825 * DAY);
  assert.equal(new Date(x509.validFrom).getTime(), ISSUED - HOUR);

  // Node does not expose keyUsage bits (its keyUsage is EKU), so check the DER: critical, BIT STRING 03 02 02 a4.
  const der = Buffer.from(cert.replace(/-----[^-]+-----|\s/g, ''), 'base64');
  const kuAt = der.indexOf(Buffer.from('0603551d0f', 'hex'));
  assert.ok(kuAt > 0, 'keyUsage OID present');
  assert.deepEqual([...der.subarray(kuAt + 5, kuAt + 14)], [0x01, 0x01, 0xff, 0x04, 0x04, 0x03, 0x02, 0x02, 0xa4]);
});

test('https server is trusted via ca option and rejected without it', async (t) => {
  const { key, cert } = createSelfSignedCertificate();
  const server = https.createServer({ key, cert }, (req, res) => res.end('ok'));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = await listen(server);

  const trusted = await get(port, { ca: cert });
  assert.deepEqual(trusted, { status: 200, body: 'ok' });

  await assert.rejects(get(port), (error) => {
    assert.ok(['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(error.code), error.code);
    return true;
  });
});

test('global fetch trusts the certificate through NODE_EXTRA_CA_CERTS', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'paqvilo-tls-'));
  ownedFixture(t).remove(() => rm(dir, { recursive: true, force: true }));
  const { key, cert } = createSelfSignedCertificate();
  const caFile = join(dir, 'ca.pem');
  await writeFile(caFile, cert);
  const server = https.createServer({ key, cert }, (req, res) => res.end('ok'));
  ownedFixture(t).add(() => new Promise((resolve) => server.close(resolve)));
  const port = await listen(server);

  const script = 'fetch(process.env.TEST_URL).then((r) => r.text()).then((text) => process.stdout.write(text))';
  const { stdout } = await execFileAsync(process.execPath, ['-e', script], {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: caFile, TEST_URL: `https://127.0.0.1:${port}/` },
  });
  assert.equal(stdout, 'ok');
});

test(
  'python ssl trusts the certificate as a CA bundle',
  { skip: python ? false : 'python is not installed' },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'paqvilo-tls-'));
    ownedFixture(t).remove(() => rm(dir, { recursive: true, force: true }));
    const { key, cert } = createSelfSignedCertificate();
    const caFile = join(dir, 'ca.pem');
    await writeFile(caFile, cert);
    const server = https.createServer({ key, cert }, (req, res) => res.end('ok'));
    ownedFixture(t).add(() => new Promise((resolve) => server.close(resolve)));
    const port = await listen(server);

    const code = [
      'import ssl, sys, urllib.request',
      'ctx = ssl.create_default_context(cafile=sys.argv[2])',
      'print(urllib.request.urlopen(sys.argv[1], context=ctx).read().decode())',
    ].join('\n');
    const { stdout } = await execFileAsync(python, ['-I', '-c', code, `https://127.0.0.1:${port}/`, caFile]);
    assert.equal(stdout.trim(), 'ok');
  },
);

test('ensureCertificate reuses a valid file and regenerates one that expires within 7 days', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'paqvilo-tls-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'nested', 'mirage.pem');

  const first = await ensureCertificate(file, { clock: () => ISSUED });
  assert.equal(first.file, file);
  assert.match(await readFile(file, 'utf8'), /-----BEGIN CERTIFICATE-----[\s\S]+-----BEGIN PRIVATE KEY-----/);
  const second = await ensureCertificate(file, { clock: () => ISSUED });
  assert.equal(second.fingerprint256, first.fingerprint256);
  assert.equal(second.key, first.key);

  // 825 days of validity: one second more than 7 days left is reused, exactly 7 days left is renewed.
  const renewAt = ISSUED + (825 - 7) * DAY;
  assert.equal((await ensureCertificate(file, { clock: () => renewAt - 1000 })).fingerprint256, first.fingerprint256);
  const nearExpiry = await ensureCertificate(file, { clock: () => renewAt });
  assert.notEqual(nearExpiry.fingerprint256, first.fingerprint256);
});

test(
  'the CA is path-length 0 and name-constrained, and a leaf for another name fails verification',
  { skip: openssl ? false : 'openssl is not installed' },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'paqvilo-tls-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const { key, cert } = createSelfSignedCertificate();
    const der = Buffer.from(cert.replace(/-----[^-]+-----|\s/g, ''), 'base64');
    assert.ok(der.includes(Buffer.from('30060101ff020100', 'hex')), 'basicConstraints CA:TRUE, pathLenConstraint 0');
    assert.ok(der.includes(NAME_CONSTRAINTS_OID), 'nameConstraints extension present');
    assert.equal(
      Buffer.from(
        createSelfSignedCertificate({ hosts: [] }).cert.replace(/-----[^-]+-----|\s/g, ''),
        'base64',
      ).includes(NAME_CONSTRAINTS_OID),
      false,
    );

    const ca = join(dir, 'ca.pem');
    await writeFile(ca, cert + key);
    const leaf = async (name) => {
      const base = join(dir, name);
      await execFileAsync('openssl', [
        'req',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        `${base}.key`,
        '-subj',
        `/CN=${name}`,
        '-out',
        `${base}.csr`,
      ]);
      await writeFile(`${base}.ext`, `subjectAltName=DNS:${name}\nbasicConstraints=CA:FALSE\n`);
      await execFileAsync('openssl', [
        'x509',
        '-req',
        '-in',
        `${base}.csr`,
        '-CA',
        ca,
        '-CAkey',
        ca,
        '-set_serial',
        '1',
        '-days',
        '1',
        '-extfile',
        `${base}.ext`,
        '-out',
        `${base}.pem`,
      ]);
      return `${base}.pem`;
    };
    const verify = (file) => spawnSync('openssl', ['verify', '-CAfile', ca, file]).status;
    assert.equal(verify(await leaf('localhost')), 0);
    assert.notEqual(verify(await leaf('login.microsoftonline.com')), 0);
  },
);

test(
  'a reused certificate without the name constraint is regenerated',
  { skip: openssl ? false : 'openssl is not installed' },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'paqvilo-tls-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const keyFile = join(dir, 'old.key');
    const certFile = join(dir, 'old.crt');
    await execFileAsync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyFile,
      '-out',
      certFile,
      '-days',
      '800',
      '-subj',
      '/CN=Unconstrained earlier CA',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1',
    ]);
    const oldCert = await readFile(certFile, 'utf8');
    const file = join(dir, 'mirage.pem');
    await writeFile(file, oldCert + (await readFile(keyFile, 'utf8')));
    const replaced = await ensureCertificate(file);
    assert.notEqual(replaced.fingerprint256, new crypto.X509Certificate(oldCert).fingerprint256);
  },
);

test('a reused file is regenerated when it does not cover the requested hosts', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'paqvilo-tls-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'mirage.pem');
  const first = await ensureCertificate(file);
  const widened = await ensureCertificate(file, { hosts: ['127.0.0.1', 'localhost', 'mirage-extra.localhost'] });
  assert.notEqual(widened.fingerprint256, first.fingerprint256);
  assert.equal(new crypto.X509Certificate(widened.cert).checkHost('mirage-extra.localhost'), 'mirage-extra.localhost');
});

test('a reused file whose key does not match its certificate, or that does not parse, is regenerated', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'paqvilo-tls-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'mirage.pem');
  const one = createSelfSignedCertificate(),
    other = createSelfSignedCertificate();
  await writeFile(file, one.cert + other.key);
  const mismatched = await ensureCertificate(file);
  assert.notEqual(mismatched.fingerprint256, one.fingerprint256);
  assert.equal(
    new crypto.X509Certificate(mismatched.cert).checkPrivateKey(crypto.createPrivateKey(mismatched.key)),
    true,
  );
  assert.equal((await ensureCertificate(file)).fingerprint256, mismatched.fingerprint256, 'the replacement is reused');
  await writeFile(
    file,
    '-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydGlmaWNhdGU=\n-----END CERTIFICATE-----\n' + other.key,
  );
  const unparsable = await ensureCertificate(file);
  assert.notEqual(unparsable.fingerprint256, mismatched.fingerprint256);
  assert.equal(await readFile(file, 'utf8'), unparsable.cert + unparsable.key, 'the replacement is written');
});

test('ensureCertificate(null) returns an in-memory CA with no file', async () => {
  const certificate = await ensureCertificate(null);
  assert.equal(certificate.file, null);
  assert.equal(new crypto.X509Certificate(certificate.cert).checkHost('localhost'), 'localhost');
});
