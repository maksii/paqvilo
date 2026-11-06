// @test-kind contract+security: Cross-platform source selection, shared hard budgets and in-memory packages never execute project code or inspect hidden state.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDirSync } from './fixture.mjs';
import { analyzeProject, analysisRules } from '../lense/analysis/index.mjs';
import { collectAnalysisInputs } from '../lense/analysis/inventory.mjs';
import { configuredAnalysisRoots } from '../lense/analysis/project.mjs';
import { analysisCapabilities } from '../lense/analysis/capabilities.mjs';
import { writeSolutionAssetEntries } from '../mirage/lib/dataverse-solution-assets.mjs';

function fixture(t, files = {}) {
  const root = tempDirSync('paq-platform-quality-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return root;
}
const archive = (files) =>
  writeSolutionAssetEntries(
    Object.entries(files).map(([name, data]) => ({ name, data: Buffer.isBuffer(data) ? data : Buffer.from(data) })),
  );

test('the owned registry includes platform adapters and keeps every rule identity unique', () => {
  assert.equal(new Set(analysisRules.map((rule) => rule.id)).size, analysisRules.length);
  for (const prefix of ['PP-', 'DV-', 'APP-', 'FLOW-', 'CONN-', 'MCP-', 'NATIVE-', 'MOBILE-'])
    assert.ok(
      analysisRules.some((rule) => rule.id.startsWith(prefix)),
      prefix,
    );
  for (const domain of [
    'dataverse',
    'model-driven',
    'alm',
    'pcf',
    'canvas',
    'code-apps',
    'flows',
    'connectors',
    'mobile-apps',
    'mobile-extension',
    'mcp-apps',
    'governance',
    'process-intelligence',
  ])
    assert.ok(
      analysisCapabilities.some((capability) => capability.domains.includes(domain)),
      domain,
    );
  assert.ok(analysisCapabilities.every((capability) => capability.execution === 'not-performed'));
});

test('one project reports real recognized coverage across application, data and automation domains', (t) => {
  const root = fixture(t, {
    'solution/Other/Solution.xml': '<SolutionManifest><Version>1.0.0.0</Version></SolutionManifest>',
    'solution/Entities/sample/FormXml/main/sample.xml': '<form><tabs /></form>',
    'pcf/ControlManifest.Input.xml':
      '<manifest><control namespace="Example" constructor="Sample" version="1.0.0" display-name-key="Sample" control-type="standard"><resources><code path="index.ts" order="1" /></resources></control></manifest>',
    'pcf/index.ts': 'export {};',
    'canvas/Src/App.pa.yaml': 'App:\n  Properties:\n    StartScreen: =Sample\n',
    'code/power.config.json': '{"environmentId":"00000000-0000-0000-0000-000000000001"}',
    'code/package.json': JSON.stringify({
      scripts: { build: 'vite build' },
      dependencies: { '@microsoft/power-apps': '1.0.0' },
      devDependencies: { '@microsoft/power-apps-cli': '1.0.0' },
    }),
    'code/yarn.lock': '# invented lock',
    'code/src/main.ts': 'import { initialize } from "@microsoft/power-apps/app"; await initialize();',
    'flows/sample.json': JSON.stringify({
      definition: { triggers: { manual: { type: 'Request', kind: 'Http', inputs: {} } }, actions: {} },
    }),
    'connector/swagger.json': JSON.stringify({
      swagger: '2.0',
      info: { title: 'Invented', version: '1.0' },
      paths: { '/records': { get: { operationId: 'ReadRecords', responses: { 200: { description: 'OK' } } } } },
    }),
    'tools/read.tool.json': JSON.stringify({
      name: 'read',
      description: 'Read invented data',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object', properties: {} },
    }),
    'tools/read.tool.js': 'throw new Error("TOOL-IMPLEMENTATION-MUST-NOT-RUN")',
    'mobile/package.json': JSON.stringify({
      dependencies: { '@microsoft/power-apps-native-host': '1.0.0', 'react-native': '1.0.0' },
    }),
    'mobile/yarn.lock': '# invented lock',
    'extension/manifest.json': JSON.stringify({
      name: 'sample',
      version: '1.0.0',
      abi: { compatibleShells: '>=1.0.0', builtAgainst: '1.0.0' },
      entrypoints: { android: { dex: 'Sample.dex', packageClass: 'sample.SamplePackage' } },
      receivers: [{ name: 'sample', nativeModule: 'SampleModule', methods: ['read'] }],
    }),
  });
  const report = analyzeProject(root);
  for (const name of [
    'dataverse',
    'model-driven',
    'alm',
    'pcf',
    'canvas',
    'code-apps',
    'flows',
    'connectors',
    'mcp-apps',
    'mobile-apps',
    'mobile-extension',
  ]) {
    const domain = report.coverage.domains.find((item) => item.domain === name);
    assert.ok(domain.recognized > 0, name);
    assert.equal(typeof domain.recognized, 'number', name);
  }
  assert.ok(
    report.capabilities.some(
      (capability) => capability.id === 'pcf-push' && capability.applicable && capability.execution === 'not-performed',
    ),
  );
  assert.doesNotMatch(JSON.stringify(report), /TOOL-IMPLEMENTATION-MUST-NOT-RUN/);
});

test('declared project, Solution, app and Canvas roots are selected without importing data packs', (t) => {
  const root = fixture(t, {
    'project.json': JSON.stringify({
      version: 2,
      solutions: [{ path: 'solution' }],
      codeApps: [{ name: 'invented', dir: 'code' }],
      canvas: { sources: ['canvas.msapp'] },
      dataPacks: [{ module: './throw.mjs' }],
    }),
    'throw.mjs': 'throw new Error("PROJECT-CODE-MUST-NOT-RUN")',
  });
  const roots = configuredAnalysisRoots({
    configDir: root,
    sourceDir: path.join(root, 'portal'),
    mirageConfig: { project: path.join(root, 'project.json') },
  });
  assert.deepEqual(
    roots.map((entry) => entry.kind),
    ['portal', 'project', 'solution', 'code-app', 'canvas'],
  );
  assert.deepEqual(
    roots.map((entry) => entry.path),
    ['portal', 'project.json', 'solution', 'code', 'canvas.msapp'].map((name) => path.join(root, name)),
  );
});

test('source roots share byte and directory budgets and disclose every uninspected root', (t) => {
  const root = fixture(t, { 'first/a.html': 'aa', 'second/b.html': 'bb' });
  const roots = ['first', 'second'].map((id) => ({ id, path: path.join(root, id) }));
  const bytes = collectAnalysisInputs(roots, { totalBytes: 3 });
  assert.equal(bytes.complete, false);
  assert.equal(bytes.stats.bytes, 2);
  assert.deepEqual(bytes.skipped, [{ file: 'second/b.html', reason: 'total-size-limit' }]);
  const directories = collectAnalysisInputs(roots, { directories: 1 });
  assert.equal(directories.complete, false);
  assert.ok(directories.skipped.some((entry) => entry.reason === 'directory-limit'));
  const limited = collectAnalysisInputs(roots, { roots: 1 });
  assert.equal(limited.complete, false);
  assert.ok(limited.skipped.some((entry) => entry.reason === 'root-count-limit'));
  assert.throws(
    () =>
      collectAnalysisInputs([
        { id: 'same', path: root },
        { id: 'same', path: root },
      ]),
    /unique/,
  );
});

test('overlapping roots do not consume file budgets twice or produce duplicate content', (t) => {
  const root = fixture(t, { 'child/a.html': '<img>' });
  const result = collectAnalysisInputs(
    [
      { id: 'outer', path: root },
      { id: 'inner', path: path.join(root, 'child') },
    ],
    { files: 1 },
  );
  assert.equal(result.complete, true);
  assert.equal(result.stats.files, 1);
  assert.equal(result.inputs.length, 1);
});

test('an explicitly selected root alias cannot cross into ignored private state', (t) => {
  const root = fixture(t, { '.paqvilo/power.config.json': '{"bearer":"INVENTED-PRIVATE-STATE"}' });
  const alias = path.join(root, 'alias');
  fs.symlinkSync(path.join(root, '.paqvilo'), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const result = collectAnalysisInputs([{ id: 'alias', path: alias }]);
  assert.equal(result.complete, false);
  assert.equal(result.stats.bytes, 0);
  assert.deepEqual(result.inputs, []);
  assert.ok(result.skipped.some((entry) => entry.reason === 'ignored-root'));
});

test('Solution packages and nested Canvas packages are read in memory with isolated archive identities', (t) => {
  const first = archive({ 'Src/App.pa.yaml': 'App:\n  Properties:\n    StartScreen: =Screen1\n' });
  const second = archive({ 'Src/App.pa.yaml': 'App:\n  Properties:\n    StartScreen: =Screen2\n' });
  const root = fixture(t, {
    'solution.zip': archive({ 'CanvasApps/first.msapp': first, 'CanvasApps/second.msapp': second }),
  });
  const input = collectAnalysisInputs([{ id: 'solution', path: path.join(root, 'solution.zip') }]);
  assert.equal(input.complete, true);
  const sources = input.inputs.filter((entry) => !entry.archive);
  assert.equal(sources.length, 2);
  assert.notEqual(sources[0].rootId, sources[1].rootId);
  assert.ok(sources.every((entry) => entry.file.includes('.msapp!/Src/App.pa.yaml')));
  assert.equal(fs.existsSync(path.join(root, 'CanvasApps')), false);
});

test('archive and filesystem hidden state are excluded and excessive nested archives are incomplete', (t) => {
  let nested = archive({ 'body.html': '<img>' });
  for (let index = 0; index < 3; index++) nested = archive({ 'nested.zip': nested });
  const root = fixture(t, {
    'safe.zip': archive({ '.paqvilo/discovery.json': '{"bearer":"MUST-NOT-READ"}', 'body.html': '<img>' }),
    'nested.zip': nested,
  });
  const result = collectAnalysisInputs([{ id: 'safe', path: path.join(root, 'safe.zip') }]);
  const sources = result.inputs.filter((entry) => !entry.archive);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].text, '<img>');
  assert.equal(result.stats.entries, 2, 'excluded member metadata still consumes the shared entry budget');
  const limited = collectAnalysisInputs([{ id: 'nested', path: path.join(root, 'nested.zip') }]);
  assert.equal(limited.complete, false);
  assert.ok(limited.skipped.some((entry) => entry.reason === 'archive-depth-limit'));
});

