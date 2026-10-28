import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { planSdkProjectionProbes } from '../sdk-projection-probes.mjs';
import { makeTemporaryDirectory } from 'paqvilo/mirage/testing/owned-fixture.mjs';
const equipmentId = '10000000-0000-0000-0000-000000000001',
  canaryRunId = '10000000-0000-0000-0000-000000000002',
  markerUtc = 'CO-UTC:2026-10-13T00:00:00.000Z';
test('pure SDK controls independently cover column constructors, authored Fetch flags and caller total-count controls', () => {
  const plan = planSdkProjectionProbes({ equipmentId, canaryRunId, markerUtc });
  assert.equal(plan.probes.length, 21);
  assert.equal(new Set(plan.probes.map((row) => row.operationId)).size, 21);
  assert.equal(plan.requiresPreparedIntents, true);
  for (const kind of ['QueryExpression', 'Retrieve', 'FetchExpression'])
    for (const columnMode of ['empty', 'name', 'pk', 'all'])
      assert.equal(
        plan.probes.filter(
          (row) =>
            row.id ===
            (kind === 'QueryExpression' ? 'QE' : kind === 'Retrieve' ? 'Retrieve' : 'Fetch') + '-' + columnMode,
        ).length,
        1,
      );
  for (const kind of ['QueryExpression', 'FetchExpression'])
    assert.deepEqual(
      plan.probes.filter((row) => row.kind === kind && row.countFixture).map((row) => row.totalCount),
      [null, false, true],
    );
  assert.deepEqual(
    plan.probes.filter((row) => row.distinct !== undefined).map((row) => row.distinct),
    [false, true],
  );
  assert.equal(plan.probes.filter((row) => row.minActiveRowVersion).length, 1);
  assert.ok(plan.probes.every((row) => row.equipmentId === equipmentId && row.canaryRunId === canaryRunId));
  for (const invalid of [{ equipmentId: 'x' }, { canaryRunId: 'x' }, { markerUtc: 'x' }])
    assert.throws(
      () => planSdkProjectionProbes({ equipmentId, canaryRunId, markerUtc, ...invalid }),
      /exact owned Equipment\/Run IDs/,
    );
  assert.throws(
    () => planSdkProjectionProbes({ equipmentId, canaryRunId, markerUtc, operationId: () => equipmentId }),
    /unique immutable operation/,
  );
});

// The driver targets .NET Framework 4.6.2 and the probe is compiled with the Framework csc.exe, so it runs only on the
// Windows lane. ci:prepare compiles it once there; the test uses that build and refuses one older than its sources.
const sdkProbesBuild = fileURLToPath(new URL('../SdkProbes/bin/Release/net462/', import.meta.url));
const driverSources = ['../SdkProjectionDriver.cs', '../Shared/Lab.cs', '../SdkProbes/SdkProbes.csproj'];
// Hang guards only: the Framework compiler and the probe each finish in about a second.
const compileBound = 60000,
  probeBound = 30000;

test(
  'actual compiled SDK driver selects TLS 1.2 before reading invalid local input',
  { skip: process.platform !== 'win32' && 'needs the .NET Framework 4.6.2 runtime and csc.exe (Windows lane)' },
  async () => {
    const driver = path.join(sdkProbesBuild, 'SdkProbes.exe');
    const built = await fs.stat(driver).catch(() => null);
    assert.ok(built, 'SdkProbes.exe is not built; run npm run ci:prepare -- --suite examples --unit');
    for (const source of driverSources) {
      const changed = (await fs.stat(fileURLToPath(new URL(source, import.meta.url)))).mtimeMs;
      assert.ok(changed <= built.mtimeMs, source + ' changed after the SdkProbes build; rerun ci:prepare');
    }
    const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paq-sdk-transport-'));
    try {
      // The probe loads the driver and its SDK assemblies from its own application directory.
      await fs.cp(sdkProbesBuild, directory, { recursive: true });
      const source = path.join(directory, 'TransportTest.cs'),
        testExe = path.join(directory, 'TransportTest.exe');
      await fs.writeFile(
        source,
        'using System;using System.IO;using System.Net;public static class TransportTest{public static int Main(){ServicePointManager.SecurityProtocol=SecurityProtocolType.Tls;Console.SetIn(new StringReader("{invalid\\n"));Console.SetOut(new StringWriter());var exit=SdkProjectionDriver.Main();return exit==2&&ServicePointManager.SecurityProtocol==SecurityProtocolType.Tls12?0:1;}}',
      );
      const compile = spawnSync(
        path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
        ['/nologo', '/target:exe', '/out:' + testExe, '/reference:' + path.join(directory, 'SdkProbes.exe'), source],
        { windowsHide: true, encoding: 'utf8', timeout: compileBound },
      );
      const report = (run) => [run.error?.message, run.stdout, run.stderr].filter(Boolean).join('\n');
      assert.equal(compile.status, 0, report(compile));
      const result = spawnSync(testExe, [], { windowsHide: true, encoding: 'utf8', timeout: probeBound });
      assert.equal(result.status, 0, report(result));
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);
