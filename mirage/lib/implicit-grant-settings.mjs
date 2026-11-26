import path from 'node:path';

// A certificate thumbprint as the Power Platform admin center shows it: the SHA-1 digest, 40 hexadecimal digits.
const THUMBPRINT = /^[0-9A-F]{40}$/;

/** A thumbprint without spaces or colons, in upper case; null for an absent or blank value. */
export function normalizeThumbprint(value) {
  if (value == null) return null;
  const text = String(value).replace(/[\s:]/g, '').toUpperCase();
  return text || null;
}

/**
 * mirage `implicitGrant`: { signingKeys: [{ privateKeyFile, thumbprint? }] }. Local signing keys for the portal's
 * implicit grant ID tokens, in place of the key Mirage generates per process. An entry with a thumbprint applies when
 * the site setting CustomCertificates/ImplicitGrantflow names that thumbprint; the one entry without a thumbprint
 * applies otherwise. privateKeyFile resolves against `base` (the project file's folder); the key file is read at
 * project load and when a token is signed, never copied into settings, state or responses.
 */
export function implicitGrantSettings(value, label = 'implicitGrant', base) {
  if (value == null) return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value))
    if (key !== 'signingKeys') throw new Error(`Unknown setting ${label}.${key}; expected signingKeys`);
  if (!Array.isArray(value.signingKeys) || !value.signingKeys.length)
    throw new Error(`${label}.signingKeys must be a non-empty array of { privateKeyFile, thumbprint } entries`);
  const thumbprints = new Set();
  let defaults = 0;
  const signingKeys = value.signingKeys.map((entry, index) => {
    const at = `${label}.signingKeys[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${at} must be a mapping`);
    for (const key of Object.keys(entry))
      if (!['privateKeyFile', 'thumbprint'].includes(key)) throw new Error(`Unknown setting ${at}.${key}`);
    const file = entry.privateKeyFile;
    // eslint-disable-next-line no-control-regex -- This parser intentionally recognizes control bytes in untrusted text.
    if (typeof file !== 'string' || !file.trim() || /[\x00-\x1f\x7f]/.test(file))
      throw new Error(`${at}.privateKeyFile must be the path of a PEM private key file`);
    const thumbprint = entry.thumbprint == null ? null : normalizeThumbprint(entry.thumbprint);
    if (entry.thumbprint != null && (typeof entry.thumbprint !== 'string' || !THUMBPRINT.test(thumbprint ?? '')))
      throw new Error(`${at}.thumbprint must be a certificate thumbprint of 40 hexadecimal digits`);
    if (thumbprint === null && ++defaults > 1)
      throw new Error(`${label}.signingKeys may have only one entry without a thumbprint`);
    if (thumbprint !== null && thumbprints.has(thumbprint))
      throw new Error(`${at}.thumbprint ${thumbprint} is listed twice`);
    if (thumbprint !== null) thumbprints.add(thumbprint);
    return { privateKeyFile: base ? path.resolve(base, file) : path.resolve(file), thumbprint };
  });
  return { signingKeys };
}