test('archive metadata consumes one shared entry budget across separately selected packages', (t) => {
  const zip = archive({ 'body.html': '<img>', 'unused.bin': Buffer.from([1]) });
  const root = fixture(t, { 'first.zip': zip, 'second.zip': zip });
  const input = collectAnalysisInputs(
    ['first', 'second'].map((id) => ({ id, path: path.join(root, id + '.zip') })),
    { entries: 3 },
  );
  assert.equal(input.complete, false);
  assert.equal(input.inputs.filter((entry) => !entry.archive).length, 1);
  assert.equal(input.stats.entries, 2);
  assert.ok(input.skipped.length > 0);
});

test('actual read bytes cannot escape the aggregate budget after the preliminary stat', (t) => {
  const root = fixture(t, { 'body.html': 'larger than the remaining budget' });
  const file = path.join(root, 'body.html');
  const original = fs.lstatSync;
  fs.lstatSync = function (candidate, ...args) {
    if (candidate === file) return { ...original.call(this, candidate, ...args), size: 1 };
    return original.call(this, candidate, ...args);
  };
  try {
    const result = collectAnalysisInputs([{ id: 'source', path: root }], { totalBytes: 2 });
    assert.equal(result.complete, false);
    assert.equal(result.stats.bytes, 0);
    assert.ok(result.skipped.some((entry) => entry.reason === 'total-size-limit'));
  } finally {
    fs.lstatSync = original;
  }
});

