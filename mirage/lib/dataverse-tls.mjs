import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname } from 'node:path';

// Self-signed loopback certificate for the Dataverse simulator. Node has no X.509 creation API,
// so the DER structure is encoded here. Trust it with NODE_EXTRA_CA_CERTS, the `ca` option or REQUESTS_CA_BUNDLE.
const DAY_MS = 86_400_000;
const RENEW_BEFORE_MS = 7 * DAY_MS;
const SHA256_WITH_RSA = '1.2.840.113549.1.1.11';
const DEFAULT_COMMON_NAME = 'Paqvilo Mirage Dataverse simulator';
const DEFAULT_HOSTS = ['127.0.0.1', '::1', 'localhost'];

// ---- DER encoding ----

function length(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, body) {
  const content = Buffer.from(body);
  return Buffer.concat([Buffer.from([tag]), length(content.length), content]);
}

const seq = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));
const bool = (value) => tlv(0x01, [value ? 0xff : 0x00]);
const nul = () => tlv(0x05, []);
const octetString = (bytes) => tlv(0x04, bytes);
const utf8String = (text) => tlv(0x0c, Buffer.from(text, 'utf8'));
const bitString = (bytes, unusedBits = 0) => tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), bytes]));
const contextTag = (n, bytes, constructed = true) => tlv((constructed ? 0xa0 : 0x80) | n, bytes);

// Minimal two's-complement INTEGER for a non-negative bigint, number or byte buffer.
function integer(value) {
  let bytes = value;
  if (!Buffer.isBuffer(value)) {
    if (BigInt(value) < 0n) throw new Error('negative INTEGER is not supported');
    const hex = BigInt(value).toString(16);
    bytes = Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');
  }
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0 && bytes[start + 1] < 0x80) start += 1;
  bytes = bytes.subarray(start);
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.alloc(1), bytes]);
  return tlv(0x02, bytes);
}

function oid(dotted) {
  const [first, second, ...rest] = dotted.split('.').map(Number);
  const out = [40 * first + second];
  for (const arc of rest) {
    const groups = [arc % 128];
    for (let v = Math.floor(arc / 128); v > 0; v = Math.floor(v / 128)) groups.unshift((v % 128) | 0x80);
    out.push(...groups);
  }
  return tlv(0x06, out);
}

// UTCTime for years 1950-2049, GeneralizedTime otherwise (RFC 5280 section 4.1.2.5).
function time(date) {
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  const year = date.getUTCFullYear();
  const rest = [date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()]
    .map((n) => pad(n))
    .join('');
  return year >= 1950 && year < 2050
    ? tlv(0x17, Buffer.from(`${pad(year % 100)}${rest}Z`, 'ascii'))
    : tlv(0x18, Buffer.from(`${pad(year, 4)}${rest}Z`, 'ascii'));
}

// Named-bit BIT STRING: trailing unused bits are counted in the first byte, as DER requires.
function namedBits(bits) {
  const last = Math.max(...bits);
  const bytes = Buffer.alloc((last >> 3) + 1);
  for (const bit of bits) bytes[bit >> 3] |= 0x80 >> (bit & 7);
  return bitString(bytes, 7 - (last & 7));
}

const extension = (id, value, critical = false) =>
  seq(oid(id), ...(critical ? [bool(true)] : []), octetString(value));

function ipv6Bytes(host) {
  const groups = (text) => (text ? text.split(':') : []);
  const [head, tail] = host.split('::');
  const words = tail === undefined
    ? groups(head)
    : [...groups(head), ...Array(8 - groups(head).length - groups(tail).length).fill('0'), ...groups(tail)];
  return Buffer.from(words.flatMap((hex) => [parseInt(hex, 16) >> 8, parseInt(hex, 16) & 0xff]));
}

const ipBytes = (host) => (isIP(host) === 4 ? Buffer.from(host.split('.').map(Number)) : ipv6Bytes(host));

// GeneralName: [7] iPAddress for literal IPs, [2] dNSName otherwise (both IMPLICIT, so primitive tags).
function generalName(host) {
  if (isIP(host)) return contextTag(7, ipBytes(host), false);
  return contextTag(2, Buffer.from(host, 'ascii'), false);
}

// A permitted subtree for one host: an IP address with an all-ones mask, or the DNS name.
const permittedSubtree = (host) => seq(isIP(host)
  ? contextTag(7, Buffer.concat([ipBytes(host), Buffer.alloc(ipBytes(host).length, 0xff)]), false)
  : generalName(host));

