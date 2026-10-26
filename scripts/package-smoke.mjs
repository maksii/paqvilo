// Install the actual distributable into an independent project, without portal traffic.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { validateReleaseFiles } from './release-check.mjs';
import { verifyConsumerToolOwnership } from './consumer-tool-smoke.mjs';
import { packageDependencyEvidence } from './package-dependency-evidence.mjs';
import { assertSmokeProcess } from './smoke-process.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.env.npm_execpath;
if (!npm || !fs.existsSync(npm)) throw new Error('Run npm run release:smoke to use the configured npm CLI.');
const directory = path.join(root, '.paqvilo', 'distribution');
fs.mkdirSync(directory, { recursive: true });
const work = fs.mkdtempSync(path.join(directory, 'smoke-'));
const run = (args, cwd, timeout = 120_000) => {
  const result = spawnSync(process.execPath, [npm, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(result.error?.message ?? `${args[0]} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
};

const packed = JSON.parse(run(['pack', '--json', '--ignore-scripts', '--pack-destination', work], root))[0];
validateReleaseFiles(packed.files);
const archive = `file:${path.join(work, packed.filename).replaceAll('\\', '/')}`;
const bootstrap = path.join(work, 'bootstrap');
fs.mkdirSync(bootstrap);
fs.writeFileSync(
  path.join(bootstrap, 'package.json'),
  JSON.stringify({ name: 'paqvilo-smoke-bootstrap', private: true, dependencies: { paqvilo: archive } }),
);
run(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], bootstrap);
const dependencyEvidence = packageDependencyEvidence(
  JSON.parse(fs.readFileSync(path.join(bootstrap, 'node_modules/paqvilo/npm-shrinkwrap.json'), 'utf8')),
  JSON.parse(fs.readFileSync(path.join(bootstrap, 'package-lock.json'), 'utf8')),
  'paqvilo',
);
const dependencyEvidenceFile = path.join(work, 'dependency-evidence.json');
fs.writeFileSync(
  dependencyEvidenceFile,
  JSON.stringify(
    { npmVersion: run(['--version'], bootstrap).trim(), archive: packed.filename, ...dependencyEvidence },
    null,
    2,
  ) + '\n',
);
console.log(`Consumer dependency evidence: ${dependencyEvidenceFile}`);
console.log(`Consumer dependency differences: ${JSON.stringify(dependencyEvidence.differences)}`);
// Resolve every supported entry point from the independent installed consumer.
// Checkout imports alone cannot detect missing packaged dependencies or exports.
const consumerRequire = createRequire(path.join(bootstrap, 'package.json'));
const publicContract = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/public-api.json'), 'utf8'));
for (const [entry, names] of Object.entries(publicContract.surfaces)) {
  const installedModule = await import(pathToFileURL(consumerRequire.resolve(entry)));
  for (const name of names)
    if (!Object.hasOwn(installedModule, name)) throw new Error(`Installed public export is missing: ${entry}: ${name}`);
}
console.log(`Installed public API contract passed: ${Object.keys(publicContract.surfaces).length} entry points.`);
// Load the shipped inspector graph: a file-list check alone misses broken runtime imports.
const modelInspector = await import(
  pathToFileURL(path.join(bootstrap, 'node_modules/paqvilo/lense/model-driven-inspector.mjs'))
);
if (typeof modelInspector.startModelDrivenInspector !== 'function')
  throw new Error('Installed model-driven inspector is unavailable.');
// Exercise empty consumer templates from the actual archive, independently of the demo.
for (const options of [
  [],
  ['--no-pack', '--no-vscode'],
  ['--pack', 'alpha', '--pack', 'beta', '--site', 'one', '--site', 'two'],
]) {
  const consumer = path.join(work, `consumer-${options.length}`);
  const init = spawnSync(
    process.execPath,
    [
      path.join(bootstrap, 'node_modules/paqvilo/bin/paqvilo.mjs'),
      'init',
      consumer,
      '--name',
      'smoke',
      '--toolkit',
      archive,
      '--json',
      ...options,
    ],
    { cwd: bootstrap, encoding: 'utf8', windowsHide: true, timeout: 30000 },
  );
  if (init.status !== 0 || !JSON.parse(init.stdout).ok)
    throw new Error(`Installed init failed: ${init.stdout}\n${init.stderr}`);
  const npmLogs = path.join(consumer, '.paqvilo', 'npm-logs');
  fs.mkdirSync(npmLogs, { recursive: true });
  const bootstrapConsumer = () => {
    const result = spawnSync(process.execPath, [path.join(consumer, 'tools/bootstrap.mjs')], {
      cwd: consumer,
      env: {
        ...process.env,
        npm_execpath: npm,
        npm_config_offline: 'true',
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        npm_config_update_notifier: 'false',
        npm_config_logs_dir: npmLogs,
        npm_config_timing: 'true',
      },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120000,
      maxBuffer: 4 * 1024 * 1024,
    });
    assertSmokeProcess(result, `Installed consumer bootstrap failed (npm logs: ${npmLogs})`);
  };
  bootstrapConsumer();
  const lockFile = path.join(consumer, 'package-lock.json'),
    firstLock = fs.readFileSync(lockFile, 'utf8');
  bootstrapConsumer();
  if (fs.readFileSync(lockFile, 'utf8') !== firstLock)
    throw new Error('Repeat consumer bootstrap rewrote its lockfile');
  console.log(run(['test'], consumer).trim());
  console.log(run(['run', 'test:browser'], consumer).trim());
}
const project = path.join(work, 'project');
const scaffold = spawnSync(
  process.execPath,
  [path.join(bootstrap, 'node_modules/paqvilo/bin/paqvilo.mjs'), 'mirage', 'demo', '--scaffold', '--dir', project],
  { cwd: bootstrap, encoding: 'utf8', windowsHide: true, timeout: 120_000 },
);
if (scaffold.status !== 0 || !scaffold.stdout.includes('No runtime was started.'))
  throw new Error(`Installed scaffold failed: ${scaffold.stdout}\n${scaffold.stderr}`);
const manifestFile = path.join(project, 'package.json');
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
manifest.devDependencies.paqvilo = archive;
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
run(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund'], project);
const installed = path.join(project, 'node_modules/paqvilo/bin/paqvilo.mjs');
verifyConsumerToolOwnership(installed, project);
const cli = (...args) => {
  const result = spawnSync(process.execPath, [installed, ...args], {
    cwd: project,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(`Installed command failed: ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
};
const readiness = cli('doctor', '--setup', '--json');
if (!readiness.ready) throw new Error('Plain packed npm installation must be ready before any package-local setup.');
if (fs.existsSync(path.join(project, 'node_modules/paqvilo/mirage/node_modules')))
  throw new Error('Packed consumer unexpectedly needs a duplicate Mirage dependency installation.');
for (const product of ['lense', 'mirage', 'dataverse']) {
  const help = spawnSync(process.execPath, [installed, product, '--help'], {
    cwd: project,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  });
  if (help.status !== 0 || !help.stdout.toLowerCase().includes(product))
    throw new Error(`Installed ${product} help failed: ${help.stderr}`);
}
const demoHelp = spawnSync(process.execPath, [installed, 'mirage', 'demo', '--help'], {
  cwd: project,
  encoding: 'utf8',
  windowsHide: true,
  timeout: 30_000,
});
if (demoHelp.status !== 0 || !demoHelp.stdout.includes('Copies a populated'))
  throw new Error(`Installed demo command is missing: ${demoHelp.stderr}`);
const initialized = cli('mirage', 'init', '--site', 'example', '--json');
const stateRoot = path.join(project, '.paqvilo') + path.sep;
if (!initialized.file.startsWith(stateRoot))
  throw new Error('Project initialization wrote inside the installed toolkit.');
let session;
try {
  session = cli('mirage', 'start', '--site', 'example', '--port', '0', '--preset', 'example-demo', '--json');
  if (!session.stateFile.startsWith(stateRoot)) throw new Error('Runtime state did not stay in the portal project.');
  if (!cli('mirage', 'status', '--json').sessions.some((item) => item.pid === session.pid && item.ready))
    throw new Error('Project-scoped status did not discover its runtime.');
  const response = await fetch(session.url);
  if (!response.ok || !(await response.text()).includes('Build it three ways'))
    throw new Error('Installed lifecycle did not render the project.');
  const setupStatus = await fetch(session.url + '/_setup/api/status').then((response) => response.json());
  if (
    setupStatus.kind !== 'catalogue' ||
    setupStatus.layers.shared.file !== path.join(project, 'paqvilo.config.yml') ||
    setupStatus.sites[0]?.id !== 'example'
  )
    throw new Error('Installed setup did not use the consumer catalogue.');
  for (const asset of ['', 'app.mjs', 'style.css'])
    if (!(await fetch(session.url + '/_setup/' + asset)).ok)
      throw new Error(`Installed setup asset is missing: ${asset}`);
  const appShell = await fetch(session.url + '/main.aspx');
  if (!appShell.ok || !(await appShell.text()).includes('/_apps/assets/app.mjs'))
    throw new Error('Installed model-driven shell is missing.');
  for (const asset of [
    'app.mjs',
    'client-runtime.mjs',
    'pcf-runtime.mjs',
    'controls.mjs',
    'control-descriptors.mjs',
    'icons.mjs',
    'style.css',
  ])
    if (!(await fetch(session.url + '/_apps/assets/' + asset)).ok)
      throw new Error(`Installed model-driven asset is missing: ${asset}`);
  const apps = await fetch(session.url + '/_apps/api').then((response) => response.json());
  if (apps.version !== 1 || !apps.apps.some((app) => app.id === apps.defaultApp && app.name === 'Mirage Site Manager'))
    throw new Error('Installed default management application is unavailable.');
} finally {
  if (session) cli('mirage', 'stop', '--site', 'example', '--json');
}
if (cli('mirage', 'status', '--json').sessions.some((item) => item.processAlive))
  throw new Error('Installed lifecycle left an owned runtime running.');
// A separate consumer folder deliberately has no portal export or catalogue.
// Exercise installed entry points and dynamically imported platform/UI modules,
// rather than relying on package file presence or checkout-only host tests.
const standalone = path.join(work, 'standalone');
const appId = '77777777-7777-4777-8777-777777777777';
const solutionFiles = {
  'solution/Other/Solution.xml':
    '<ImportExportXml><SolutionManifest><UniqueName>InventedInstalled</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
  'solution/Entities/x_item/Entity.xml':
    '<Entity><Name>x_item</Name><EntityInfo><entity Name="x_item"><EntitySetName>x_items</EntitySetName><PrimaryIdAttribute>x_itemid</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="x_itemid"><Name>x_itemid</Name><Type>primarykey</Type></attribute><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type></attribute></attributes></entity></EntityInfo></Entity>',
  'solution/AppModules/x_workspace/AppModule.xml': `<AppModule><AppModuleId>${appId}</AppModuleId><UniqueName>x_workspace</UniqueName><LocalizedNames><LocalizedName languagecode="1033" description="Installed workspace"/></LocalizedNames><AppModuleComponents><AppModuleComponent type="1" schemaName="x_item"/></AppModuleComponents></AppModule>`,
};
for (const [relative, contents] of Object.entries(solutionFiles)) {
  const file = path.join(standalone, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}
for (const kind of ['dataverse-api', 'model-driven']) {
  const file = path.join(standalone, `${kind}.project.json`);
  const configuration = JSON.stringify({
    version: 2,
    runtime: { kind, ...(kind === 'model-driven' ? { defaultApp: appId } : {}) },
    simulation: { level: 'dry-run' },
    solutions: kind === 'model-driven' ? [{ id: 'core', path: './solution' }] : [],
    dataverse: { enabled: kind === 'dataverse-api', tls: false, tds: { enabled: false } },
  });
  fs.writeFileSync(file, configuration);
  const standaloneCli = (command, ...args) => {
    const result = spawnSync(process.execPath, [installed, 'mirage', command, '--project', file, '--json', ...args], {
      cwd: standalone,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (result.status !== 0)
      throw new Error(`Installed standalone ${kind} ${command} failed:\n${result.stdout}\n${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  const inspect = standaloneCli('inspect');
  if (inspect.runtime.kind !== kind || inspect.portals.length)
    throw new Error('Installed standalone inspection invented a portal.');
  let local;
  const failures = [];
  try {
    local = standaloneCli('start', '--port', '0');
    if (!standaloneCli('status').sessions.some((item) => item.pid === local.pid && item.ready))
      throw new Error('Installed standalone status did not find its runtime.');
    const status = await fetch(local.url + '/_sim/api/status').then((response) => response.json());
    if (
      status.runtime.kind !== kind ||
      !status.capabilities.organization ||
      status.capabilities.powerPages ||
      status.links.powerPages !== null ||
      status.capabilities.modelDriven !== (kind === 'model-driven') ||
      status.capabilities.dataverseApi !== (kind === 'dataverse-api')
    )
      throw new Error('Installed standalone capabilities do not match the selected surface.');
    for (const asset of [
      '',
      'app.mjs',
      'persona-manager.mjs',
      'persona-picker.mjs',
      'persona-picker-view.mjs',
      'persona-search.mjs',
    ])
      if (!(await fetch(local.url + '/_sim/' + asset)).ok)
        throw new Error(`Installed standalone admin asset is missing: ${asset}`);
    const setup = await fetch(local.url + '/_setup/api/status').then((response) => response.json());
    if (setup.kind !== 'project' || setup.layers.shared.file !== file)
      throw new Error('Installed standalone setup did not retain the selected project.');
    if (kind === 'dataverse-api') {
      if (
        status.links.modelDriven !== null ||
        !status.links.dataverseApi ||
        (await fetch(local.url + '/main.aspx')).status !== 404 ||
        (await fetch(local.url + '/_apps/api')).status !== 404
      )
        throw new Error('Installed API-only runtime exposed an unavailable app surface.');
      const metadata = await fetch(status.links.dataverseApi + '/api/data/v9.2/$metadata');
      if (metadata.status !== 401) throw new Error('Installed organization listener did not require an API identity.');
    } else {
      if (status.links.modelDriven !== '/main.aspx' || status.links.dataverseApi !== null)
        throw new Error('Installed model-only runtime links are incorrect.');
      const shell = await fetch(local.url + status.links.modelDriven);
      if (!shell.ok || !(await shell.text()).includes('/_apps/assets/app.mjs'))
        throw new Error('Installed source-only model shell is unavailable.');
      for (const asset of [
        'app.mjs',
        'client-runtime.mjs',
        'pcf-runtime.mjs',
        'controls.mjs',
        'control-descriptors.mjs',
        'icons.mjs',
        'style.css',
      ])
        if (!(await fetch(local.url + '/_apps/assets/' + asset)).ok)
          throw new Error(`Installed standalone model asset is missing: ${asset}`);
      const catalogue = await fetch(local.url + '/_apps/api').then((response) => response.json());
      if (
        catalogue.defaultApp !== appId ||
        catalogue.apps.length !== 1 ||
        catalogue.apps[0].name !== 'Installed workspace' ||
        !catalogue.tables.x_item
      )
        throw new Error('Installed source-only app catalogue did not derive the selected Solution.');
      const created = await fetch(local.url + '/_apps/api/tables/x_item', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-sim-csrf': status.csrf },
        body: JSON.stringify({ x_name: 'Installed record' }),
      });
      const result = await created.json();
      if (created.status !== 201 || result.row?.x_name !== 'Installed record')
        throw new Error('Installed model-only record service did not create a row.');
      const read = await fetch(local.url + '/_apps/api/tables/x_item/' + result.row.x_itemid).then((response) =>
        response.json(),
      );
      if (read.row?.x_name !== 'Installed record')
        throw new Error('Installed model-only record service did not read its created row.');
    }
    if (fs.existsSync(local.stateFile)) throw new Error('Installed standalone dry run wrote a runtime checkpoint.');
  } catch (error) {
    failures.push(error);
  } finally {
    if (local) {
      try {
        const stopped = standaloneCli('stop');
        if (!stopped.stopped.some((item) => item.pid === local.pid))
          failures.push(new Error('Installed standalone stop did not stop its owned runtime.'));
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'Installed standalone verification and cleanup failed.');
  if (standaloneCli('status').sessions.some((item) => item.processAlive))
    throw new Error('Installed standalone lifecycle left an owned runtime running.');
  if (fs.readFileSync(file, 'utf8') !== configuration)
    throw new Error('Installed lifecycle changed the standalone project configuration.');
}
for (const [relative, contents] of Object.entries(solutionFiles))
  if (fs.readFileSync(path.join(standalone, relative), 'utf8') !== contents)
    throw new Error('Installed standalone runtime changed Solution sources.');
console.log(
  'Installed standalone smoke passed: API-only and source-only model-driven CLI, capabilities, assets and local records.',
);
const tests = run(['test'], project);
console.log(tests.trim());
const workspace = spawnSync(process.execPath, ['--test', path.join(root, 'test-browser/demo-workspace.test.mjs')], {
  cwd: root,
  env: { ...process.env, PAQVILO_DEMO_CLI: installed },
  encoding: 'utf8',
  windowsHide: true,
  timeout: 120_000,
  maxBuffer: 1024 * 1024,
});
if (workspace.status !== 0)
  throw new Error(`Installed workspace browser check failed: ${workspace.stdout}\n${workspace.stderr}`);
console.log(workspace.stdout.trim());
console.log(
  `Distribution smoke passed: ${packed.files.length} files; independent offline install, installed demo scaffold, project-scoped lifecycle, project acceptance tests and workspace browser debugging. Artifact: ${path.join(work, packed.filename)}`,
);
