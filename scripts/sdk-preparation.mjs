import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const sampleRemote = 'https://github.com/microsoft/PowerApps-Samples.git';
const sampleTree = 'dataverse/webapi/CSharp-NETx/WebAPIService';
const canonicalName = (name) => name.toLowerCase().replace(/[-_.]+/g, '-');
const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** NuGet's vulnerable-package command exits zero even when it reports advisories. */
export async function auditServiceClientDependencies({ root, execute = spawnSync }) {
  root = fs.realpathSync.native(root);
  const project = path.join(root, 'mirage/test-sdk/serviceclient/Gate/Gate.csproj');
  const lock = path.join(path.dirname(project), 'packages.lock.json');
  const qualification = { project: digest(project), lock: digest(lock) };
  const malformed = () => {
    throw new Error('ServiceClient NuGet vulnerability audit returned an incomplete report.');
  };
  const diagnostics = (value) => {
    if (value.error) malformed();
    for (const key of ['errors', 'problems', 'logs'])
      if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].length)) malformed();
  };
  const read = async (vulnerable) => {
    const result = await execute(
      'dotnet',
      [
        'list',
        project,
        'package',
        ...(vulnerable ? ['--vulnerable'] : []),
        '--include-transitive',
        '--format',
        'json',
        '--no-restore',
      ],
      { cwd: root, encoding: 'utf8', stdio: 'pipe', timeout: 120_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
    );
    if (result?.error || result?.status !== 0 || typeof result.stdout !== 'string' || result.stderr?.trim())
      throw new Error('ServiceClient NuGet vulnerability audit failed or returned diagnostics.');
    let report;
    try {
      report = JSON.parse(result.stdout);
    } catch {
      throw new Error('ServiceClient NuGet vulnerability audit returned invalid JSON.');
    }
    if (
      report?.version !== 1 ||
      typeof report.parameters !== 'string' ||
      !report.parameters.split(/\s+/).includes('--include-transitive') ||
      (vulnerable &&
        (!report.parameters.split(/\s+/).includes('--vulnerable') ||
          !Array.isArray(report.sources) ||
          !report.sources.length ||
          report.sources.some((source) => typeof source !== 'string' || !source.trim()))) ||
      !Array.isArray(report.projects) ||
      report.projects.length !== 1 ||
      report.error
    )
      malformed();
    diagnostics(report);
    const selected = report.projects[0];
    if (typeof selected?.path !== 'string' || path.relative(project, path.resolve(root, selected.path))) malformed();
    diagnostics(selected);
    if (selected.frameworks !== undefined && !Array.isArray(selected.frameworks)) malformed();
    return selected;
  };
  const inventory = await read(false);
  if (inventory.frameworks?.length !== 1 || inventory.frameworks[0]?.framework !== 'net10.0') malformed();
  const framework = inventory.frameworks[0];
  diagnostics(framework);
  if (
    !Array.isArray(framework.topLevelPackages) ||
    !framework.topLevelPackages.length ||
    !Array.isArray(framework.transitivePackages)
  )
    malformed();
  const resolved = new Map();
  for (const dependency of [...framework.topLevelPackages, ...framework.transitivePackages]) {
    if (
      typeof dependency?.id !== 'string' ||
      typeof dependency.resolvedVersion !== 'string' ||
      resolved.has(dependency.id.toLowerCase())
    )
      malformed();
    resolved.set(dependency.id.toLowerCase(), dependency.resolvedVersion);
  }
  const locked = JSON.parse(fs.readFileSync(lock, 'utf8')).dependencies?.['net10.0'];
  if (!locked || typeof locked !== 'object' || Array.isArray(locked) || Object.keys(locked).length !== resolved.size)
    malformed();
  for (const [name, dependency] of Object.entries(locked))
    if (typeof dependency?.resolved !== 'string' || resolved.get(name.toLowerCase()) !== dependency.resolved)
      malformed();
  const selected = await read(true);
  const affected = [];
  // A clean NuGet JSON-v1 report omits frameworks entirely for this project.
  for (const framework of selected.frameworks || []) {
    if (framework?.framework !== 'net10.0') malformed();
    diagnostics(framework);
    for (const key of ['topLevelPackages', 'transitivePackages']) {
      if (framework[key] !== undefined && !Array.isArray(framework[key])) malformed();
      for (const dependency of framework[key] || []) {
        if (
          typeof dependency?.id !== 'string' ||
          typeof dependency.resolvedVersion !== 'string' ||
          resolved.get(dependency.id.toLowerCase()) !== dependency.resolvedVersion ||
          !Array.isArray(dependency.vulnerabilities) ||
          !dependency.vulnerabilities.length
        )
          malformed();
        affected.push({ id: dependency.id, records: dependency.vulnerabilities.length });
      }
    }
  }
  if (affected.length)
    throw new Error(
      `ServiceClient NuGet audit found ${affected.reduce((sum, item) => sum + item.records, 0)} advisory records: ${affected.map((item) => item.id).join(', ')}`,
    );
  if (digest(project) !== qualification.project || digest(lock) !== qualification.lock)
    throw new Error('ServiceClient project or lock changed during the NuGet audit.');
  return { projects: 1, packages: resolved.size, advisoryRecords: 0, ...qualification };
}
const pythonInventory = String.raw`
import base64, csv, hashlib, importlib.metadata, io, json, platform, sys
expected=json.loads(sys.argv[1])
assert platform.python_implementation() == 'CPython' and sys.version_info[:2] == (3,13), 'CPython 3.13 required'
normal=lambda name: __import__('re').sub(r'[-_.]+','-',name.lower())
installed={normal(d.metadata['Name']): d for d in importlib.metadata.distributions()}
assert set(installed)-set(expected)-{'pip','setuptools','wheel'} == set(), 'Unexpected installed distributions'
for name, version in expected.items():
    dist=installed.get(name)
    assert dist is not None and dist.version == version, 'Missing/stale distribution: '+name
    record=dist.read_text('RECORD')
    assert record is not None, 'Missing wheel RECORD: '+name
    for relative, encoded, size in csv.reader(io.StringIO(record)):
        if not encoded: continue
        algorithm, value=encoded.split('=',1)
        assert algorithm == 'sha256', 'Unsupported wheel hash: '+name
        actual=base64.urlsafe_b64encode(hashlib.sha256(dist.locate_file(relative).read_bytes()).digest()).rstrip(b'=').decode()
        assert actual == value, 'Modified installed wheel file: '+relative
print(json.dumps({'implementation':platform.python_implementation(),'version':platform.python_version(),'packages':expected}))
`;

