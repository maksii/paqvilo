// @test-kind contract: App diagnostics inspect invented bounded source entries without compiling, executing, or accessing a host.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDirSync } from './fixture.mjs';
import { analyzeApps, appRules } from '../lense/analysis/app-rules.mjs';
import { analyzeProject } from '../lense/analysis/index.mjs';
import { canvasTopLevelKeys } from '../lense/analysis/app-canvas.mjs';
import { readCanvasSource } from '../mirage/lib/canvas-source.mjs';
import { CANVAS_APP_FILES, msappOf } from '../mirage/test/canvas-runtime-fixture.mjs';

const source = (file, text, rootId = 'invented') => ({ file, relativeFile: file, text, rootId });
const json = (file, value, rootId) => source(file, JSON.stringify(value), rootId);
function analyze(entries) {
  const findings = [];
  const coverage = analyzeApps(entries, (ruleId, entry, field, offset) => {
    const rule = appRules.find((candidate) => candidate.id === ruleId);
    assert.ok(rule, `registered rule ${ruleId}`);
    findings.push({ ...rule, file: entry.file, field, offset });
  });
  return { findings, ...coverage };
}
const ids = (result) => result.findings.map((finding) => finding.id);
const has = (result, id) => ids(result).includes(id);
const severity = (result, value) => result.findings.filter((finding) => finding.severity === value);
const domain = (result, name) => result.domains.find((entry) => entry.domain === name);
const control = (children = '<resources><code path="index.ts"/></resources>', attrs = '') =>
  `<manifest><control namespace="Invented" constructor="Widget" version="1.0.0" display-name-key="WidgetName" ${attrs}>${children}</control></manifest>`;
const pcf = (text = control()) => analyze([source('ControlManifest.Input.xml', text)]);

