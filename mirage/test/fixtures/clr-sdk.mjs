// Original-DLL fixtures need the .NET Framework compiler and the verified public Microsoft.Xrm.Sdk.dll. .NET Framework
// exists only on Windows, so these tests skip elsewhere; on Windows a missing SDK fixture fails instead of skipping.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
// The same compile limit prepareClrRuntime gives its host build.
const COMPILE_LIMIT_MS = 20_000;

/** Compiles invented C# with the .NET Framework compiler; `references` are DLL paths or framework DLL names. */
export function compileClr(source, out, { target = 'library', references = [] } = {}) {
  const build = spawnSync(
    CSC,
    ['/nologo', '/target:' + target, '/out:' + out, ...references.map((name) => '/reference:' + name), source],
    { shell: false, windowsHide: true, encoding: 'utf8', timeout: COMPILE_LIMIT_MS },
  );
  if (build.status !== 0) throw new Error('C# fixture build failed: ' + (build.error?.message ?? build.stdout + build.stderr));
  return out;
}

/** One prepared host serves another type or profile from the same assembly; prepareClrRuntime is covered separately. */
export const retypeClrRuntime = (runtime, overrides) => ({
  ...runtime,
  descriptor: { ...runtime.descriptor, ...overrides },
  provenance: { ...runtime.provenance, typeName: overrides.typeName ?? runtime.provenance.typeName },
});