function layout(root) {
  root = fs.realpathSync.native(root);
  const directory = path.join(root, '.paqvilo/sdk-gates');
  // These are owned preparation folders, never aliases into another checkout.
  for (const relative of [
    '.paqvilo',
    '.paqvilo/sdk-gates',
    '.paqvilo/sdk-gates/python-dataverse',
    '.paqvilo/sdk-gates/python-dataverse/.venv',
    '.paqvilo/sdk-gates/PowerApps-Samples',
  ]) {
    const file = path.join(root, relative);
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink())
      throw new Error(`SDK fixture folder must not be a link: ${relative}`);
  }
  const pythonDirectory = path.join(directory, 'python-dataverse');
  return {
    root,
    directory,
    pythonDirectory,
    venv: path.join(pythonDirectory, '.venv'),
    python: path.join(pythonDirectory, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    receipt: path.join(pythonDirectory, 'receipt.json'),
    lock: path.join(root, 'mirage/test-sdk/python-dataverse/requirements.lock.txt'),
    direct: path.join(root, 'mirage/test-sdk/python-dataverse/requirements.txt'),
    sample: path.join(directory, 'PowerApps-Samples'),
    pin: /^Commit:\s*([a-f0-9]{40})$/m.exec(
      fs.readFileSync(path.join(root, 'mirage/test-sdk/webapi-samples/PINNED_COMMIT.txt'), 'utf8'),
    )?.[1],
    project: path.join(root, 'mirage/test-sdk/webapi-samples/Gate/Gate.csproj'),
  };
}

