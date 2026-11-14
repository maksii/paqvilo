// Approximates the SonarQube rule profile for a change before it is pushed. Every JavaScript source and test file that
// differs between the merge base and the working tree (untracked files included) is linted with the
// eslint-plugin-sonarjs recommended rules whose SonarJS scope covers it: the scope each rule declares in the package's
// generated metadata (Main for sources, Tests for test files, All for both), as the server applies a rule only to the
// files of its scope. Sources also get the eslint-plugin-unicorn rules and the typed promise and optional-chain rules
// that matched server findings on sources. Only findings that exist in the current version alone are reported; the
// base version (the renamed-from path for a rename) is linted only when the current version has findings. A finding is
// keyed by its rule and the trimmed text of its line, so a moved line is not new. A line carrying NOSONAR is skipped,
// as the server skips it. Rules that need the server's data-flow analysis have no ESLint counterpart and stay
// server-only.
//   node scripts/sonar-rules.mjs [--base <rev>]   the repository of the working directory against <rev> (merge base;
//                                                 default origin/main)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ESLint } from 'eslint';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';
import tseslint from 'typescript-eslint';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const SCRIPT = /\.(?:mjs|cjs|js)$/;
const UNICORN_RULES = [
  'no-useless-spread',
  'prefer-string-raw',
  'prefer-set-has',
  'prefer-number-properties',
  'prefer-array-find',
  'prefer-dom-node-dataset',
  'catch-error-name',
  'prefer-top-level-await',
];

/** The SonarJS key (S<number>) of a sonarjs rule, from its documentation link; undefined for other plugins. */
const sonarKey = (name) =>
  name.startsWith('sonarjs/')
    ? /\/(S\d+)\//.exec(sonarjs.rules[name.slice('sonarjs/'.length)]?.meta?.docs?.url ?? '')?.[1]
    : undefined;

/** The recommended sonarjs rules whose SonarJS scope covers `scope` ('Main' or 'Tests'), less the excluded ones. */
function sonarjsRules(scope) {
  return Object.fromEntries(
    Object.entries(sonarjs.configs.recommended.rules).filter(([name]) => {
      const key = sonarKey(name);
      if (!key) throw new Error(`No SonarJS rule key for ${name}.`);
      const declared = require(`eslint-plugin-sonarjs/cjs/${key}/generated-meta.js`).scope;
      if (!['Main', 'Tests', 'All'].includes(declared)) throw new Error(`Unknown scope ${declared} of ${name}.`);
      return declared === scope || declared === 'All';
    }),
  );
}

/** The test inclusions, exclusions and ignored rule/file pairs of sonar-project.properties. */
function sonarScope() {
  const text = fs.readFileSync(path.join(root, 'sonar-project.properties'), 'utf8').replaceAll(/\\\r?\n\s*/g, '');
  const value = (key) =>
    text
      .split(/\r?\n/)
      .find((line) => line.startsWith(`${key}=`))
      ?.slice(key.length + 1) ?? '';
  const list = (key) =>
    value(key)
      .split(',')
      .map((glob) => glob.trim())
      .filter(Boolean);
  const criteria = 'sonar.issue.ignore.multicriteria';
  return {
    tests: list('sonar.test.inclusions'),
    exclusions: list('sonar.exclusions'),
    ignored: list(criteria).map((id) => ({
      rule: value(`${criteria}.${id}.ruleKey`).replace(/^javascript:/, ''),
      resource: value(`${criteria}.${id}.resourceKey`),
    })),
  };
}