test('app rules have distinct identities, fixed guidance and supported severities', () => {
  assert.equal(new Set(appRules.map((rule) => rule.id)).size, appRules.length);
  for (const rule of appRules) {
    assert.ok(['error', 'warning', 'hint'].includes(rule.severity));
    assert.ok(rule.message && rule.remediation && rule.references.length > 0);
  }
});
test('PCF accepts a minimal standard control without the optional description-key', () => {
  assert.deepEqual(ids(pcf()), []);
  assert.equal(domain(pcf(), 'pcf').recognized, true);
  assert.equal(domain(pcf(), 'pcf').complete, true);
});
test('PCF identities and control-type are checked without inferring a host', () => {
  for (const attr of ['namespace', 'constructor', 'version', 'display-name-key']) {
    assert.ok(has(pcf(control().replace(new RegExp(` ${attr}="[^"]*"`), '')), 'APP-PCF-002'));
  }
  assert.ok(has(pcf(control(undefined, 'control-type="other"')), 'APP-PCF-002'));
});
test('PCF code resource cardinality is a manifest contract', () => {
  for (const content of [
    '',
    '<resources/>',
    '<resources><code path=""/></resources>',
    '<resources><code path="a"/><code path="b"/></resources>',
  ]) {
    assert.ok(has(pcf(control(content)), 'APP-PCF-003'));
  }
});
test('PCF duplicate declarations are scoped to their owner', () => {
  const resource = '<resources><code path="index.ts"/></resources>';
  for (const content of [
    '<property name="x" usage="input" of-type="SingleLine.Text"/><property name="x" usage="input" of-type="SingleLine.Text"/>',
    '<type-group name="g"><type>Decimal</type></type-group><type-group name="g"><type>Decimal</type></type-group>',
    '<feature-usage><uses-feature name="WebAPI" required="true"/><uses-feature name="WebAPI"/></feature-usage>',
    '<data-set name="rows"/><data-set name="rows"/>',
    '<data-set name="rows"><property-set name="x" usage="input" of-type="Decimal"/><property-set name="x" usage="input" of-type="Decimal"/></data-set>',
  ])
    assert.ok(has(pcf(control(resource + content)), 'APP-PCF-004'));
  const separate =
    '<data-set name="one"><property-set name="x" usage="input" of-type="Decimal"/></data-set><data-set name="two"><property-set name="x" usage="input" of-type="Decimal"/></data-set>';
  assert.equal(has(pcf(control(resource + separate)), 'APP-PCF-004'), false);
});
test('PCF local property type contracts and referenced groups are validated', () => {
  const resource = '<resources><code path="index.ts"/></resources>';
  const invalid = [
    '<property usage="input" of-type="Decimal"/>',
    '<property name="x" usage="other" of-type="Decimal"/>',
    '<property name="x" usage="input" of-type-group="missing"/>',
    '<property name="x" usage="input" of-type="Decimal" of-type-group="g"/>',
    '<property name="x" usage="input" of-type="Object"/>',
  ];
  for (const property of invalid) assert.ok(has(pcf(control(resource + property)), 'APP-PCF-005'));
  const valid =
    '<type-group name="g"><type>Decimal</type></type-group><property name="x" usage="input" of-type-group="g"/><property name="o" usage="output" of-type="Object"/>';
  assert.equal(has(pcf(control(resource + valid)), 'APP-PCF-005'), false);
  assert.ok(has(pcf(control(resource + '<property name="canvasProperty"/>')), 'APP-PCF-006'));
  assert.equal(severity(pcf(control(resource + '<property name="canvasProperty"/>')), 'error').length, 0);
});
test('virtual PCF and licensing checks preserve valid model/Canvas host uncertainty', () => {
  assert.ok(has(pcf(control(undefined, 'control-type="virtual"')), 'APP-PCF-007'));
  const virtual = pcf(
    control(
      '<resources><code path="index.ts"/><platform-library name="React" version="16.14.0"/></resources>',
      'control-type="virtual"',
    ),
  );
  assert.equal(has(virtual, 'APP-PCF-007'), false);
  assert.ok(has(virtual, 'APP-PCF-008'));
  assert.equal(severity(virtual, 'error').length, 0);
  assert.ok(
    has(
      pcf(
        control(
          '<resources><code path="index.ts"/></resources><external-service-usage enabled="true"><domain>example.invalid</domain></external-service-usage>',
        ),
      ),
      'APP-PCF-009',
    ),
  );
  assert.equal(
    has(
      pcf(control('<resources><code path="index.ts"/></resources><external-service-usage enabled="false"/>')),
      'APP-PCF-009',
    ),
    false,
  );
});
test('PCF documented unsupported types and bound defaults retain contextual severity', () => {
  const resource = '<resources><code path="index.ts"/></resources>';
  const unsupported = pcf(control(resource + '<property name="owner" usage="bound" of-type="Lookup.Owner"/>'));
  assert.ok(has(unsupported, 'APP-PCF-011'));
  assert.equal(severity(unsupported, 'error').length, 0);
  const future = pcf(control(resource + '<property name="future" usage="input" of-type="Future.Type"/>'));
  assert.equal(has(future, 'APP-PCF-011'), false);
  const bound = pcf(control(resource + '<property name="x" usage="bound" of-type="Decimal" default-value="0"/>'));
  assert.ok(has(bound, 'APP-PCF-012'));
  assert.equal(severity(bound, 'error').length, 0);
});
test('PCF project development-mode warning respects conditional and overriding declarations', () => {
  const run = (text) => analyze([source('Widget.pcfproj', text)]);
  assert.ok(
    has(
      run('<Project><PropertyGroup><PcfBuildMode>development</PcfBuildMode></PropertyGroup></Project>'),
      'APP-PCF-010',
    ),
  );
  for (const text of [
    '<Project><PropertyGroup Condition="debug"><PcfBuildMode>development</PcfBuildMode></PropertyGroup></Project>',
    '<Project><PropertyGroup><PcfBuildMode>production</PcfBuildMode></PropertyGroup></Project>',
    '<Project><PropertyGroup><PcfBuildMode>development</PcfBuildMode></PropertyGroup><PropertyGroup Condition="release"><PcfBuildMode>production</PcfBuildMode></PropertyGroup></Project>',
  ])
    assert.equal(has(run(text), 'APP-PCF-010'), false);
});
// @test-kind security: Untrusted manifest declarations and parser errors must not resolve external entities or expose source text.
test('PCF invalid XML and hostile declarations fail without source excerpts', () => {
  const secret = 'PRIVATE-NEVER-ECHO';
  for (const text of [
    control().slice(0, -4),
    '<manifest><control/><control/></manifest>',
    `<!DOCTYPE manifest SYSTEM "https://${secret}.invalid/"><manifest/>`,
    `<manifest><control name="${secret}" name="duplicate"/></manifest>`,
  ]) {
    const result = pcf(text);
    assert.ok(has(result, 'APP-PCF-001'));
    assert.equal(domain(result, 'pcf').complete, false);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

const canvas = (text, name = 'App.pa.yaml') => analyze([source(name, text)]);
test('Canvas PA-YAML properties require formula strings, while creation metadata stays metadata', () => {
  for (const value of ['42', 'false', '"caption"', '{ field: value }']) {
    assert.ok(has(canvas(`App:\n  Properties:\n    OnStart: ${value}\n`), 'APP-CANVAS-002'));
  }
  assert.deepEqual(
    ids(
      canvas('App:\n  Properties:\n    StartScreen: =Home\n    Formulas: |-\n      =Named = 42;\n  IsLocked: false\n'),
    ),
    [],
  );
});
test('Canvas syntax and duplicate keys are distinct from unresolved schema structure', () => {
  for (const text of ['App:\n  Properties: [', 'App:\n  Properties:\n    OnStart: =1\n    OnStart: =2\n', '[]']) {
    assert.ok(has(canvas(text), 'APP-CANVAS-001'));
    assert.equal(domain(canvas(text), 'canvas').complete, false);
  }
  const unknown = canvas('FutureCanvasObject: {}');
  assert.ok(has(unknown, 'APP-CANVAS-008'));
  assert.equal(domain(unknown, 'canvas').complete, false);
  assert.ok(has(canvas('Legacy As screen:\n  Width: =100', 'Legacy.fx.yaml'), 'APP-CANVAS-004'));
  assert.equal(domain(canvas('Legacy As screen:\n  Width: =100', 'Legacy.fx.yaml'), 'canvas').complete, false);
});
function componentYaml(body) {
  return `Screens:\n  Home:\n    Children:\n      - Custom:\n          ${body.replaceAll('\n', '\n          ')}\n`;
}
test('Canvas component creation checks use the explicit component kind', () => {
  for (const body of [
    'Control: CanvasComponent',
    'Control: CodeComponent\nComponentName: sample\nComponentLibraryUniqueName: library',
    'Control: CanvasComponent\nComponentName: sample\nVariant: x',
    'Control: CodeComponent\nComponentName: sample\nLayout: x',
  ]) {
    assert.ok(has(canvas(componentYaml(body), 'Home.pa.yaml'), 'APP-CANVAS-003'));
  }
  assert.deepEqual(
    ids(
      canvas(
        componentYaml('Control: CanvasComponent\nComponentName: sample\nComponentLibraryUniqueName: library'),
        'Home.pa.yaml',
      ),
    ),
    [],
  );
});
test('Canvas inspection does not confuse property names with nested Properties blocks', () => {
  const text = componentYaml(
    'Control: CodeComponent\nComponentName: invented\nProperties:\n  Properties: ="value"\n  Control: ="value"',
  );
  assert.equal(has(canvas(text, 'Home.pa.yaml'), 'APP-CANVAS-002'), false);
});
test('Canvas startup guidance belongs to App.OnStart, not a screen named App', () => {
  const app = canvas('App:\n  Properties:\n    OnStart: =Navigate(Home); ClearCollect(localRows, [1, 2])');
  assert.ok(has(app, 'APP-CANVAS-005'));
  assert.ok(has(app, 'APP-CANVAS-006'));
  const screen = canvas(
    'Screens:\n  App:\n    Properties:\n      OnVisible: =Navigate(Home); ClearCollect(localRows, [1, 2])',
    'Home.pa.yaml',
  );
  assert.equal(has(screen, 'APP-CANVAS-005'), false);
  assert.equal(has(screen, 'APP-CANVAS-006'), false);
});
test('Canvas iteration guidance never claims source patterns prove network calls', () => {
  for (const formula of [
    'ForAll(localRows, Patch(localCache, ThisRecord))',
    'ForAll(localRows, ForAll(localRows, 1))',
  ]) {
    const result = canvas(`App:\n  Properties:\n    OnStart: =${formula}`);
    assert.ok(has(result, 'APP-CANVAS-007'));
    assert.equal(result.findings.find((finding) => finding.id === 'APP-CANVAS-007').severity, 'hint');
  }
  assert.equal(has(canvas('App:\n  Properties:\n    OnStart: =Patch(localCache, {Id: 1})'), 'APP-CANVAS-007'), false);
});
test('Canvas literal formula scanner skips comments, text and namespaced functions', () => {
  const cases = [
    'Notify("Navigate(Home); ForAll(x, Patch(y))")',
    'Custom.Navigate(Home); Other.ClearCollect(x, y)',
    'Custom./* comment */Navigate(Home); Other. // comment\n      ClearCollect(x, y)',
    '$"Text {If(true, "Navigate(Home)", "ForAll(x, Patch(y))")}"',
    '/* Navigate(Home); ForAll(x, Patch(y)) */ 1',
    '// Navigate(Home)\n      1',
  ];
  for (const formula of cases) {
    const result = canvas(`App:\n  Properties:\n    OnStart: |-\n      =${formula}`);
    assert.equal(has(result, 'APP-CANVAS-005'), false);
    assert.equal(has(result, 'APP-CANVAS-006'), false);
    assert.equal(has(result, 'APP-CANVAS-007'), false);
  }
});
test('Canvas accessible-name guidance is a hint and preserves native default uncertainty', () => {
  const missing = canvas(
    componentYaml('Control: Classic/Button@2.2.0\nProperties:\n  Text: ="Continue"'),
    'Home.pa.yaml',
  );
  assert.ok(has(missing, 'APP-CANVAS-009'));
  assert.equal(severity(missing, 'error').length, 0);
  const named = canvas(
    componentYaml('Control: Classic/Button@2.2.0\nProperties:\n  AccessibleLabel: ="Continue"'),
    'Home.pa.yaml',
  );
  assert.equal(has(named, 'APP-CANVAS-009'), false);
});
// @test-kind security: YAML aliases are inspected without expanding attacker-controlled references.
test('Canvas aliases remain an explicit incomplete analysis boundary', () => {
  const result = canvas('App:\n  Properties: &x\n    OnStart: =1\n  Other: *x\n');
  assert.ok(has(result, 'APP-CANVAS-008'));
  assert.equal(domain(result, 'canvas').complete, false);
});
test('Canvas runtime fixture sources analyse without the unknown top-level key finding', () => {
  for (const [file, text] of Object.entries(CANVAS_APP_FILES)) {
    assert.equal(has(canvas(text, file), 'APP-CANVAS-008'), false, file);
  }
  const mixed = canvas('App:\n  Properties: {}\nDataSources: {}\nFutureCanvasObject: {}\n');
  assert.ok(has(mixed, 'APP-CANVAS-008'));
  assert.equal(domain(mixed, 'canvas').complete, false);
});
const canvasKeyProbes = [
  ...canvasTopLevelKeys,
  'Theme',
  'Libraries',
  'Permissions',
  'Connections',
  'Formulas',
  'CanvasManifest',
  'Properties',
  'FutureCanvasObject',
];
const canvasKeyDocument = (key) => `App:\n  Properties: {}\n${key === 'App' ? '' : `${key}: {}\n`}`;
async function runtimeAcceptsTopLevel(key) {
  const { diagnostics } = await readCanvasSource({
    msapp: msappOf({ 'Src/App.pa.yaml': canvasKeyDocument(key) }),
    name: 'fx_keyprobe',
  });
  return !diagnostics.some((diagnostic) => diagnostic.code === 'CANVAS_SOURCE_SCHEMA_UNKNOWN');
}
test('Canvas analyzer top-level keys match the keys the local runtime accepts', async () => {
  for (const key of canvasKeyProbes) {
    const analyzerAccepts = !has(canvas(canvasKeyDocument(key)), 'APP-CANVAS-008');
    assert.equal(analyzerAccepts, await runtimeAcceptsTopLevel(key), key);
  }
});

const packageValue = () => ({
  dependencies: { '@microsoft/power-apps': '1.0.0' },
  devDependencies: { '@microsoft/power-apps-cli': '1.3.0' },
  scripts: { build: 'vite build' },
});
function codeFiles({
  pkg = packageValue(),
  config = { environmentId: 'invented-environment' },
  lock = true,
  typescript,
  rootId = 'invented',
  prefix = '',
} = {}) {
  const files = [json(`${prefix}power.config.json`, config, rootId), json(`${prefix}package.json`, pkg, rootId)];
  if (lock)
    files.push(
      json(
        `${prefix}package-lock.json`,
        {
          lockfileVersion: 3,
          packages: {
            '': {
              dependencies: pkg.dependencies,
              devDependencies: pkg.devDependencies,
              optionalDependencies: pkg.optionalDependencies,
            },
          },
        },
        rootId,
      ),
    );
  if (typescript) files.push(json(`${prefix}tsconfig.json`, typescript, rootId));
  return files;
}
test('a structurally consistent Code Apps project has no inferred runtime failures', () => {
  const result = analyze(codeFiles({ typescript: { compilerOptions: { strict: true } } }));
  assert.deepEqual(ids(result), []);
  assert.equal(domain(result, 'code-apps').recognized, true);
  assert.ok(domain(result, 'code-apps').limitations.includes('live-connector-identity-and-permissions'));
});
test('Code Apps configuration type errors and connector reference shapes are explicit', () => {
  for (const config of [[], { appId: 42 }, { appSettings: [] }])
    assert.ok(has(analyze(codeFiles({ config })), 'APP-CODE-001'));
  for (const config of [
    { connectionReferences: [] },
    { connectionReferences: { x: { dataSources: [42] } } },
    { databaseReferences: { x: { dataSources: { t: { logicalName: 42 } } } } },
  ])
    assert.ok(has(analyze(codeFiles({ config })), 'APP-CODE-002'));
  const valid = {
    environmentId: 'invented',
    connectionReferences: { x: { apiName: 'sample', dataSources: ['sample'] } },
    databaseReferences: {
      d: { dataSources: { t: { logicalName: 'sample', entitySetName: 'samples', isHidden: false } } },
    },
  };
  assert.equal(has(analyze(codeFiles({ config: valid })), 'APP-CODE-002'), false);
});
test('uninitialized Code Apps source is advisory without contacting an environment', () => {
  assert.ok(has(analyze(codeFiles({ config: {} })), 'APP-CODE-003'));
  assert.equal(severity(analyze(codeFiles({ config: {} })), 'error').length, 0);
});
test('Code Apps SDK, build and separate CLI dependency are not interchangeable', () => {
  const pkg = { dependencies: {}, devDependencies: { '@microsoft/power-apps-cli': '1.3.0' }, scripts: {} };
  const result = analyze(codeFiles({ pkg }));
  assert.ok(has(result, 'APP-CODE-004'));
  assert.ok(has(result, 'APP-CODE-005'));
  assert.equal(has(result, 'APP-CODE-006'), false);
  assert.ok(has(analyze(codeFiles({ pkg: { ...packageValue(), devDependencies: {} } })), 'APP-CODE-006'));
  assert.ok(has(analyze([json('power.config.json', { environmentId: 'invented' })]), 'APP-CODE-004'));
});
test('app dependency and script maps reject structural type errors without resolving versions', () => {
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'scripts']) {
    const pkg = { ...packageValue(), [field]: { invented: 42 } };
    assert.ok(has(analyze(codeFiles({ pkg })), 'APP-DEPS-004'));
  }
  assert.equal(has(analyze(codeFiles()), 'APP-DEPS-004'), false);
});
test('npm SDK invocation hint distinguishes the runtime package from the deployment CLI', () => {
  const run = (build) => analyze(codeFiles({ pkg: { ...packageValue(), scripts: { build } } }));
  assert.ok(has(run('npx --no-install @microsoft/power-apps push'), 'APP-CODE-007'));
  assert.equal(has(run('npx --no-install @microsoft/power-apps-cli app push'), 'APP-CODE-007'), false);
});
test('explicit TypeScript strict=false is a hint; JSONC/extends do not produce false syntax errors', () => {
  assert.ok(has(analyze(codeFiles({ typescript: { compilerOptions: { strict: false } } })), 'APP-CODE-008'));
  const files = codeFiles();
  files.push(source('tsconfig.json', '{ // native TypeScript JSONC\n "extends":"./base.json"\n}'));
  assert.equal(has(analyze(files), 'APP-DEPS-003'), false);
});
test('app lockfile presence, npm declarations and non-npm managers remain distinct', () => {
  assert.ok(has(analyze(codeFiles({ lock: false })), 'APP-DEPS-001'));
  const files = codeFiles();
  files[2] = json('package-lock.json', {
    lockfileVersion: 3,
    packages: { '': { dependencies: { '@microsoft/power-apps': '2.0.0' } } },
  });
  assert.ok(has(analyze(files), 'APP-DEPS-002'));
  const yarn = codeFiles({ lock: false });
  yarn.push(source('yarn.lock', 'invented lock source'));
  assert.equal(has(analyze(yarn), 'APP-DEPS-001'), false);
  assert.equal(has(analyze(yarn), 'APP-DEPS-002'), false);
});
test('a Bun project whose only lockfile is bun.lockb is inventoried as pinned', (t) => {
  const packageJson = JSON.stringify({
    name: 'invented',
    dependencies: { 'pcf-scripts': '1.0.0' },
    scripts: { build: 'pcf-scripts build' },
  });
  const findingsFor = (lock) => {
    const root = tempDirSync('paq-bun-lock-');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'app'));
    fs.writeFileSync(path.join(root, 'app', 'package.json'), packageJson);
    if (lock) fs.writeFileSync(path.join(root, 'app', 'bun.lockb'), Buffer.from([0, 1, 2, 3]));
    return analyzeProject(root, { failOn: 'none' }).findings.map(({ ruleId }) => ruleId);
  };
  assert.ok(findingsFor(false).includes('APP-DEPS-001'));
  assert.equal(findingsFor(true).includes('APP-DEPS-001'), false);
});

