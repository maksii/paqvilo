// Review-only analysis: tools never execute source, remove code, or contact portal references.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { readLocalFileSync } from '../lense/local-file.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const tools = {
  knip: path.join(root, 'node_modules/knip/bin/knip.js'),
  jscpd: path.join(root, 'node_modules/jscpd/run-jscpd.js'),
};
const baselineFile = path.join(root, 'scripts/code-review-baseline.json');
const nativePath = (file) => {
  const real = fs.realpathSync.native(file);
  // Native Windows paths may use a device prefix; UNC roots keep both leading slashes.
  return real.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
};
const normalize = (file, directory) => path.relative(nativePath(directory), nativePath(file)).replaceAll('\\', '/');
const MAX_REVIEW_BYTES = 5 * 1024 * 1024;
const PRIVATE_SEGMENTS = new Set(['node_modules', '.git', '.paqvilo', '.claude', '.codex', 'obj', 'out', 'dist']);
const privateSegment = (part) => PRIVATE_SEGMENTS.has(process.platform === 'win32' ? part.toLowerCase() : part);
const MODELED_SOURCE = /\.(?:[cm]?[jt]sx?|css|cs|py)$/;

/** Validate every component, including Git-indexed ancestors that may have become junctions. */
function reviewSource(directory, file) {
  const root = nativePath(directory),
    source = path.resolve(root, file),
    relative = path.relative(root, source);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error(`Review source escapes its workspace: ${file}`);
  const parts = relative.split(path.sep);
  if (parts.some(privateSegment)) throw new Error(`Review source enters an excluded directory: ${relative}`);
  let current = root,
    stat;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Review source uses a linked path: ${relative}`);
  }
  if (!stat.isFile()) return null;
  if (stat.size > MAX_REVIEW_BYTES) {
    if (MODELED_SOURCE.test(relative)) throw new Error(`Review source exceeds the 5 MiB limit: ${relative}`);
    return null;
  }
  const expected = path.resolve(root, relative),
    real = nativePath(source);
  const key = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  if (key(real) !== key(expected)) throw new Error(`Review source uses a linked path: ${relative}`);
  return { source, real };
}

function reviewBytes(directory, file) {
  const checked = reviewSource(directory, file);
  if (!checked) return null;
  const bytes = readLocalFileSync(checked.real, {
    root: nativePath(directory),
    maxBytes: MAX_REVIEW_BYTES,
    expectedRealPath: checked.real,
  });
  reviewSource(directory, file);
  return bytes;
}

export function publicApiOrigins(directory) {
  directory = nativePath(directory);
  const manifest = JSON.parse(reviewBytes(directory, 'package.json').toString('utf8'));
  const cache = new Map();
  function exportsOf(file) {
    file = path.resolve(file);
    if (cache.has(file)) return cache.get(file);
    const result = new Map();
    cache.set(file, result);
    const bytes = reviewBytes(directory, file);
    if (!bytes) return result;
    const source = bytes.toString('utf8');
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const own = (name) => `${normalize(file, directory)}:${name}`;
    const imports = new Map();
    for (const statement of tree.statements) {
      if (ts.isImportDeclaration(statement) && statement.moduleSpecifier.text.startsWith('.')) {
        const target = path.resolve(path.dirname(file), statement.moduleSpecifier.text);
        for (const specifier of statement.importClause?.namedBindings?.elements ?? [])
          imports.set(specifier.name.text, { target, name: (specifier.propertyName ?? specifier.name).text });
      }
      if (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        if (statement.name?.text) result.set(statement.name.text, [own(statement.name.text)]);
        if (ts.isVariableStatement(statement))
          for (const declaration of statement.declarationList.declarations)
            if (ts.isIdentifier(declaration.name)) result.set(declaration.name.text, [own(declaration.name.text)]);
      }
    }
    for (const statement of tree.statements) {
      if (!ts.isExportDeclaration(statement)) continue;
      const target = statement.moduleSpecifier?.text.startsWith('.')
        ? path.resolve(path.dirname(file), statement.moduleSpecifier.text)
        : null;
      if (!statement.exportClause && target) {
        for (const [name, origins] of exportsOf(target)) result.set(name, [own(name), ...origins]);
      } else if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const specifier of statement.exportClause.elements) {
          const name = specifier.name.text,
            original = (specifier.propertyName ?? specifier.name).text;
          const imported = imports.get(original);
          const origins = target
            ? exportsOf(target).get(original)
            : imported
              ? exportsOf(imported.target).get(imported.name)
              : result.get(original);
          result.set(name, [own(name), ...(origins ?? [])]);
        }
      }
    }
    return result;
  }
  const origins = new Set();
  for (const [entry, target] of Object.entries(manifest.exports ?? {})) {
    if (entry.includes('*') || typeof target !== 'string' || !/\.[cm]?js$/.test(target)) continue;
    for (const values of exportsOf(path.resolve(directory, target)).values())
      for (const value of values) origins.add(value);
  }
  return origins;
}

const toolOptions = (cwd, env) => ({
  cwd,
  env: { ...process.env, ...env },
  encoding: 'utf8',
  windowsHide: true,
  maxBuffer: 32 * 1024 * 1024,
  timeout: 180_000,
});

function invoke(name, args, cwd, env = {}) {
  const result = spawnSync(process.execPath, [tools[name], ...args], toolOptions(cwd, env));
  if (result.error || result.status !== 0)
    throw new Error(`${name} analysis failed: ${result.error?.message ?? result.stderr ?? result.status}`);
  return result.stdout;
}

const invokeAsync = (name, args, cwd, env = {}) =>
  new Promise((resolve, reject) =>
    execFile(process.execPath, [tools[name], ...args], toolOptions(cwd, env), (error, stdout, stderr) => {
      // A non-zero exit reports the tool's own diagnostics, as invoke() does.
      if (error)
        reject(
          new Error(
            `${name} analysis failed: ${typeof error.code === 'number' && !error.killed ? stderr : error.message}`,
          ),
        );
      else resolve(stdout);
    }),
  );

function reviewFiles(directory) {
  directory = nativePath(directory);
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: directory,
    encoding: 'utf8',
    windowsHide: true,
  });
  const samePath = (a, b) => {
    const left = nativePath(a),
      right = nativePath(b);
    return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
  };
  if (top.status === 0 && samePath(directory, top.stdout.trim())) {
    const listing = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: directory,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (listing.status !== 0) throw new Error('Cannot inventory tracked review sources.');
    return [...new Set(listing.stdout.split('\0').filter(Boolean))];
  }
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (privateSegment(entry.name) || entry.isSymbolicLink()) continue;
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files.push(path.relative(directory, file).replaceAll('\\', '/'));
    }
  };
  walk(directory);
  return files;
}

function analysisSnapshot(directory, { files, dependencies = true } = {}) {
  directory = nativePath(directory);
  const snapshot = nativePath(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-knip-')));
  try {
    for (const name of files ?? reviewFiles(directory)) {
      if (!/\.(?:[cm]?[jt]sx?|json|html|css|ya?ml|cs|py)$/.test(name) || name.split(/[\\/]/).some(privateSegment))
        continue;
      const destination = path.resolve(snapshot, name);
      if (!destination.startsWith(snapshot + path.sep)) throw new Error(`Review source escapes its workspace: ${name}`);
      const bytes = reviewBytes(directory, name);
      if (!bytes) continue;
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      if (path.basename(name) === 'package.json') {
        const manifest = JSON.parse(bytes.toString('utf8'));
        if (manifest.exports && typeof manifest.exports === 'object' && !Array.isArray(manifest.exports))
          manifest.exports = Object.fromEntries(Object.entries(manifest.exports).filter(([key]) => !key.includes('*')));
        fs.writeFileSync(destination, JSON.stringify(manifest));
      } else fs.writeFileSync(destination, bytes);
    }
    const modules = path.join(directory, 'node_modules');
    if (dependencies && fs.existsSync(modules))
      fs.symlinkSync(modules, path.join(snapshot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    return snapshot;
  } catch (error) {
    fs.rmSync(snapshot, { recursive: true, force: true });
    throw error;
  }
}

const deadCodeRun = (snapshot, config, scope) => [
  'knip',
  [
    '--directory',
    snapshot,
    '--config',
    config,
    '--reporter',
    'json',
    '--include',
    'files,exports,nsExports,unresolved',
    '--no-progress',
    '--no-config-hints',
    '--no-exit-code',
    '--no-gitignore',
    ...(scope === 'runtime' ? ['--production'] : []),
  ],
  snapshot,
  { PAQVILO_REVIEW_SCOPE: scope },
];

export function inspectDeadCode(directory, config, scope = 'full') {
  // Knip promotes package wildcard targets to entries. Only the analysis manifest
  // omits unsupported wildcard roots; real source and dependencies stay untouched.
  const snapshot = analysisSnapshot(directory);
  let stdout;
  try {
    stdout = invoke(...deadCodeRun(snapshot, config, scope));
  } finally {
    fs.rmSync(snapshot, { recursive: true, force: true });
  }
  return deadCodeFindings(stdout, scope, () => publicApiOrigins(directory));
}

function deadCodeFindings(stdout, scope, publicOrigins) {
  const report = JSON.parse(stdout);
  if (!Array.isArray(report.issues)) throw new Error('Knip returned no issue inventory.');
  const publicNames = publicOrigins();
  const findings = [];
  for (const issue of report.issues) {
    for (const type of ['files', 'exports', 'nsExports', 'unresolved']) {
      for (const value of issue[type] ?? []) {
        const name = typeof value === 'string' ? value : value.name;
        if (['exports', 'nsExports'].includes(type) && publicNames.has(`${issue.file.replaceAll('\\', '/')}:${name}`))
          continue;
        findings.push({
          key: `${scope}:${type}:${issue.file.replaceAll('\\', '/')}:${typeof value === 'string' ? value : value.name}`,
          file: issue.file,
          type,
          name: typeof value === 'string' ? value : value.name,
        });
      }
    }
  }
  return findings;
}

// jscpd reads only the listed files, so one snapshot holding them (and more) serves every scope.
function cloneRun(snapshot, files, output) {
  fs.mkdirSync(output, { recursive: true });
  const config = path.join(output, 'config.json');
  fs.writeFileSync(
    config,
    JSON.stringify({
      path: files.map((file) => path.resolve(snapshot, file)),
      format: ['javascript', 'typescript', 'css', 'csharp', 'python'],
      minTokens: 100,
      minLines: 10,
      mode: 'mild',
      maxSize: '5mb',
      reporters: ['json'],
      output,
      absolute: true,
    }),
  );
  return ['jscpd', ['--config', config, '--fail-on-empty', '--no-tips'], snapshot];
}

function cloneFindings(directory, snapshot, output) {
  const report = JSON.parse(fs.readFileSync(path.join(output, 'jscpd-report.json'), 'utf8'));
  if (!Array.isArray(report.duplicates)) throw new Error('jscpd returned no clone inventory.');
  const findings = report.duplicates.map((clone) => {
    const pair = [clone.firstFile, clone.secondFile].map((file) => normalize(file.name, snapshot)).sort();
    const hash = createHash('sha256').update(clone.fragment.replaceAll('\r\n', '\n')).digest('hex');
    return { key: `${pair.join('|')}:${hash}`, files: pair, lines: clone.lines };
  });
  for (const clone of report.duplicates) {
    for (const file of [clone.firstFile, clone.secondFile]) {
      const relative = normalize(file.name, snapshot);
      if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative))
        throw new Error('Clone report source escaped its analysis snapshot.');
      file.name = path.resolve(directory, relative);
    }
  }
  fs.writeFileSync(path.join(output, 'jscpd-report.json'), JSON.stringify(report, null, 2) + '\n');
  return findings;
}

export function inspectClones(directory, files, output) {
  directory = nativePath(directory);
  const snapshot = analysisSnapshot(directory, { files, dependencies: false });
  try {
    invoke(...cloneRun(snapshot, files, output));
    return cloneFindings(directory, snapshot, output);
  } finally {
    fs.rmSync(snapshot, { recursive: true, force: true });
  }
}

function sourceFiles(directory) {
  directory = nativePath(directory);
  return reviewFiles(directory).filter(
    (file) =>
      !/(?:^|\/)(?:fixtures|generated|node_modules|obj|out|bin\/Release|\.paqvilo|\.claude|\.codex)(?:\/|$)/.test(
        file,
      ) && Boolean(reviewSource(directory, file)),
  );
}

export function reviewInventory(directory = root) {
  const files = sourceFiles(directory);
  return {
    runtime: files.filter(
      (file) =>
        /^(?:bin|lense|mirage)\//.test(file) &&
        !/^mirage\/test[^/]*(?:\/|\.)/.test(file) &&
        /\.(?:mjs|js|css)$/.test(file),
    ),
    tests: files.filter(
      (file) =>
        /^(?:test|test-browser|mirage\/test[^/]*|examples\/(?:project|company-operations)\/(?:test[^/]*|portal-harness))\//.test(
          file,
        ) && /\.(?:mjs|js|cs|py)$/.test(file),
    ),
    support: files.filter(
      (file) =>
        /^(?:scripts|\.github\/scripts|examples\/project\/(?:components|pack)|examples\/company-operations\/(?:plugins|forms|generators))\//.test(
          file,
        ) &&
        !/(?:^|\/)test[^/]*\//.test(file) &&
        /\.(?:mjs|js|ts|cs|py)$/.test(file),
    ),
  };
}

export function compareReview(actual, baseline) {
  // Consume accepted occurrences: another copy of an already-known fragment
  // between the same file pair is still new duplication requiring review.
  const accepted = new Map();
  for (const item of baseline) accepted.set(item.key, (accepted.get(item.key) ?? 0) + 1);
  return actual.filter((item) => {
    const remaining = accepted.get(item.key) ?? 0;
    if (!remaining) return true;
    accepted.set(item.key, remaining - 1);
    return false;
  });
}

function reviewedReason(item) {
  if (item.type === 'unresolved' || (item.key.startsWith('full:') && item.type === 'files'))
    throw new Error(`Resolve this finding before baselining: ${item.key}`);
  if (item.type === 'clone') {
    if (item.key.startsWith('tests:'))
      return 'Independent scenario assertions and invented protocol fixtures; behavior and failure evidence stay in each suite.';
    if (item.key.startsWith('support:'))
      return 'Independent example controls, manifests, build and qualification contracts; sharing stops at the owning example package.';
    const files = item.files.join('|');
    if (/jquery|bootstrap-plugins-compat|datetimepicker-compat/.test(files))
      return 'Generated standalone jQuery watcher; one authored fragment is enforced by generate-compat-watchers --check.';
    if (/platform-chrome/.test(files))
      return 'Two supported standalone CSS URLs; standalone-style-contract tests require the shared prefix and accessibility rules.';
    if (/liquid-resx/.test(files))
      return 'Independent culture keys retain native locale identity even when translations coincide.';
    if (/dataverse-operation-contracts/.test(files))
      return 'Separate operation/type schema identities; matching parameter shapes are declarative protocol data.';
    if (/dataverse-solution-messages/.test(files))
      return 'Separate solution operations retain dependency direction, message names and wire contracts.';
    if (/dataverse-(?:app|calendar|org)-messages/.test(files))
      return 'Local write/transaction wrappers retain operation-specific response and privilege policy; pure context/read mechanics are shared.';
    if (/dataverse-fls|dataverse-security/.test(files))
      return 'Security schema initializers differ in alternate keys and grant seeding; policies remain distinct.';
    if (/crmentityformview-compat|xrm-webform-compat/.test(files))
      return 'Independent form adapters retain distinct dirty prompts and class-matching semantics.';
    throw new Error(`A new runtime clone requires an explicit disposition: ${item.key}`);
  }
  if (item.key.startsWith('runtime:')) {
    if (
      item.type === 'files' &&
      !/^mirage\/testing\/(?:amqp-fake-broker|azurite-fake|owned-fixture)\.mjs$/.test(item.file)
    )
      throw new Error(`A runtime orphan requires review: ${item.key}`);
    return item.type === 'files'
      ? 'Invented protocol/ownership test support, consumed by the full test graph; intentionally absent from product entry traversal.'
      : 'Full unit/browser/SDK graph consumes this exported test seam; runtime-only traversal intentionally excludes those consumers.';
  }
  if (item.type === 'nsExports' && item.file === 'mirage/admin/dashboard-icons.mjs' && item.name === 'icon')
    return 'Namespace passed from both admin and setup apps to dashboard-map, which calls icons.icon; static namespace analysis loses this argument boundary.';
  throw new Error(`An unused full-graph export requires review: ${item.key}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => !['--write-baseline', '--check'].includes(arg)))
    throw new Error('Use --check or --write-baseline.');
  const output = path.join(root, '.paqvilo/code-review');
  fs.mkdirSync(output, { recursive: true });
  const findings = [];
  // The five analyses read one shared snapshot concurrently instead of copying the checkout five times.
  const config = path.join(root, 'scripts/code-review.config.mjs');
  const inventory = Object.entries(reviewInventory());
  const snapshot = analysisSnapshot(root);
  let results;
  try {
    let origins;
    const publicOrigins = () => (origins ??= publicApiOrigins(root));
    results = await Promise.allSettled([
      ...['runtime', 'full'].map(async (scope) =>
        deadCodeFindings(await invokeAsync(...deadCodeRun(snapshot, config, scope)), scope, publicOrigins),
      ),
      ...inventory.map(async ([scope, files]) => {
        await invokeAsync(...cloneRun(snapshot, files, path.join(output, scope)));
        return cloneFindings(root, snapshot, path.join(output, scope));
      }),
    ]);
  } finally {
    fs.rmSync(snapshot, { recursive: true, force: true });
  }
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
  const [runtime, full, ...clones] = results.map((result) => result.value);
  for (const [scope, dead] of [
    ['runtime', runtime],
    ['full', full],
  ]) {
    findings.push(...dead);
    console.log(`Dead-code ${scope}: ${dead.length} findings reviewed against baseline.`);
  }
  for (const [index, [scope, files]] of inventory.entries()) {
    findings.push(...clones[index].map((clone) => ({ ...clone, key: `${scope}:clone:${clone.key}`, type: 'clone' })));
    console.log(`Clone ${scope}: ${files.length} files, ${clones[index].length} blocks reviewed against baseline.`);
  }
  findings.sort((a, b) => a.key.localeCompare(b.key));
  fs.writeFileSync(path.join(output, 'findings.json'), JSON.stringify(findings, null, 2) + '\n');
  if (args.includes('--write-baseline')) {
    fs.writeFileSync(
      baselineFile,
      JSON.stringify(
        {
          version: 1,
          policy:
            'Reviewed compatibility, declarative contracts, independent test assertions and standalone distribution copies. Baseline changes require human review; CI never fixes source or refreshes this file.',
          findings: findings.map((item) => ({
            ...item,
            reason: reviewedReason(item),
          })),
        },
        null,
        2,
      ) + '\n',
    );
    console.log('Wrote review baseline; inspect every added disposition before committing.');
    return;
  }
  const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  const added = compareReview(findings, baseline.findings);
  if (added.length) throw new Error(`New review findings:\n${added.map((item) => item.key).join('\n')}`);
  console.log('Dead-code and clone review passed.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