function git(cwd, args, { allowFailure = false } = {}) {
  /* NOSONAR */ const result = spawnSync('git', ['--no-optional-locks', ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status === 0) return result.stdout;
  if (allowFailure) return null;
  throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.error?.message || '').trim()}`);
}

/** The texts of `<rev>:<path>` objects, read by one git cat-file process; null for an object that does not exist. */
function baseTexts(cwd, objects) {
  if (!objects.length) return [];
  /* NOSONAR */ const result = spawnSync('git', ['--no-optional-locks', 'cat-file', '--batch'], {
    cwd,
    input: objects.join('\n') + '\n',
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`git cat-file failed: ${String(result.stderr).trim()}`);
  const output = result.stdout;
  let offset = 0;
  return objects.map(() => {
    const end = output.indexOf(10, offset);
    const header = output.toString('utf8', offset, end).split(' ');
    offset = end + 1;
    if (header[1] !== 'blob') return null;
    const size = Number(header[2]);
    offset += size + 1;
    return output.toString('utf8', offset - size - 1, offset - 1);
  });
}

/** Changed paths against the merge base, each with the path it had there: renames keep their history. */
function changedPaths(cwd, mergeBase) {
  const fields = git(cwd, ['diff', '--name-status', '-M', '--diff-filter=AMR', '-z', mergeBase, '--']).split('\0');
  const paths = new Map();
  for (let index = 0; index < fields.length - 1;) {
    const status = fields[index];
    if (status.startsWith('R')) {
      paths.set(fields[index + 2], fields[index + 1]);
      index += 3;
    } else {
      paths.set(fields[index + 1], status === 'A' ? null : fields[index + 1]);
      index += 2;
    }
  }
  for (const file of git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean))
    paths.set(file, null);
  return paths;
}

// Directory depths a changed file may sit at, for the typed rules' default project (typescript-eslint refuses `**`).
const DEPTHS = Array.from({ length: 12 }, (_, depth) => `${'*/'.repeat(depth)}*.{mjs,cjs,js}`);

/** ESLint options of one rule profile: 'tests', 'main' or 'typed'. Lint workers read them from this module. */
function lintOptions(cwd, profile) {
  const rules = {
    tests: () => sonarjsRules('Tests'),
    main: () => ({
      ...sonarjsRules('Main'),
      ...Object.fromEntries(UNICORN_RULES.map((rule) => [`unicorn/${rule}`, 'error'])),
    }),
    typed: () => ({
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',
    }),
  }[profile]();
  return {
    cwd,
    overrideConfigFile: true,
    warnIgnored: false,
    concurrency: 'auto',
    overrideConfig: [
      {
        files: ['**/*.mjs', '**/*.cjs', '**/*.js'],
        // The server does not read eslint-disable comments.
        linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'off' },
        languageOptions: {
          ecmaVersion: 'latest',
          sourceType: 'module',
          ...(profile === 'typed' && {
            parser: tseslint.parser,
            parserOptions: {
              projectService: {
                // The compiler settings of a changed file that no tsconfig.json covers.
                defaultProject: path.join(root, 'scripts/sonar-rules.tsconfig.json'),
                allowDefaultProject: DEPTHS,
                maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: Number.MAX_SAFE_INTEGER,
              },
              tsconfigRootDir: cwd,
            },
          }),
        },
        plugins: { sonarjs, unicorn, '@typescript-eslint': tseslint.plugin },
        rules,
      },
    ],
  };
}

const profile = new URL(import.meta.url).searchParams.get('profile');
export default profile ? lintOptions(process.cwd(), profile) : null;

// Without its rule id a message is the inline-configuration notice; a parse failure is kept.
const reported = (messages) => messages.filter((message) => message.ruleId || message.fatal);

/** Findings in `after` that `before` does not have, matched by rule and trimmed line text. */
function newFindings(beforeMessages, before, afterMessages, after) {
  const key = (message, lines) => `${message.ruleId}|${(lines[message.line - 1] ?? '').trim()}`;
  const beforeLines = (before ?? '').split(/\r?\n/),
    afterLines = after.split(/\r?\n/);
  const old = new Map();
  for (const message of beforeMessages) {
    const id = key(message, beforeLines);
    old.set(id, (old.get(id) ?? 0) + 1);
  }
  return afterMessages.filter((message) => {
    if ((afterLines[message.line - 1] ?? '').includes('NOSONAR')) return false;
    const id = key(message, afterLines),
      left = old.get(id) ?? 0;
    if (left) old.set(id, left - 1);
    return !left;
  });
}

/** The changed JavaScript files of `cwd` against `mergeBase` that SonarQube analyses, with both versions' text. */
function changedFiles(cwd, mergeBase, scope) {
  const matches = (file, globs) => globs.some((glob) => path.matchesGlob(file, glob));
  const changed = [...changedPaths(cwd, mergeBase)]
    .filter(([file]) => SCRIPT.test(file))
    .map(([file, previous]) => ({ file, previous, test: matches(file, scope.tests) }))
    .filter(({ file, test }) => test || !matches(file, scope.exclusions));
  const bases = baseTexts(
    cwd,
    changed.filter(({ previous }) => previous).map(({ previous }) => `${mergeBase}:${previous}`),
  );
  const files = [];
  for (const { file, previous, test } of changed) {
    const after = fs.readFileSync(path.join(cwd, file), 'utf8');
    const before = previous ? bases.shift() : null;
    // A rename or mode change with the same content adds nothing.
    if (before !== after) files.push({ file, test, before, after, absolute: path.join(cwd, file) });
  }
  return files.sort((a, b) => a.file.localeCompare(b.file, 'en'));
}

/** The new findings of one rule profile in `selected`; a base version is linted only when its file has findings. */
async function profileFindings(name, selected, scope) {
  const eslint = await ESLint.fromOptionsModule(new URL(`?profile=${name}`, import.meta.url));
  const current = new Map(
    (await eslint.lintFiles(selected.map(({ absolute }) => absolute))).map((lint) => [lint.filePath, lint.messages]),
  );
  const result = [];
  for (const { file, before, after, absolute } of selected) {
    // A rule the project ignores on this file (sonar.issue.ignore.multicriteria) is not reported.
    const messages = reported(current.get(absolute) ?? []).filter(
      ({ ruleId }) =>
        !scope.ignored.some(
          ({ rule, resource }) => rule === sonarKey(ruleId ?? '') && path.matchesGlob(file, resource),
        ),
    );
    if (!messages.length) continue;
    const old = before == null ? [] : reported((await eslint.lintText(before, { filePath: absolute }))[0].messages);
    for (const { ruleId, line, message } of newFindings(old, before, messages, after))
      result.push({ file, line, rule: ruleId ?? 'parse', message });
  }
  return result;
}

/** The changed JavaScript files of `cwd` against the merge base of `base` and HEAD, with their new findings. The
 * current versions are linted in ESLint's worker threads. Run it once per process: typescript-eslint keeps the first
 * project service of a process. */
async function sonarRuleFindings({ cwd, base = 'origin/main' }) {
  const mergeBase = git(cwd, ['merge-base', base, 'HEAD']).trim();
  const scope = sonarScope();
  const files = changedFiles(cwd, mergeBase, scope);
  const tests = files.filter(({ test }) => test),
    sources = files.filter(({ test }) => !test);
  const result = [];
  for (const [name, selected] of [
    ['tests', tests],
    ['main', sources],
    ['typed', sources],
  ])
    if (selected.length) result.push(...(await profileFindings(name, selected, scope)));
  result.sort((a, b) => a.file.localeCompare(b.file, 'en') || a.line - b.line);
  return { files: files.length, findings: result };
}

async function main(args) {
  if (args.length && (args.length !== 2 || args[0] !== '--base')) {
    console.error('Use: node scripts/sonar-rules.mjs [--base <rev>]');
    return 2;
  }
  const report = await sonarRuleFindings({ cwd: process.cwd(), base: args[1] });
  for (const { file, line, rule, message } of report.findings) console.log(`${file}:${line} ${rule} ${message}`);
  console.log(
    `${report.files} changed JavaScript file(s); ${report.findings.length} new finding(s) of the local SonarQube rule approximation.`,
  );
  if (report.findings.length)
    console.log('Fix each finding, or justify a deliberate one with `// NOSONAR: <reason>` on its line.');
  return report.findings.length ? 1 : 0;
}

// The options module instances that ESLint imports carry a profile and never run the command.
if (!profile && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main(process.argv.slice(2));