test('npm workspace locks cover only the actual package in the same source root', () => {
  const files = codeFiles({ lock: false, prefix: 'apps/one/' });
  const pkg = packageValue();
  files.push(
    json('package-lock.json', {
      packages: { 'apps/one': { dependencies: pkg.dependencies, devDependencies: pkg.devDependencies } },
    }),
  );
  assert.equal(has(analyze(files), 'APP-DEPS-001'), false);
  assert.equal(has(analyze(files), 'APP-DEPS-002'), false);
  files[2].rootId = 'other-root';
  assert.ok(has(analyze(files), 'APP-DEPS-001'));
});
test('PCF npm tooling participates in reproducibility checks without code-app assumptions', () => {
  const result = analyze([json('package.json', { devDependencies: { 'pcf-scripts': '1.0.0' } })]);
  assert.ok(has(result, 'APP-DEPS-001'));
  assert.equal(has(result, 'APP-CODE-004'), false);
  assert.equal(domain(result, 'code-apps').recognized, false);
});
test('native Power Apps SDK consumers are not inferred to be web Code Apps', () => {
  for (const marker of ['@microsoft/power-apps-native-host', 'react-native', 'expo']) {
    const pkg = {
      dependencies: { '@microsoft/power-apps': '1.0.0', [marker]: '1.0.0' },
      scripts: { start: 'native-start' },
    };
    const result = analyze([json('package.json', pkg)]);
    assert.equal(domain(result, 'code-apps').recognized, false);
    assert.equal(
      result.findings.some((finding) => finding.id.startsWith('APP-CODE-')),
      false,
    );
    assert.ok(has(result, 'APP-DEPS-001'));
    const explicit = analyze([json('package.json', pkg), json('power.config.json', { environmentId: 'invented' })]);
    assert.equal(domain(explicit, 'code-apps').recognized, true);
    assert.ok(has(explicit, 'APP-CODE-005'));
  }
});
// @test-kind security: Root isolation and fixed diagnostics prevent another source root or a secret value changing/revealing an app verdict.
test('app configuration and package errors are redacted and cannot borrow cross-root manifests', () => {
  const secret = 'SECRET-DO-NOT-PRINT';
  const entries = [
    source('power.config.json', `{"environmentId": "${secret}", broken`, 'first'),
    json('package.json', packageValue(), 'second'),
  ];
  const result = analyze(entries);
  assert.ok(has(result, 'APP-CODE-001'));
  assert.ok(has(result, 'APP-CODE-004'));
  assert.equal(JSON.stringify(result).includes(secret), false);
  const invalidPackage = analyze([
    json('power.config.json', { environmentId: 'invented' }),
    source('package.json', secret),
  ]);
  assert.ok(has(invalidPackage, 'APP-DEPS-003'));
  assert.equal(JSON.stringify(invalidPackage).includes(secret), false);
});
test('unrelated JSON, scripts, generic npm projects and code-like text are not app evidence', () => {
  const result = analyze([
    source('notes.txt', control()),
    json('package.json', { dependencies: { react: '1.0.0' } }),
    source('example.yaml', 'App:\n  Properties:\n    OnStart: =Navigate(Home)'),
  ]);
  assert.deepEqual(ids(result), []);
  assert.ok(result.domains.every((entry) => !entry.recognized));
});
