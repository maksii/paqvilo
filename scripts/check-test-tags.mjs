// Enforces docs/test-kinds.md on test files a change adds or modifies.
//   node scripts/check-test-tags.mjs --staged          pre-commit: the index against HEAD
//   node scripts/check-test-tags.mjs --base <rev>      a branch against <rev> (merge base)
//   node scripts/check-test-tags.mjs --event           CI: the GitHub pull_request/push event range
//   node scripts/check-test-tags.mjs --report          counts per kind over every test file (no failure)
//   node scripts/check-test-tags.mjs <file...>         tag syntax of the named files only
// A changed test file needs a valid kind for every test. Removing or rewriting a line inside a `parity` region
// also needs a `// @parity-evidence: <proof>` line added by the same change. Files listed in scripts/test-kinds-legacy.json
// predate the rule: they are skipped while they carry no @test-kind line at all, and checked in full once one is added.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const KINDS = new Set(['parity', 'observation', 'compatibility', 'unproven', 'contract', 'security', 'tooling']);
const EVIDENCE_KINDS = new Set(['parity', 'observation']);
const TEST_FILE = /\.test\.[cm]?js$/;
const TAG = /^\s*\/\/\s*@test-kind\b(.*)$/;
const TAG_BODY = /^\s+([a-z]+(?:\+[a-z]+)*)\s*:\s*(\S.*)$/;
const DECLARATION = /^\s*(?:(?:test|it|describe|suite)(?:\.(?:only|skip|todo))?\s*\(|for\s*\(|\[.*\]\.forEach\()/;
const TOP_LEVEL = /^(?:(?:test|it|describe|suite)(?:\.(?:only|skip|todo))?\s*\(|for\s*\(|\[.*\]\.forEach\()/;
const FILE_TAG_LINES = 40;
const ANY_TAG = /^\s*\/\/\s*@test-kind\b/m;

function legacyFiles() {
  try {
    return new Set(JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'test-kinds-legacy.json'), 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return new Set();
    throw error;
  }
}

function git(args, { allowFailure = false } = {}) {
  const result = spawnSync('git', ['--no-optional-locks', ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    if (allowFailure) return null;
    throw new Error(`git ${args.join(' ')}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/** Parses tags: { fileKinds, regions: [{ start, end, kinds }], errors }. Lines are 1-based. */
export function parseTestKinds(text) {
  const lines = text.split(/\r?\n/);
  const errors = [],
    tags = [];
  lines.forEach((line, index) => {
    const match = TAG.exec(line);
    if (!match) return;
    const body = TAG_BODY.exec(match[1]);
    if (!body) return errors.push(`line ${index + 1}: malformed @test-kind (use "// @test-kind <kind>: <reason>")`);
    const kinds = body[1].split('+');
    const unknown = kinds.filter((kind) => !KINDS.has(kind));
    if (unknown.length) errors.push(`line ${index + 1}: unknown kind ${unknown.join(', ')}`);
    const reason = body[2].trim();
    const minimum = kinds.some((kind) => EVIDENCE_KINDS.has(kind)) ? 20 : 8;
    if (reason.length < minimum)
      errors.push(`line ${index + 1}: ${kinds.join('+')} needs a ${minimum > 8 ? 'evidence source' : 'reason'}`);
    // A tag directly above a test declaration (other comment lines may sit between) is per-test.
    let next = index + 1;
    while (next < lines.length && /^\s*(?:\/\/|$)/.test(lines[next])) next++;
    tags.push({
      line: index + 1,
      kinds,
      perTest: next < lines.length && DECLARATION.test(lines[next]),
      declaration: next + 1,
    });
  });
  const fileTags = tags.filter((tag) => !tag.perTest);
  for (const tag of fileTags)
    if (tag.line > FILE_TAG_LINES)
      errors.push(`line ${tag.line}: a file-level @test-kind belongs in the first ${FILE_TAG_LINES} lines`);
  if (fileTags.length > 1) errors.push('more than one file-level @test-kind');
  const topLevel = lines.flatMap((line, index) => (TOP_LEVEL.test(line) ? [index + 1] : []));
  // A per-test region ends before the next declaration at the same or a shallower indentation, so a tag on an
  // indented it() inside describe() covers only that test.
  const indent = (line) => /^\s*/.exec(lines[line - 1])[0].length;
  const regions = tags
    .filter((tag) => tag.perTest)
    .map((tag) => {
      const depth = indent(tag.declaration);
      const end = lines.findIndex(
        (line, index) => index + 1 > tag.declaration && DECLARATION.test(line) && indent(index + 1) <= depth,
      );
      return { start: tag.line, end: end >= 0 ? end : lines.length, kinds: tag.kinds };
    });
  const fileKinds = fileTags[0]?.kinds ?? null;
  if (!fileKinds)
    for (const line of topLevel)
      if (!regions.some((region) => line >= region.start && line <= region.end))
        errors.push(`line ${line}: test has no @test-kind (add a file-level tag or one above the test)`);
  return { fileKinds, regions, errors };
}

// The innermost region (an it() inside a tagged describe()) wins.
const kindsAt = (parsed, line) =>
  parsed.regions.filter((region) => line >= region.start && line <= region.end).sort((a, b) => b.start - a.start)[0]
    ?.kinds ??
  parsed.fileKinds ??
  [];

/** Old-side line numbers a unified -U0 diff removes or rewrites, and whether it adds a @parity-evidence line. */
export { kindsAt };
export function diffFacts(diff) {
  const removed = [];
  let evidence = false;
  for (const line of diff.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+/.exec(line);
    if (hunk) {
      const start = Number(hunk[1]),
        count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let i = 0; i < count; i++) removed.push(start + i);
    } else if (/^\+(?!\+\+)/.test(line) && /\/\/\s*@parity-evidence:\s*\S{3}/.test(line)) evidence = true;
  }
  return { removed, evidence };
}

export function check({ files, newText, oldText, diffOf, legacy = new Set() }) {
  const failures = [];
  for (const file of files.filter((file) => TEST_FILE.test(file))) {
    const text = newText(file);
    if (text == null || (legacy.has(file) && !ANY_TAG.test(text))) continue;
    const parsed = parseTestKinds(text);
    for (const error of parsed.errors) failures.push(`${file}: ${error}`);
    const old = oldText?.(file);
    if (old == null) continue;
    const before = parseTestKinds(old);
    const { removed, evidence } = diffFacts(diffOf(file));
    const touched = removed.filter((line) => kindsAt(before, line).includes('parity'));
    if (touched.length && !evidence)
      failures.push(
        `${file}: changes ${touched.length} line(s) of a parity test (old lines ${touched.slice(0, 5).join(', ')}${touched.length > 5 ? ', ...' : ''}). ` +
          'Parity assertions change only with an explicit user request or new native/official-package proof; add "// @parity-evidence: <proof>" (docs/test-kinds.md).',
      );
  }
  return failures;
}

function run(args) {
  if (args[0] === '--report') {
    const files = git(['ls-files', '-z'])
      .split('\0')
      .filter((file) => TEST_FILE.test(file));
    const counts = {};
    for (const file of files) {
      const parsed = parseTestKinds(fs.readFileSync(path.join(root, file), 'utf8'));
      const kinds = new Set([...(parsed.fileKinds ?? []), ...parsed.regions.flatMap((region) => region.kinds)]);
      if (!kinds.size) kinds.add('untagged');
      for (const kind of kinds) counts[kind] = (counts[kind] ?? 0) + 1;
    }
    console.log(JSON.stringify({ files: files.length, counts }, null, 1));
    return 0;
  }
  let options;
  if (args[0] === '--staged') {
    options = {
      files: git(['diff', '--cached', '--name-only', '--diff-filter=AM', '--no-renames', '-z'])
        .split('\0')
        .filter(Boolean),
      newText: (file) => git(['show', `:${file}`], { allowFailure: true }),
      oldText: (file) => git(['show', `HEAD:${file}`], { allowFailure: true }),
      diffOf: (file) => git(['diff', '--cached', '-U0', '--no-renames', '--', file]),
    };
  } else if (args[0] === '--base' || args[0] === '--event') {
    let base = args[1],
      head = 'HEAD';
    if (args[0] === '--event') {
      const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
      base = event.pull_request?.base.sha ?? event.before;
      head = event.pull_request?.head.sha ?? process.env.GITHUB_SHA ?? 'HEAD';
      if (!base || /^0+$/.test(base)) {
        console.log('No comparable base revision; test kinds are checked on the next change.');
        return 0;
      }
    }
    const mergeBase = git(['merge-base', base, head]).trim();
    options = {
      files: git(['diff', '--name-only', '--diff-filter=AM', '--no-renames', '-z', mergeBase, head])
        .split('\0')
        .filter(Boolean),
      newText: (file) => git(['show', `${head}:${file}`], { allowFailure: true }),
      oldText: (file) => git(['show', `${mergeBase}:${file}`], { allowFailure: true }),
      diffOf: (file) => git(['diff', '-U0', '--no-renames', mergeBase, head, '--', file]),
    };
  } else {
    options = { files: args, newText: (file) => fs.readFileSync(path.resolve(root, file), 'utf8') };
  }
  const failures = check({ ...options, legacy: legacyFiles() });
  for (const failure of failures) console.error(failure);
  if (failures.length) {
    console.error(`${failures.length} test-kind problem(s); see docs/test-kinds.md.`);
    return 1;
  }
  console.log(
    `Test kinds valid for ${options.files.filter((file) => TEST_FILE.test(file)).length} changed test file(s).`,
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = run(process.argv.slice(2));
