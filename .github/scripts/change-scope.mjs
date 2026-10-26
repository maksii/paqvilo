import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const toolkitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoots = [
  'bin',
  'lense',
  'mirage',
  'test',
  'test-browser',
  'examples/project',
  'examples/company-operations',
];
const secondary =
  /^(?:docs\/|site\/|mirage\/(?:README\.md$|docs\/)|examples\/(?:project|company-operations)\/(?:[^/]+\/)*README\.md$|(?:README\.md|AGENTS\.md|CONTRIBUTING\.md|SECURITY\.md|CODE_OF_CONDUCT\.md|LICENSE|NOTICE)$|\.github\/(?:ISSUE_TEMPLATE\/|DISCUSSION_TEMPLATE\/|PULL_REQUEST_TEMPLATE\.md$|CODEOWNERS$|release\.yml$|workflows\/pages\.yml$))/;
// These files execute only inside the Lense overlay. The development CLI imports them to
// launch an overlay from Mirage, but that import does not make them simulation runtime code.
const overlayPresentation = new Set([
  'lense/panel-ui.mjs',
  'lense/model-driven-actions-ui.mjs',
  'lense/model-driven-inspector-ui.mjs',
  'lense/xray-ui.mjs',
]);

// Literal references only expand a suite selection; they never authorize skipping an unknown path.
// Tests and package self-imports are included so a cross-tool integration test selects its suite too.
// Besides imports, any quoted relative path counts: tests read documents and fixtures and spawn
// CLIs through `new URL('../x', import.meta.url)`, and a directory reference covers its contents.
// A template such as `../mirage/${tool}.mjs` references every matching file in that directory.
export function dependencyConsumers(root = toolkitRoot) {
  const reverse = new Map();
  const templates = [];
  const pkg = fs.existsSync(path.join(root, 'package.json'))
    ? JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    : {};
  const add = (dependency, consumer) => {
    const name = path.relative(root, dependency).replaceAll('\\', '/');
    if (name.startsWith('../') || path.isAbsolute(name)) return;
    if (!reverse.has(name)) reverse.set(name, new Set());
    reverse.get(name).add(consumer);
  };
  function resolveSelf(specifier) {
    if (!specifier.startsWith(`${pkg.name}/`)) return null;
    const key = `.${specifier.slice(pkg.name.length)}`;
    const exact = pkg.exports?.[key];
    if (typeof exact === 'string') return path.resolve(root, exact);
    for (const [pattern, target] of Object.entries(pkg.exports ?? {})) {
      if (!pattern.endsWith('/*') || typeof target !== 'string' || !key.startsWith(pattern.slice(0, -1))) continue;
      return path.resolve(
        root,
        target.replaceAll('*', () => key.slice(pattern.length - 1)),
      );
    }
    return null;
  }
  const visit = (directory) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || ['node_modules', '.git', '.paqvilo', 'bin', 'obj', 'out'].includes(entry.name))
        continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (/\.[cm]?js$/.test(entry.name)) {
        const consumer = path.relative(root, file).replaceAll('\\', '/');
        const source = fs.readFileSync(file, 'utf8');
        for (const match of source.matchAll(
          /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g,
        )) {
          const resolved = resolveSelf(match[1]);
          if (resolved) add(resolved, consumer);
        }
        // A bare './' or '../' is usually a URL, not a reference to every sibling file.
        for (const match of source.matchAll(/(['"`])(\.\.?\/(?:\.\.\/)*[^'"`$\n./][^'"`$\n]*)\1/g))
          add(path.resolve(path.dirname(file), match[2]), consumer);
        for (const match of source.matchAll(/`(\.\.?\/[^`$\n]*\/)\$\{[^}`]*\}([^`$/\n]*)`/g)) {
          const directory = path.relative(root, path.resolve(path.dirname(file), match[1])).replaceAll('\\', '/');
          if (!directory.startsWith('../')) templates.push({ directory, suffix: match[2], consumer });
        }
      }
    }
  };
  for (const directory of sourceRoots) visit(path.join(root, directory));
  return {
    // A changed file is consumed through its own path, any referenced ancestor directory or a template.
    get(file) {
      const consumers = new Set(reverse.get(file));
      for (let parent = path.posix.dirname(file); parent !== '.'; parent = path.posix.dirname(parent))
        for (const consumer of reverse.get(parent) ?? []) consumers.add(consumer);
      for (const { directory, suffix, consumer } of templates)
        if (path.posix.dirname(file) === directory && file.endsWith(suffix)) consumers.add(consumer);
      return consumers;
    },
  };
}

function initialScope() {
  return {
    runtime: false,
    package: false,
    dependencies: false,
    quality: false,
    lense: false,
    mirage: false,
    examples: false,
    smoke: false,
    site: false,
    full: false,
    // Required code-scanning comparisons need the same configurations as main,
    // including PRs that change only documentation or one source language.
    codeql: true,
    languages: JSON.stringify(['actions', 'csharp', 'javascript-typescript']),
  };
}

export function classifyChanges(files, { root = toolkitRoot, full = false } = {}) {
  const scope = initialScope();
  scope.quality = files.length > 0;
  scope.package = files.some((file) => !/^(?:site\/|\.github\/|SECURITY\.md$|CODE_OF_CONDUCT\.md$)/.test(file));
  scope.dependencies = files.some((file) =>
    /(?:^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|packages\.lock\.json|[^/]+\.csproj)$/.test(file),
  );
  scope.site = files.some((file) =>
    /^(?:site\/|docs\/assets\/|scripts\/build-site\.mjs$|\.github\/workflows\/pages\.yml$)/.test(file),
  );
  scope.smoke = files.some((file) =>
    /^(?:bin\/|lense\/(?:api|cli|project-scaffold|project-editor)\.mjs$|mirage\/(?:api|cli|acceptance-api|testing|fixtures|packs)\.mjs$)/.test(
      file,
    ),
  );
  let reverse;
  const expand = (file) => {
    reverse ??= dependencyConsumers(root);
    const pending = [file],
      seen = new Set();
    while (pending.length) {
      const current = pending.pop();
      if (seen.has(current)) continue;
      seen.add(current);
      if (/^(?:lense|test|test-browser)\//.test(current)) scope.lense = true;
      if (/^mirage\//.test(current)) scope.mirage = true;
      if (/^examples\//.test(current)) scope.examples = true;
      for (const consumer of reverse.get(current) ?? []) pending.push(consumer);
    }
  };
  for (const file of files) {
    if (secondary.test(file)) {
      // A document that a test reads, such as a settings table, still selects that suite.
      reverse ??= dependencyConsumers(root);
      if (!reverse.get(file).size) continue;
      scope.runtime = true;
      expand(file);
      continue;
    }
    scope.runtime = true;
    if (overlayPresentation.has(file)) {
      scope.lense = true;
      continue;
    }
    if (/^(?:lense|test|test-browser|mirage)\//.test(file) && !/(?:^|\/)package(?:-lock)?\.json$/.test(file)) {
      expand(file);
      // These browser modules are also served through URL mappings, not only filesystem imports.
      if (/^(?:lense\/setup\/|mirage\/admin\/)/.test(file)) scope.lense = scope.mirage = true;
    } else {
      // Dependencies, templates, build/workflow changes and new paths remain shared until classified.
      scope.lense = scope.mirage = scope.examples = scope.smoke = true;
    }
  }
  if (scope.dependencies) scope.lense = scope.mirage = scope.examples = scope.smoke = scope.runtime = true;
  if (full) {
    for (const name of [
      'runtime',
      'package',
      'dependencies',
      'quality',
      'lense',
      'mirage',
      'examples',
      'smoke',
      'site',
      'full',
    ])
      scope[name] = true;
  }
  return scope;
}

export function suitesForScope(scope) {
  return ['lense', 'mirage', 'examples'].filter((suite) => scope[suite]);
}

// CI splits the longest suites into node:test file shards (ci.mjs --shard); together the shards
// run every file once, and the CI gate requires every leg. Local validation runs whole suites.
// Lense stays whole: one long file (mirage-stop-scope) bounds its wall time either way.
const SHARDS = { unit: { mirage: 3 }, browser: { mirage: 2 } };
export function ciLanes(kind, suites) {
  return suites.flatMap((suite) => {
    const total = SHARDS[kind][suite] ?? 1;
    if (total === 1) return [{ suite }];
    return Array.from({ length: total }, (_, index) => ({ suite, shard: `${index + 1}/${total}` }));
  });
}

export function preCommitScripts(files) {
  // Commits give fast deterministic feedback; full validation remains explicit and runs for main/releases.
  const scope = classifyChanges(files);
  return [
    ...(scope.quality ? ['quality'] : []),
    ...(scope.package ? ['release:check'] : []),
    ...(scope.site ? ['site:build'] : []),
  ];
}

export function githubScope(event, eventName, env = process.env, root = toolkitRoot) {
  const full =
    env.VALIDATE_ALL === 'true' ||
    (eventName === 'workflow_dispatch' && event.inputs?.full !== false && event.inputs?.full !== 'false') ||
    eventName === 'schedule' ||
    (eventName === 'push' && env.GITHUB_REF === 'refs/heads/main');
  if (full) return classifyChanges([], { root, full: true });
  const base = event.pull_request?.base.sha ?? event.before;
  const head = event.pull_request?.head.sha ?? env.GITHUB_SHA;
  if (!base || /^0+$/.test(base) || !head) return classifyChanges([], { root, full: true });
  const revisions = event.pull_request ? [`${base}...${head}`] : [base, head];
  const diff = spawnSync(
    'git',
    ['--no-optional-locks', 'diff', '--name-only', '--no-renames', '-z', ...revisions, '--'],
    {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  if (diff.status !== 0) throw new Error('Cannot determine changed files; refusing to skip validation.');
  return classifyChanges(diff.stdout.split('\0').filter(Boolean), { root });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const scope = githubScope(event, process.env.GITHUB_EVENT_NAME, process.env, process.cwd());
  const suites = suitesForScope(scope);
  const outputs = {
    ...scope,
    suites: JSON.stringify(suites.length ? suites : ['none']),
    units: JSON.stringify(suites.length ? ciLanes('unit', suites) : [{ suite: 'none' }]),
    browsers: JSON.stringify(suites.length ? ciLanes('browser', suites) : [{ suite: 'none' }]),
  };
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(outputs)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(''),
  );
  console.log(JSON.stringify(scope));
}
