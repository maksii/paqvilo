// @test-kind tooling: the demo plug-in project builds the same bytes at every commit, so baseline/plugins.mjs sees code changes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('the demo plug-in project keeps the commit out of its build output', async () => {
  const csproj = await fs.readFile(
    new URL('../components/DataversePlugins/DataversePlugins.csproj', import.meta.url),
    'utf8',
  );
  // The .NET SDK otherwise stamps the commit into the informational version and the PDB identity the DLL names.
  for (const [property, value] of Object.entries({
    Deterministic: 'true',
    IncludeSourceRevisionInInformationalVersion: 'false',
    EnableSourceControlManagerQueries: 'false',
  }))
    assert.match(csproj, new RegExp(`<${property}>${value}</${property}>`), property);
  // The DLL also names its PDB by absolute path; a fixed root keeps the bytes independent of the checkout folder.
  assert.match(csproj, /<PathMap>\$\(MSBuildProjectDirectory\)=\/_\/<\/PathMap>/, 'PathMap');
});

test('the committed plug-in assembly copies are the same build', async () => {
  const copy = (root) =>
    fs.readFile(
      new URL(
        `../${root}/PluginAssemblies/PaqviloDemoPlugins-B4700000-0000-4000-8000-370000000001/PaqviloDemoPlugins.dll`,
        import.meta.url,
      ),
    );
  const [sample, baseline] = await Promise.all([copy('solution'), copy('baseline/solution')]);
  // Rebuild once, then copy bin/Release/net462/Paqvilo.Demo.Plugins.dll into both and repack the deployment.
  assert.ok(sample.equals(baseline), 'sample and baseline solutions carry different plug-in builds');
  assert.doesNotMatch(sample.toString('latin1'), /[A-Za-z]:\\[^\0]*\.pdb/, 'the assembly names a local PDB path');
});
