// @test-kind tooling: the package script that compiles the SDK probe is declared and is the one the probe test names.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const packageJson = JSON.parse(await fs.readFile(new URL('../../package.json', import.meta.url), 'utf8'));
const probeTest = await fs.readFile(new URL('./sdk-projection-probes.test.mjs', import.meta.url), 'utf8');
const csproj = 'plugins/SdkProbes/SdkProbes.csproj';

test('sdk:build restores and compiles the SDK probe with the toolkit CI arguments', () => {
  assert.equal(
    packageJson.scripts['sdk:build'],
    `dotnet restore ${csproj} --locked-mode --disable-build-servers && ` +
      `dotnet build ${csproj} --no-restore --configuration Release --disable-build-servers`,
  );
});

test('every npm script the SDK probe test names is declared in this package', () => {
  const named = [...probeTest.matchAll(/npm run ([\w:-]+)/g)].map(([, name]) => name);
  assert.ok(named.includes('sdk:build'), named.join());
  assert.deepEqual(
    named.filter((name) => !Object.hasOwn(packageJson.scripts, name)),
    [],
  );
});