test('explicit project parser errors are redacted and alias-backed source selection is rejected', (t) => {
  const root = fixture(t, {
    'project.json': '{"version":2,"secret":PRIVATE-PARSER-CANARY}',
    'project.yml': 'version: 2\nsolutions: &shared [solution]\ncodeApps: *shared\n',
  });
  for (const name of ['project.json', 'project.yml'])
    assert.throws(
      () => configuredAnalysisRoots({ configDir: root, mirageConfig: { project: path.join(root, name) } }),
      (error) => !/PRIVATE-PARSER-CANARY|shared/.test(error.message),
    );
});

test('top-level analysis works without a portal catalogue and never executes local app configuration', (t) => {
  const root = fixture(t, {
    'package.json': JSON.stringify({
      dependencies: { '@microsoft/power-apps-native-host': '1.0.0', 'react-native': '1.0.0' },
    }),
    'app.config.js': 'throw new Error("SOURCE-CONFIG-EXECUTED")',
  });
  const cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
  const output = execFileSync(process.execPath, [cli, 'analyze', '--source', root, '--json'], {
    cwd: root,
    windowsHide: true,
    encoding: 'utf8',
  });
  const report = JSON.parse(output);
  assert.equal(report.ok, true);
  assert.ok(
    report.reports[0].analysis.coverage.domains.some(
      (domain) => domain.domain === 'mobile-apps' && domain.recognized > 0,
    ),
  );
  assert.doesNotMatch(output, /SOURCE-CONFIG-EXECUTED/);
});

