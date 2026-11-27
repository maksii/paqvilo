// ASP.NET Identity password hashes of the portal's local accounts (local-accounts.mjs): the contact's
// adx_identity_passwordhash in the version 3 format Mirage writes and the version 2 format a hosted site writes.
import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * An ASP.NET Identity version 3 password hash: 0x01, the PRF (1, HMAC-SHA256), 100,000 rounds and the salt length as
 * big-endian 32-bit numbers, a 16-byte salt and a 32-byte PBKDF2 subkey. A hosted site writes the weaker version 2
 * format (hosted session F4: 68 characters); Mirage verifies both and writes version 3.
 */
export function hashPassword(password) {
  const salt = randomBytes(16);
  const header = Buffer.alloc(13);
  header[0] = 1;
  header.writeUInt32BE(1, 1);
  header.writeUInt32BE(100_000, 5);
  header.writeUInt32BE(salt.length, 9);
  const subkey = pbkdf2Sync(Buffer.from(String(password), 'utf8'), salt, 100_000, 32, 'sha256');
  return Buffer.concat([header, salt, subkey]).toString('base64');
}

// The ASP.NET Identity version 2 format a hosted site writes; Mirage only uses it to balance verification cost.
export function hashPasswordV2(password) {
  const salt = randomBytes(16);
  const subkey = pbkdf2Sync(Buffer.from(String(password), 'utf8'), salt, 1000, 32, 'sha1');
  return Buffer.concat([Buffer.from([0]), salt, subkey]).toString('base64');
}
export const identityVersion = (hash) => {
  const raw = Buffer.from(typeof hash === 'string' ? hash : '', 'base64');
  if (raw.length === 49 && raw[0] === 0) return 2;
  return raw[0] === 1 ? 3 : null;
};

/** Verifies a password against an ASP.NET Identity version 2 or version 3 hash. */
export function verifyHashedPassword(hash, password) {
  const raw = Buffer.from(typeof hash === 'string' ? hash : '', 'base64');
  const secret = Buffer.from(String(password ?? ''), 'utf8');
  if (raw.length === 49 && raw[0] === 0)
    return timingSafeEqual(pbkdf2Sync(secret, raw.subarray(1, 17), 1000, 32, 'sha1'), raw.subarray(17));
  if (raw.length < 13 || raw[0] !== 1) return false;
  const digestName = ['sha1', 'sha256', 'sha512'][raw.readUInt32BE(1)];
  const iterations = raw.readUInt32BE(5),
    saltLength = raw.readUInt32BE(9);
  if (!digestName || iterations < 1 || iterations > 1_000_000 || saltLength < 16 || raw.length < 13 + saltLength + 16)
    return false;
  const expected = raw.subarray(13 + saltLength);
  return timingSafeEqual(
    pbkdf2Sync(secret, raw.subarray(13, 13 + saltLength), iterations, expected.length, digestName),
    expected,
  );
}
