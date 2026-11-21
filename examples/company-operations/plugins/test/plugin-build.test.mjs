// @test-kind tooling: deployed plug-in projects build the same bytes at every commit, so deployment plans see code changes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const registry = JSON.parse(await fs.readFile(new URL('../registrations.json', import.meta.url), 'utf8'));

// The .NET SDK otherwise stamps the commit into the informational version and the PDB identity the DLL names.
const REPRODUCIBLE = {
  Deterministic: 'true',
  IncludeSourceRevisionInInformationalVersion: 'false',
  EnableSourceControlManagerQueries: 'false',
};

test('every registered plug-in assembly project keeps the commit out of its build output', async () => {
  assert.ok(registry.assemblies.length > 0);
  for (const { project } of registry.assemblies) {
    const csproj = await fs.readFile(new URL(`../${project}/${project}.csproj`, import.meta.url), 'utf8');
    for (const [property, value] of Object.entries(REPRODUCIBLE))
      assert.match(csproj, new RegExp(`<${property}>${value}</${property}>`), `${project}: ${property}`);
  }
});

test('every registered plug-in assembly project keeps the build folder out of its build output', async () => {
  // The projects also compile ../Shared, so the mapping covers the plug-in folder, not only the project folder.
  for (const { project } of registry.assemblies) {
    const csproj = await fs.readFile(new URL(`../${project}/${project}.csproj`, import.meta.url), 'utf8');
    assert.ok(
      csproj.includes("<PathMap>$([System.IO.Path]::GetFullPath('$(MSBuildProjectDirectory)/..'))=/_/</PathMap>"),
      `${project}: PathMap`,
    );
  }
});