test('a standalone Dataverse catalogue and direct project analyze declared Solution sources in Doctor too', (t) => {
  const root = fixture(t, {
    'solution/Other/Solution.xml': '<SolutionManifest><Version>1.0.0.0</Version></SolutionManifest>',
    'project.json': JSON.stringify({
      version: 2,
      runtime: { kind: 'dataverse-api' },
      solutions: [{ id: 'schema', path: 'solution' }],
    }),
    'catalogue.json': JSON.stringify({
      sourceRoot: '.',
      defaultSite: 'organization',
      sites: { organization: { mirage: { runtime: { kind: 'dataverse-api' }, project: './project.json', port: 0 } } },
    }),
  });
  const cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
  const execute = (args) =>
    JSON.parse(
      execFileSync(process.execPath, [cli, ...args, '--json'], { cwd: root, windowsHide: true, encoding: 'utf8' }),
    );
  const results = [
    execute(['analyze', '--project', path.join(root, 'project.json')]),
    execute(['analyze', '--config', path.join(root, 'catalogue.json')]),
    execute(['lense', 'doctor', '--config', path.join(root, 'catalogue.json'), '--fail-on', 'error']),
  ];
  for (const result of results) {
    const report = result.reports[0];
    assert.equal(report.analysis.complete, true);
    assert.equal(report.analysis.ready, true);
    assert.ok(report.analysis.coverage.roots.some((entry) => entry.kind === 'solution'));
    assert.ok(report.analysis.coverage.domains.some((entry) => entry.domain === 'alm' && entry.recognized > 0));
    assert.ok(
      report.analysis.coverage.domains.some(
        (entry) => entry.domain === 'governance' && entry.status === 'separate-evidence-required',
      ),
    );
  }
});

test('whole-project analysis includes declared portals while catalogue source selection stays bounded', (t) => {
  const root = fixture(t, {
    'portal/sitesetting.yml': '- name: Webapi/sample/fields\n  value: "*"\n',
    'project.json': JSON.stringify({ version: 2, portals: [{ path: 'portal' }] }),
  });
  const roots = configuredAnalysisRoots({
    configDir: root,
    mirageConfig: { project: path.join(root, 'project.json') },
  });
  assert.ok(roots.some((entry) => entry.kind === 'portal'));
  const report = analyzeProject(null, { sourceRoots: roots });
  assert.ok(report.findings.some((finding) => finding.ruleId === 'PP-API-001'));
  const selected = configuredAnalysisRoots({
    configDir: root,
    sourceDir: path.join(root, 'selected'),
    mirageConfig: { project: path.join(root, 'project.json') },
  });
  assert.equal(selected.filter((entry) => entry.kind === 'portal').length, 1);
  assert.ok(!selected.some((entry) => entry.path === path.join(root, 'portal')));
});

