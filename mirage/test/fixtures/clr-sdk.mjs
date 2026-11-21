// Original-DLL fixtures need the .NET Framework compiler and the verified public Microsoft.Xrm.Sdk.dll. .NET Framework
// exists only on Windows, so these tests skip elsewhere; on Windows a missing SDK fixture fails instead of skipping.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { compileCached, compileCacheKey, compilerIdentity, fileDigest } from '../../lib/compile-cache.mjs';

export const CLR_SKIP = process.platform !== 'win32' && 'CLR plugin hosts need the Windows .NET Framework compiler';

// The location `npm run ci:prepare -- --suite mirage --unit` restores; PAQ_TEST_XRM_SDK overrides it.
const PREPARED_SDK = fileURLToPath(
  new URL('../../../.paqvilo/ci/sdk-reference/reference/lib/net462/Microsoft.Xrm.Sdk.dll', import.meta.url),
);

export function clrSdk() {
  const sdk = path.resolve(process.env.PAQ_TEST_XRM_SDK || PREPARED_SDK);
  if (!fs.existsSync(sdk))
    throw new Error(
      `CLR SDK fixture missing at ${sdk}; run npm run ci:prepare -- --suite mirage --unit or set PAQ_TEST_XRM_SDK.`,
    );
  return sdk;
}

const CSC = path.join(process.env.WINDIR ?? 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
// hang guard only: a blocked synchronous child cannot be ended by the test runner
const CLI_HANG_GUARD_MS = 170_000;

/** Compiles invented C# with the .NET Framework compiler; `references` are DLL paths or framework DLL names and `keyFile` an
 * optional strong-name key (strongNameKey). The output is taken from the toolkit's compile cache when the same source,
 * references, options and compiler built it before (lib/compile-cache.mjs); `run` and `cache` replace the compiler
 * start and the cache folder. */
export function compileClr(source, out, { target = 'library', references = [], keyFile, run = spawnSync, cache } = {}) {
  const name = path.basename(out);
  // A reference is a file (keyed by its bytes) or the name of a framework assembly the compiler resolves itself.
  const referenceKey = (reference) =>
    fs.existsSync(reference) ? path.basename(reference) + '=' + fileDigest(reference) : reference;
  // A generated strong-name key is new per run, so its output is never asked for again: such a build skips the cache.
  const cacheRoot = keyFile ? false : cache;
  compileCached({
    ...(cacheRoot === undefined ? {} : { root: cacheRoot }),
    key: compileCacheKey([
      'clr-fixture/1',
      compilerIdentity(CSC),
      target,
      // The assembly's identity is its output file name.
      name,
      fs.readFileSync(source),
      keyFile ? fs.readFileSync(keyFile) : '',
      ...references.map(referenceKey),
    ]),
    files: [name],
    into: path.dirname(out),
    build(folder) {
      const build = run(
        CSC,
        [
          '/nologo',
          '/target:' + target,
          '/out:' + path.join(folder, name),
          ...(keyFile ? ['/keyfile:' + keyFile] : []),
          ...references.map((reference) => '/reference:' + reference),
          source,
        ],
        { shell: false, windowsHide: true, encoding: 'utf8', timeout: CLI_HANG_GUARD_MS },
      );
      if (build.status !== 0)
        throw new Error('C# fixture build failed: ' + (build.error?.message ?? build.stdout + build.stderr));
    },
  });
  return out;
}

/** Writes a fresh RSA strong-name key pair (a CryptoAPI PRIVATEKEYBLOB, the .snk format csc /keyfile reads) to `file`, so
 * an invented fixture assembly can be strong-name signed as plug-in registration requires. */
export function strongNameKey(file) {
  const bits = 1024,
    { privateKey } = generateKeyPairSync('rsa', { modulusLength: bits }),
    jwk = privateKey.export({ format: 'jwk' });
  const little = (value, size) => {
    const big = Buffer.from(value, 'base64url'),
      padded = Buffer.concat([Buffer.alloc(Math.max(0, size - big.length)), big]);
    return Buffer.from(padded).reverse();
  };
  const header = Buffer.alloc(20);
  header.writeUInt8(0x07, 0); // PRIVATEKEYBLOB
  header.writeUInt8(0x02, 1);
  header.writeUInt32LE(0x2400, 4); // CALG_RSA_SIGN
  header.writeUInt32LE(0x32415352, 8); // 'RSA2'
  header.writeUInt32LE(bits, 12);
  header.writeUInt32LE(Buffer.from(jwk.e, 'base64url').readUIntBE(0, Buffer.from(jwk.e, 'base64url').length), 16);
  const half = bits / 16;
  fs.writeFileSync(
    file,
    Buffer.concat([
      header,
      little(jwk.n, bits / 8),
      little(jwk.p, half),
      little(jwk.q, half),
      little(jwk.dp, half),
      little(jwk.dq, half),
      little(jwk.qi, half),
      little(jwk.d, bits / 8),
    ]),
  );
  return file;
}

/** One prepared host serves another type or profile from the same assembly; prepareClrRuntime is covered separately. */
export const retypeClrRuntime = (runtime, overrides) => ({
  ...runtime,
  descriptor: { ...runtime.descriptor, ...overrides },
  provenance: { ...runtime.provenance, typeName: overrides.typeName ?? runtime.provenance.typeName },
});