// DER of the nameConstraints OID (2.5.29.30): a reused certificate without it predates the constraint and is regenerated.
const NAME_CONSTRAINTS_OID = Buffer.from('0603551d1e', 'hex');

function pem(label, der) {
  return `-----BEGIN ${label}-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
}

// ---- certificate ----

export function createSelfSignedCertificate({
  commonName = DEFAULT_COMMON_NAME,
  hosts = DEFAULT_HOSTS,
  days = 825,
  modulusLength = 2048,
  clock = () => Date.now(),
} = {}) {
  const now = clock();
  const notBefore = new Date(Math.floor((now - 3_600_000) / 1000) * 1000);
  const notAfter = new Date(Math.floor((now + days * DAY_MS) / 1000) * 1000);
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  // For RSA the subjectPublicKey BIT STRING content is exactly the PKCS#1 RSAPublicKey DER.
  const keyIdentifier = createHash('sha1').update(publicKey.export({ type: 'pkcs1', format: 'der' })).digest();
  const algorithm = seq(oid(SHA256_WITH_RSA), nul());
  const name = seq(set(seq(oid('2.5.4.3'), utf8String(commonName))));
  const serial = randomBytes(16);
  serial[0] &= 0x7f;
  const extensions = seq(
    extension('2.5.29.19', seq(bool(true), integer(0)), true), // basicConstraints: CA:TRUE, pathLenConstraint 0 (no sub-CAs)
    extension('2.5.29.15', namedBits([0, 2, 5]), true), // keyUsage: digitalSignature, keyEncipherment, keyCertSign
    extension('2.5.29.17', seq(...hosts.map(generalName))), // subjectAltName
    extension('2.5.29.14', octetString(keyIdentifier)), // subjectKeyIdentifier
    // nameConstraints (critical): the CA can only vouch for the requested hosts, never login.microsoftonline.com or a live organisation.
    ...(hosts.length ? [extension('2.5.29.30', seq(contextTag(0, Buffer.concat(hosts.map(permittedSubtree)))), true)] : []),
  );
  const tbs = seq(
    contextTag(0, integer(2)), // v3
    integer(serial),
    algorithm,
    name,
    seq(time(notBefore), time(notAfter)),
    name,
    spki,
    contextTag(3, extensions),
  );
  const der = seq(tbs, algorithm, bitString(sign('sha256', tbs, privateKey)));
  const cert = pem('CERTIFICATE', der);
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert,
    fingerprint256: new X509Certificate(cert).fingerprint256,
    notAfter: notAfter.toISOString(),
  };
}

// Reuse the PEM file (cert + key) when it parses, matches its key, is valid for more than 7 days, names every
// requested host and carries the name constraint (certificates minted before it was added are replaced).
async function readUsable(file, clock, hosts) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const certPem = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----\n?/)?.[0];
  const keyPem = text.match(/-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----\n?/)?.[0];
  if (!certPem || !keyPem) return null;
  try {
    const cert = new X509Certificate(certPem);
    const notAfter = new Date(cert.validTo);
    if (!cert.checkPrivateKey(createPrivateKey(keyPem))) return null;
    if (!(notAfter.getTime() - clock() > RENEW_BEFORE_MS)) return null;
    if (!hosts.every((host) => (isIP(host) ? cert.checkIP(host) : cert.checkHost(host)) !== undefined)) return null;
    if (hosts.length && !Buffer.from(cert.raw).includes(NAME_CONSTRAINTS_OID)) return null;
    return { key: keyPem, cert: certPem, fingerprint256: cert.fingerprint256, notAfter: notAfter.toISOString() };
  } catch {
    return null;
  }
}

// A null file keeps the CA in memory only: nothing is written where another local user could plant a key.
export async function ensureCertificate(file, options = {}) {
  const clock = options.clock ?? (() => Date.now());
  if (!file) return { ...createSelfSignedCertificate(options), file: null };
  const reused = await readUsable(file, clock, options.hosts ?? DEFAULT_HOSTS);
  if (reused) return { ...reused, file };
  const generated = createSelfSignedCertificate(options);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${generated.cert}${generated.key}`, { mode: 0o600 });
  await chmod(file, 0o600).catch(() => {}); // best effort: Windows ignores POSIX modes
  return { ...generated, file };
}