function requirements(files) {
  const expected = {};
  const lines = fs
    .readFileSync(files.lock, 'utf8')
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = /^([A-Za-z0-9_.-]+)==([A-Za-z0-9_.+!-]+)((?:\s+--hash=sha256:[a-f0-9]{64})+)\s*$/.exec(line);
    if (!match || expected[canonicalName(match[1])])
      throw new Error('SDK Python lock must contain unique exact pins with SHA256 wheel hashes.');
    expected[canonicalName(match[1])] = match[2];
  }
  if (!Object.keys(expected).length) throw new Error('SDK Python lock is empty.');
  for (const line of fs.readFileSync(files.direct, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = /^([A-Za-z0-9_.-]+)==([^\s]+)$/.exec(line.trim());
    if (!match || expected[canonicalName(match[1])] !== match[2])
      throw new Error('SDK Python direct requirements disagree with the hashed lock.');
  }
  if (!/^[a-f0-9]{40}$/.test(files.pin)) throw new Error('SDK sample commit must be an exact Git SHA.');
  return expected;
}

function probe(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000, windowsHide: true, ...options });
  if (result.error || result.status !== 0)
    throw new Error(
      `SDK fixture check failed: ${command} ${args[0]}\n${result.error?.message || result.stderr || result.stdout}`,
    );
  return result.stdout.trim();
}

function gitArguments(files, args) {
  return [
    '-c',
    `core.hooksPath=${path.join(files.directory, 'disabled-hooks')}`,
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.longpaths=true',
    '-C',
    files.sample,
    ...args,
  ];
}

function gitEnvironment() {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name))),
    GIT_CONFIG_NOSYSTEM: '1',
    // Git for Windows cannot open Node's extended device spelling (\\.\nul).
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : os.devNull,
    GIT_TERMINAL_PROMPT: '0',
  };
}

function checkSample(files, { allowStale = false } = {}) {
  if (!fs.existsSync(path.join(files.sample, '.git')) || !fs.lstatSync(path.join(files.sample, '.git')).isDirectory())
    throw new Error('SDK sample checkout is missing or is an external worktree. Run ci:prepare --sdk.');
  const git = (args) => probe('git', gitArguments(files, args), { env: gitEnvironment() });
  if (fs.realpathSync.native(git(['rev-parse', '--show-toplevel'])) !== fs.realpathSync.native(files.sample))
    throw new Error('SDK sample repository root does not match the owned fixture.');
  if (!allowStale && git(['rev-parse', 'HEAD']) !== files.pin)
    throw new Error('SDK sample checkout is stale; its HEAD must match PINNED_COMMIT.txt.');
  if (git(['status', '--porcelain', '--untracked-files=normal']))
    throw new Error('SDK sample checkout must have clean source files.');
  if (!allowStale && !fs.existsSync(path.join(files.sample, sampleTree, 'WebAPIService.csproj')))
    throw new Error('SDK sparse sample library is missing.');
}

function checkPython(files, expected) {
  if (!fs.existsSync(files.python)) throw new Error('SDK CPython 3.13 venv missing. Run ci:prepare --sdk.');
  return JSON.parse(probe(files.python, ['-I', '-c', pythonInventory, JSON.stringify(expected)]));
}

/** Verify the owned public sample independently of the optional Python client fixture. */
export function requireSdkSample(root) {
  checkSample(layout(root));
}

export function requireSdkFixtures(root) {
  const files = layout(root);
  const expected = requirements(files);
  if (!fs.existsSync(files.receipt)) throw new Error('SDK preparation receipt missing. Run ci:prepare --sdk.');
  const receipt = JSON.parse(fs.readFileSync(files.receipt, 'utf8'));
  if (receipt.lock !== digest(files.lock) || receipt.direct !== digest(files.direct))
    throw new Error('SDK preparation receipt is stale. Run ci:prepare --sdk.');
  checkPython(files, expected);
  probe(files.python, ['-I', '-m', 'pip', 'check']);
  checkSample(files);
}