test('separate portal roots never borrow settings or default roles from one another', (t) => {
  const role =
    '- name: Invented default\n  anonymoususersrole: true\n  websiteid: 00000000-0000-0000-0000-000000000001\n';
  const root = fixture(t, {
    'first/sitesetting.yml': '- name: Webapi/sample/enabled\n  value: true\n',
    'first/webrole.yml': role,
    'second/sitesetting.yml': '- name: Webapi/sample/fields\n  value: sample_column\n',
    'second/webrole.yml': role,
  });
  const report = analyzeProject(null, {
    sourceRoots: ['first', 'second'].map((id) => ({ id, path: path.join(root, id) })),
  });
  assert.ok(report.findings.some((finding) => finding.ruleId === 'PP-API-002' && finding.file.startsWith('first/')));
  assert.ok(!report.findings.some((finding) => finding.ruleId === 'PP-ROLE-001' || finding.ruleId === 'PP-CONFIG-001'));
});

test('a declared Canvas package cannot borrow web-source completeness from an unrelated file', (t) => {
  const root = fixture(t, {
    'app.msapp': archive({ 'unsupported.json': '{"unknown":true}' }),
    'body.html': '<p>Valid unrelated content</p>',
  });
  const report = analyzeProject(root);
  assert.equal(report.complete, false);
  assert.equal(report.coverage.domains.find((domain) => domain.domain === 'canvas').status, 'partial');
  assert.ok(report.capabilities.find((capability) => capability.id === 'canvas-compile').applicable);
});

test('unreadable declared domains remain partial and retain their operation requirements', (t) => {
  const root = fixture(t, { 'Workflows/broken.json': '{', 'body.html': '<p>Invented</p>' });
  const report = analyzeProject(root);
  assert.equal(report.complete, false);
  assert.equal(report.coverage.domains.find((entry) => entry.domain === 'flows').status, 'partial');
  assert.ok(report.capabilities.find((entry) => entry.id === 'flow-validation').applicable);
  assert.ok(report.coverage.notPerformed.includes('complete-wdl-type-checking'));
  assert.ok(report.coverage.notPerformed.includes('mcp-implementation-dataflow'));
});

test('native packages cannot pass without their exact root manifest even when they contain JavaScript', (t) => {
  const root = fixture(t, {
    'sample.PPMPLUGIN': archive({
      'wrong/manifest.json': '{}',
      'index.js': 'throw new Error("NEVER-EXECUTE-PACKAGE")',
    }),
  });
  const report = analyzeProject(root);
  assert.equal(report.complete, false);
  assert.ok(report.findings.some((finding) => finding.ruleId === 'NATIVE-EXT-004'));
  assert.ok(report.coverage.domains.find((domain) => domain.domain === 'mobile-extension').recognized > 0);
  assert.doesNotMatch(JSON.stringify(report), /NEVER-EXECUTE-PACKAGE/);
});

test('Doctor readiness never echoes malformed project JSON through an independent readiness path', (t) => {
  const root = fixture(t, {
    'project.json': '{"version":2,"secret":PRIVATE-READINESS-CANARY}',
    'catalogue.json': JSON.stringify({
      sourceRoot: '.',
      defaultSite: 'organization',
      sites: { organization: { mirage: { runtime: { kind: 'dataverse-api' }, project: './project.json', port: 0 } } },
    }),
  });
  const cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
  const output = execFileSync(
    process.execPath,
    [cli, 'lense', 'doctor', '--config', path.join(root, 'catalogue.json'), '--json'],
    { cwd: root, encoding: 'utf8', windowsHide: true },
  );
  assert.doesNotMatch(output, /PRIVATE|Unexpected token/);
  assert.equal(JSON.parse(output).reports[0].mirage.project.ready, false);
});
