// Original-DLL fixtures need a plug-in host toolchain (the Windows .NET Framework compiler, or a .NET 10+ SDK on macOS and
// Linux) and the verified public Microsoft.Xrm.Sdk.dll. Without a toolchain these tests skip. On Windows, where CI prepares
// the SDK fixture, a missing one fails instead of skipping; on macOS and Linux they also skip until it is prepared (npm
// run ci:prepare -- --suite mirage --unit) or named by PAQ_TEST_XRM_SDK.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { compileCached, compileCacheKey, compilerIdentity, fileDigest } from '../../lib/compile-cache.mjs';
import { clrHostCommand, clrToolchain, removeClrHostLeftovers } from '../../lib/clr-toolchain.mjs';
import {
  dotnetBuildInputs,
  dotnetCompile,
  writeDotnetRuntimeConfig,
} from '../../lib/clr-dotnet.mjs';

// The location `npm run ci:prepare -- --suite mirage --unit` restores; PAQ_TEST_XRM_SDK overrides it.
const PREPARED_SDK = fileURLToPath(
  new URL('../../../.paqvilo/ci/sdk-reference/reference/lib/net462/Microsoft.Xrm.Sdk.dll', import.meta.url),
);

const TOOLCHAIN = clrToolchain();
const DOTNET = TOOLCHAIN?.kind === 'dotnet';
const sdkPrepared = () => fs.existsSync(path.resolve(process.env.PAQ_TEST_XRM_SDK || PREPARED_SDK));
// Parity tests whose oracle is a .NET Framework program they compile with the Windows compiler or start directly: their
// recorded expectations are .NET Framework runs, so they stay on Windows. Each test file runs in its own process, so the
// started file names the test that imported this fixture; every other CLR test also runs on the .NET host.
const NETFX_ORACLE_TESTS = new Set([
  'dataverse-soap-sdk-values.test.mjs',
  'plugin-query-paging.test.mjs',
  'webhook-message-values.test.mjs',
  'webhook-sdk-values.test.mjs',
]);
const netfxOracle = NETFX_ORACLE_TESTS.has(path.basename(process.argv[1] ?? ''));
export const CLR_SKIP =
  (!TOOLCHAIN && 'CLR plugin hosts need the .NET Framework compiler (Windows) or a .NET 10+ SDK') ||
  (process.platform !== 'win32' && netfxOracle && 'this parity test runs .NET Framework oracle programs, on Windows') ||
  (process.platform !== 'win32' &&
    !sdkPrepared() &&
    'CLR plugin hosts on macOS and Linux need the prepared SDK fixture');

// .NET (macOS, Linux): the reference assemblies, package assemblies and C# compiler of the installed SDK, resolved once.
let inputs;
const dotnetInputs = () => (inputs ??= dotnetBuildInputs(TOOLCHAIN));
// A framework assembly named without a path (System.ServiceModel.dll) is a .NET Framework reference: under .NET the
// resolved reference set already holds it (or its facade), so only file references are passed on.
const fileReference = (reference) => path.isAbsolute(reference) && fs.existsSync(reference);

/** Under .NET a fixture executable runs through dotnet: its runtime configuration and the package assemblies it may bind
 * (the WCF client) are placed beside it once. */
function prepareExecutable(executable) {
  if (!DOTNET) return;
  const folder = path.dirname(executable),
    config = path.join(folder, path.basename(executable, path.extname(executable)) + '.runtimeconfig.json');
  if (!fs.existsSync(config)) writeDotnetRuntimeConfig(executable);
  for (const file of dotnetInputs().runtime) {
    const beside = path.join(folder, path.basename(file));
    if (!fs.existsSync(beside)) fs.copyFileSync(file, beside);
  }
}

/**
 * The files a hand-built runtime lists beside its stand-in host `executable` (before the host itself): under .NET its
 * runtime configuration and package assemblies, which Mirage copies into each execution snapshot; none on Windows.
 */
export function toolchainPaths(executable) {
  if (!DOTNET) return [];
  prepareExecutable(executable);
  const folder = path.dirname(executable);
  return [
    path.join(folder, path.basename(executable, path.extname(executable)) + '.runtimeconfig.json'),
    ...dotnetInputs().runtime.map((file) => path.join(folder, path.basename(file))),
  ];
}

/** The command and arguments that start a compiled fixture executable: itself on Windows, through dotnet under .NET. */
export function hostCommand(executable, args = []) {
  prepareExecutable(executable);
  return clrHostCommand(TOOLCHAIN?.launcher ?? null, executable, args);
}

/** Removes what the .NET runtime of a fixture process `child` that a test ended left in the temporary folder. */
export function removeHostLeftovers(child) {
  removeClrHostLeftovers(TOOLCHAIN?.launcher ?? null, child.pid);
}

export function clrSdk() {
  const sdk = path.resolve(process.env.PAQ_TEST_XRM_SDK || PREPARED_SDK);
  if (!fs.existsSync(sdk))
    throw new Error(
      `CLR SDK fixture missing at ${sdk}; run npm run ci:prepare -- --suite mirage --unit or set PAQ_TEST_XRM_SDK.`,
    );
  return sdk;
}

const CSC = TOOLCHAIN?.compiler ?? 'csc';
// hang guard only: a blocked synchronous child cannot be ended by the test runner
const CLI_HANG_GUARD_MS = 170_000;

/** Compiles invented C# with the host toolchain's compiler (the .NET Framework compiler, or the SDK's csc under .NET); `references` are DLL paths or framework DLL names and `keyFile` an
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
      DOTNET ? 'dotnet:' + TOOLCHAIN.sdkVersion + ':' + compilerIdentity(dotnetInputs().csc) : compilerIdentity(CSC),
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
      const build = DOTNET
        ? dotnetCompile(TOOLCHAIN, dotnetInputs(), {
            out: path.join(folder, name),
            target,
            sources: [...(keyFile ? ['/keyfile:' + keyFile] : []), source],
            references: references.filter(fileReference),
            defines: ['PAQVILO_CORECLR'],
            run,
            timeout: CLI_HANG_GUARD_MS,
          })
        : run(
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
  // An executable fixture may be started by Mirage itself (a stand-in host), not only through hostCommand.
  if (target === 'exe') prepareExecutable(out);
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