export async function prepareSdkFixtures({ root, execute }) {
  const files = layout(root);
  const expected = requirements(files);
  const run = async (command, args, options = {}) => {
    const result = await execute(command, args, { cwd: files.root, ...options });
    if (result?.error || result?.status !== 0) throw new Error(`SDK preparation failed: ${command} ${args[0]}`);
  };
  fs.mkdirSync(files.pythonDirectory, { recursive: true });
  fs.mkdirSync(path.join(files.directory, 'disabled-hooks'), { recursive: true });
  // An interrupted or failed preparation must revoke the previous success.
  fs.rmSync(files.receipt, { force: true });
  if (fs.existsSync(files.venv)) {
    try {
      checkPython(files, expected);
      probe(files.python, ['-I', '-m', 'pip', 'check']);
    } catch {
      // Recreate only this owned, resolved venv; never preserve stale packages or a wrong interpreter.
      layout(files.root);
      const resolved = fs.realpathSync.native(files.venv);
      const relative = path.relative(files.root, resolved);
      if (relative.startsWith('..') || path.isAbsolute(relative) || resolved !== files.venv)
        throw new Error('SDK venv repair must stay within the owned checkout folder.');
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
  if (!fs.existsSync(files.python)) {
    const candidates =
      process.platform === 'win32' ? [['py', '-3.13'], ['python']] : [['python3.13'], ['python3'], ['python']];
    let selected;
    for (const [command, ...prefix] of candidates) {
      try {
        probe(command, [
          ...prefix,
          '-I',
          '-c',
          "import platform,sys; assert platform.python_implementation()=='CPython' and sys.version_info[:2]==(3,13)",
        ]);
        selected = [command, ...prefix];
        break;
      } catch {
        /* Try the next installed interpreter; never download or build one. */
      }
    }
    if (!selected) throw new Error('SDK gates require installed CPython 3.13.');
    await run(selected[0], [...selected.slice(1), '-I', '-m', 'venv', files.venv]);
  }
  const pipEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^PIP_/i.test(name)));
  pipEnvironment.PIP_CONFIG_FILE = os.devNull;
  await run(
    files.python,
    [
      '-I',
      '-m',
      'pip',
      'install',
      '--require-hashes',
      '--only-binary=:all:',
      '--no-compile',
      '--disable-pip-version-check',
      '--index-url',
      'https://pypi.org/simple',
      '-r',
      files.lock,
    ],
    { env: pipEnvironment },
  );
  await run(files.python, ['-I', '-m', 'pip', 'check'], { env: pipEnvironment });
  const python = checkPython(files, expected);
  const git = (args) => run('git', gitArguments(files, args), { env: gitEnvironment() });
  if (!fs.existsSync(files.sample)) fs.mkdirSync(files.sample);
  let prepareCheckout = !fs.existsSync(path.join(files.sample, '.git'));
  if (prepareCheckout) {
    if (fs.readdirSync(files.sample).length)
      throw new Error('SDK sample fixture contains unrecognized files; preparation cannot replace them.');
    await git(['init']);
  } else {
    try {
      checkSample(files);
    } catch {
      // A clean older pin or interrupted fetch can resume; modified source is preserved and rejected.
      checkSample(files, { allowStale: true });
      prepareCheckout = true;
    }
  }
  if (prepareCheckout) {
    await git(['config', '--local', 'remote.origin.url', sampleRemote]);
    await git(['sparse-checkout', 'init', '--cone']);
    await git(['sparse-checkout', 'set', sampleTree]);
    await git(['fetch', '--depth=1', '--filter=blob:none', '--no-recurse-submodules', 'origin', files.pin]);
    await git(['checkout', '--detach', files.pin]);
  }
  checkSample(files);
  await run('dotnet', ['restore', files.project, '--locked-mode', '--disable-build-servers']);
  checkSample(files);
  fs.writeFileSync(
    files.receipt,
    JSON.stringify({ lock: digest(files.lock), direct: digest(files.direct), python }, null, 2) + '\n',
  );
  requireSdkFixtures(files.root);
}
