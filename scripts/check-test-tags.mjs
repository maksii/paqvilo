import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { validateParityCases } from '../mirage/testing/parity-cases.mjs';
// Enforces docs/test-kinds.md on test files, parity case files and known-gap files a change adds or modifies.
//   node scripts/check-test-tags.mjs --staged          pre-commit: the index against HEAD
//   node scripts/check-test-tags.mjs --base <rev>      a branch against <rev> (merge base)
//   node scripts/check-test-tags.mjs --event           CI: the GitHub pull_request/push event range
//   node scripts/check-test-tags.mjs --report          counts per kind and replay cases over the repository (no failure)
//   node scripts/check-test-tags.mjs <file...>         tag syntax of the named files only
// A changed test file needs a valid kind for every test. Removing or rewriting a line inside a `parity` region
// also needs a `// @parity-evidence: <proof>` line added by the same change, or a retirement entry in
// scripts/parity-retirements.json. A new parity tag is valid only on a replay runner. Recorded parity cases change
// only with a new history entry, and a recorded case cannot receive a new known gap. Files listed in
// scripts/test-kinds-legacy.json predate the rule: they are skipped while they carry no @test-kind line at all, and
// checked in full once one is added. Hand-written parity tags that predate replay cases are listed in
// scripts/parity-tags-legacy.json; the list only shrinks.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const KINDS = new Set(['parity', 'observation', 'compatibility', 'unproven', 'contract', 'security', 'tooling']);
const EVIDENCE_KINDS = new Set(['parity', 'observation']);
const TEST_FILE = /\.test\.[cm]?js$/;
const CASE_FILE = /(?:^|\/)parity\/cases\/(?<surface>[a-z0-9-]+)\/(?<suite>[a-z0-9-]+)\.json$/;
const GAP_FILE = /(?:^|\/)parity\/known-gaps\/(?<surface>[a-z0-9-]+)\.json$/;
const GAP_KEY = /^(?<suite>[a-z0-9-]+)#(?<caseId>.+)$/;
const RETIREMENT_FILE = 'scripts/parity-retirements.json';
const LEGACY_PARITY_FILE = 'scripts/parity-tags-legacy.json';
const REPLAY_CALL = /\breplayParity(?:Cases|Directory)\s*\(/;
const TAG = /^\s*\/\/\s*@test-kind\b(.*)$/;
const TAG_BODY = /^\s+([a-z]+(?:\+[a-z]+)*)\s*:\s*(\S.*)$/;
const TEST_DECLARATION = /^(?:test|it|describe|suite)(?:\.(?:only|skip|todo))?\s*\(/;
const CONTEXT_DECLARATION = /^(?:await\s+)?t\.test\s*\(/;
const LOOP_DECLARATION = /^(?:for\s*\(|\[.*\]\.forEach\()/;
function isDeclaration(line) {
  const text = line.trimStart();
  return TEST_DECLARATION.test(text) || CONTEXT_DECLARATION.test(text) || LOOP_DECLARATION.test(text);
}
function isTestDeclaration(line) {
  const text = line.trimStart();
  return TEST_DECLARATION.test(text) || CONTEXT_DECLARATION.test(text);
}
function isTopLevelDeclaration(line) {
  return line === line.trimStart() && isDeclaration(line);
}
const FILE_TAG_LINES = 40;
function tagAfterComment(text, index) {
  let next = index + 2;
  while (next < text.length && /\s/u.test(text[next])) next++;
  return text.startsWith('@test-kind', next) && !/\w/u.test(text[next + 10] ?? '');
}
function hasAnyTag(text) {
  let lineStart = true;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (/[\r\n\u2028\u2029]/u.test(character)) {
      lineStart = true;
    } else if (lineStart && /\s/u.test(character)) {
      continue;
    } else if (lineStart && text.startsWith('//', index)) {
      if (tagAfterComment(text, index)) return true;
      lineStart = false;
    } else {
      lineStart = false;
    }
  }
  return false;
}

function legacyFiles() {
  try {
    return new Set(JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'test-kinds-legacy.json'), 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return new Set();
    throw error;
  }
}

function git(args, { allowFailure = false } = {}) {
  /* NOSONAR */ const result = spawnSync('git', ['--no-optional-locks', ...args], {
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

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function parseJson(text) {
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    return { error: error.message };
  }
}

function workingText(file) {
  try {
    return fs.readFileSync(path.resolve(root, file), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Parses tags: { fileKinds, regions: [{ start, end, kinds }], tags, errors }. Lines are 1-based. */
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
      perTest: next < lines.length && isDeclaration(lines[next]),
      declaration: next + 1,
    });
  });
  const fileTags = tags.filter((tag) => !tag.perTest);
  for (const tag of fileTags)
    if (tag.line > FILE_TAG_LINES)
      errors.push(`line ${tag.line}: a file-level @test-kind belongs in the first ${FILE_TAG_LINES} lines`);
  if (fileTags.length > 1) errors.push('more than one file-level @test-kind');
  const topLevel = lines.flatMap((line, index) => (isTopLevelDeclaration(line) ? [index + 1] : []));
  // A per-test region ends before the next declaration at the same or a shallower indentation, so a tag on an
  // indented it() inside describe() covers only that test.
  const indent = (line) => /^\s*/.exec(lines[line - 1])[0].length;
  const regions = tags
    .filter((tag) => tag.perTest)
    .map((tag) => {
      const depth = indent(tag.declaration);
      const subtest = /^\s*(?:await\s+)?t\.test\s*\(/.test(lines[tag.declaration - 1]);
      const closesSubtest = (line, number) => subtest && indent(number) <= depth && /^\s*\}\);?\s*$/.test(line);
      const end = lines.findIndex(
        (line, index) =>
          index + 1 > tag.declaration &&
          ((isDeclaration(line) && indent(index + 1) <= depth) || closesSubtest(line, index + 1)),
      );
      let endLine = lines.length;
      if (end >= 0) endLine = end + Number(closesSubtest(lines[end], end + 1));
      return {
        start: tag.line,
        end: endLine,
        kinds: tag.kinds,
      };
    });
  const fileKinds = fileTags[0]?.kinds ?? null;
  if (!fileKinds)
    for (const line of topLevel)
      if (!regions.some((region) => line >= region.start && line <= region.end))
        errors.push(`line ${line}: test has no @test-kind (add a file-level tag or one above the test)`);
  return { fileKinds, regions, tags, errors };
}

/** The innermost region (an it() inside a tagged describe()) wins, then the file kinds, then none. */
export const kindsAt = (parsed, line) =>
  parsed.regions.filter((region) => line >= region.start && line <= region.end).sort((a, b) => b.start - a.start)[0]
    ?.kinds ??
  parsed.fileKinds ??
  [];

function rangeInto(list, start, count) {
  const length = count === undefined ? 1 : Number(count);
  for (let i = 0; i < length; i++) list.push(start + i);
}

/**
 * Line facts of a unified -U0 diff: old-side line numbers removed, new-side line numbers added, the texts of those
 * lines without their +/- sign, and whether the diff adds a @parity-evidence line.
 */
export function diffFacts(diff) {
  const removed = [],
    added = [],
    addedText = [],
    removedText = [];
  let evidence = false,
    inHunk = false;
  for (const line of diff.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      inHunk = true;
      rangeInto(removed, Number(hunk[1]), hunk[2]);
      rangeInto(added, Number(hunk[3]), hunk[4]);
    } else if (inHunk && line.startsWith('+')) addedText.push(line.slice(1));
    else if (inHunk && line.startsWith('-')) removedText.push(line.slice(1));
    if (/^\+(?!\+\+)/.test(line) && /\/\/\s*@parity-evidence:\s*\S{3}/.test(line)) evidence = true;
  }
  return { removed, added, addedText, removedText, evidence };
}

const isRepoPath = (value) =>
  typeof value === 'string' &&
  value !== '' &&
  !value.startsWith('/') &&
  !value.includes('\\') &&
  value.split('/').every((part) => part !== '' && part !== '..');

function retirementProblems(entry, where) {
  if (!isObject(entry)) return [`${where} must be an object`];
  const problems = [];
  if (!isRepoPath(entry.file)) problems.push(`${where}.file must be a repo-relative POSIX path`);
  if (typeof entry.reason !== 'string' || entry.reason.trim().length < 20)
    problems.push(`${where}.reason needs at least 20 characters`);
  if (typeof entry.authority !== 'string' || entry.authority.trim().length < 10)
    problems.push(`${where}.authority needs at least 10 characters (who approved the retirement)`);
  return problems;
}

function ledgerProblems(text) {
  if (text == null) return [`${RETIREMENT_FILE}: missing`];
  const parsed = parseJson(text);
  if ('error' in parsed) return [`${RETIREMENT_FILE}: not valid JSON (${parsed.error})`];
  if (parsed.value?.version !== 1) return [`${RETIREMENT_FILE}: version must be 1`];
  if (!Array.isArray(parsed.value.retirements)) return [`${RETIREMENT_FILE}: retirements must be an array`];
  return parsed.value.retirements.flatMap((entry, index) =>
    retirementProblems(entry, `${RETIREMENT_FILE}: retirements[${index}]`),
  );
}

function ledgerEntries(text) {
  const value = text == null ? undefined : parseJson(text).value;
  return Array.isArray(value?.retirements) ? value.retirements : [];
}

/** Files named by well-formed retirement entries that the change adds to the ledger. */
function retiredByChange(newText, oldText) {
  const before = ledgerEntries(oldText(RETIREMENT_FILE));
  const added = ledgerEntries(newText(RETIREMENT_FILE)).filter(
    (entry) => !before.some((old) => isDeepStrictEqual(old, entry)),
  );
  return new Set(added.filter((entry) => retirementProblems(entry, '').length === 0).map((entry) => entry.file));
}

function checkParityRemoval(file, old, facts, ctx, failures) {
  const before = parseTestKinds(old);
  const touched = facts.removed.filter((line) => kindsAt(before, line).includes('parity'));
  if (!touched.length || facts.evidence || ctx.retired.has(file)) return;
  const first = touched.slice(0, 5).join(', ');
  const more = touched.length > 5 ? ', ...' : '';
  failures.push(
    `${file}: changes ${touched.length} line(s) of a parity test (old lines ${first}${more}). ` +
      'Parity assertions change only with an explicit user request or new native/official-package proof; add "// @parity-evidence: <proof>" or a retirement entry (docs/test-kinds.md).',
  );
}

const isReplayRunner = (tag, text, lines) =>
  !tag.perTest &&
  tag.kinds.join('+') === 'parity' &&
  REPLAY_CALL.test(text) &&
  !lines.some((line) => isTestDeclaration(line));

const countOf = (list, item) => list.filter((entry) => entry === item).length;

/** Hand-written parity tag lines that predate replay cases, by test file. A missing or invalid ledger lists nothing. */
function legacyParityTags(text) {
  const parsed = text == null ? {} : parseJson(text);
  const tags = isObject(parsed.value?.tags) ? parsed.value.tags : {};
  return new Map(Object.entries(tags).filter(([, lines]) => Array.isArray(lines)));
}

/** A parity tag is NEW when the file is new, or its line was added and its text was not moved from elsewhere. */
function checkNewParityTags(file, text, parsed, facts, failures, legacyParity) {
  const lines = text.split(/\r?\n/);
  const removedTexts = new Set((facts?.removedText ?? []).map((line) => line.trim()));
  const listed = legacyParity.get(file) ?? [];
  const parityTexts = parsed.tags
    .filter((tag) => tag.kinds.includes('parity'))
    .map((tag) => lines[tag.line - 1].trim());
  for (const tag of parsed.tags) {
    if (!tag.kinds.includes('parity')) continue;
    const isNew = !facts || (facts.added.includes(tag.line) && !removedTexts.has(lines[tag.line - 1].trim()));
    const tagText = lines[tag.line - 1].trim();
    // A listed legacy tag may appear once per listing; copying it onto another test in the file fails.
    const isListedLegacy = listed.includes(tagText) && countOf(parityTexts, tagText) <= countOf(listed, tagText);
    if (isNew && !isListedLegacy && !isReplayRunner(tag, text, lines))
      failures.push(
        `${file}: line ${tag.line}: a new parity tag is only valid on a replay runner that registers its tests through replayParityCases or replayParityDirectory; record a replay case instead (docs/test-kinds.md).`,
      );
  }
}

function staleLegacyProblems(file, lines, ctx) {
  const current = ctx.newText(file);
  const carried = current == null ? [] : current.split(/\r?\n/).map((line) => line.trim());
  return [...new Set(lines)]
    .filter((line) => countOf(carried, line) < countOf(lines, line))
    .map((line) => `${file}: does not carry "${line}"; remove the stale entry`);
}

function legacyEntryProblems(file, lines, ctx) {
  if (!isRepoPath(file) || !TEST_FILE.test(file)) return [`${file}: must be a repo-relative test file`];
  if (!Array.isArray(lines) || lines.length === 0 || !lines.every((line) => typeof line === 'string'))
    return [`${file}: needs a non-empty array of tag lines`];
  const notParity = lines
    .filter((line) => !isParityTagLine(line))
    .map((line) => `${file}: "${line}" is not a parity tag line`);
  return [...notParity, ...staleLegacyProblems(file, lines, ctx)];
}

function isParityTagLine(line) {
  const match = TAG.exec(line);
  const body = match && TAG_BODY.exec(match[1]);
  return Boolean(body) && body[1].split('+').includes('parity');
}

/** Tags the change adds to the ledger: any file/line whose count grows against the base ledger. */
function legacyGrowthProblems(newMap, oldMap) {
  return [...newMap].flatMap(([file, lines]) =>
    [...new Set(lines)]
      .filter((line) => countOf(lines, line) > countOf(oldMap.get(file) ?? [], line))
      .map(
        () =>
          `adds a tag for ${file}; the list of hand-written parity tags only shrinks, record a replay case instead (docs/test-kinds.md).`,
      ),
  );
}

function legacyParityProblems(ctx) {
  const text = ctx.newText(LEGACY_PARITY_FILE);
  if (text == null) return [];
  const parsed = parseJson(text);
  let problems;
  if ('error' in parsed) problems = [`not valid JSON (${parsed.error})`];
  else if (parsed.value?.version !== 1) problems = ['version must be 1'];
  else if (!isObject(parsed.value.tags)) problems = ['tags must be an object of test file to tag lines'];
  else problems = Object.entries(parsed.value.tags).flatMap(([file, lines]) => legacyEntryProblems(file, lines, ctx));
  const oldText = ctx.diffMode ? ctx.oldText(LEGACY_PARITY_FILE) : null;
  if (typeof oldText === 'string') problems.push(...legacyGrowthProblems(ctx.legacyParity, legacyParityTags(oldText)));
  return problems.map((problem) => `${LEGACY_PARITY_FILE}: ${problem}`);
}

function checkFile(file, ctx, failures) {
  const text = ctx.newText(file);
  const old = ctx.oldText?.(file) ?? null;
  const facts = old == null ? null : diffFacts(ctx.diffOf(file));
  if (old != null) checkParityRemoval(file, old, facts, ctx, failures);
  if (text == null || (ctx.legacy.has(file) && !hasAnyTag(text))) return;
  const parsed = parseTestKinds(text);
  for (const error of parsed.errors) failures.push(`${file}: ${error}`);
  if (ctx.diffMode) checkNewParityTags(file, text, parsed, facts, failures, ctx.legacyParity);
}

const historyLength = (value) => (Array.isArray(value?.history) ? value.history.length : 0);

/** Recorded cases whose oracle, id set, input, output or volatile list differs between the two versions. */
function changedCases(before, after) {
  const changed = isDeepStrictEqual(before?.oracle, after?.oracle) ? [] : ['oracle'];
  const current = new Map((Array.isArray(after?.cases) ? after.cases : []).map((item) => [item?.id, item]));
  const recorded = (Array.isArray(before?.cases) ? before.cases : []).filter(isObject);
  for (const item of recorded) {
    const next = current.get(item.id);
    if (!next || !['input', 'output', 'volatile'].every((key) => isDeepStrictEqual(next[key], item[key])))
      changed.push(item.id);
  }
  return changed;
}

function checkRecordedCases(file, before, after, failures) {
  const changed = changedCases(before, after);
  if (!changed.length || historyLength(after) > historyLength(before)) return;
  const shown = changed.slice(0, 5).join(', ') + (changed.length > 5 ? ', ...' : '');
  failures.push(
    `${file}: changes recorded parity cases (${shown}) without a new history entry; a recorded case changes only with new evidence (docs/test-kinds.md).`,
  );
}

function checkCaseFile(file, ctx, failures) {
  const { surface, suite } = CASE_FILE.exec(file).groups;
  const text = ctx.newText(file);
  const old = ctx.diffMode ? (ctx.oldText(file) ?? null) : null;
  if (text == null) {
    if (old != null && !ctx.retired.has(file))
      failures.push(
        `${file}: deletes recorded parity cases; add a retirement entry in scripts/parity-retirements.json (docs/test-kinds.md).`,
      );
    return;
  }
  const parsed = parseJson(text);
  if ('error' in parsed) {
    failures.push(`${file}: not valid JSON (${parsed.error})`);
    return;
  }
  for (const problem of validateParityCases(parsed.value, { surface, suite })) failures.push(`${file}: ${problem}`);
  const before = old == null ? null : parseJson(old);
  if (before && !('error' in before)) checkRecordedCases(file, before.value, parsed.value, failures);
}

function knownGapProblems(value) {
  if (!isObject(value)) return ['must be a JSON object of <suite>#<caseId> gaps'];
  return Object.entries(value).flatMap(([key, gap]) => {
    if (!GAP_KEY.test(key)) return [`${key}: key must be <suite>#<caseId>`];
    if (typeof gap === 'string') return gap.trim() === '' ? [`${key}: gap reason must not be empty`] : [];
    if (!isObject(gap) || Object.keys(gap).length === 0)
      return [`${key}: gap must be a reason or an object of JSON pointer reasons`];
    return Object.entries(gap).flatMap(([pointer, reason]) => {
      if (!pointer.startsWith('/')) return [`${key}: ${pointer} is not a JSON pointer`];
      return typeof reason === 'string' && reason.trim() !== '' ? [] : [`${key}: ${pointer} needs a non-empty reason`];
    });
  });
}

/** A gap is new when its key is new, it becomes whole-case, or a pointer-scoped gap gains a pointer. */
function isNewGap(previous, next) {
  if (previous === undefined) return true;
  if (typeof next === 'string') return typeof previous !== 'string';
  if (typeof previous === 'string') return false;
  return Object.keys(next).some((pointer) => !isObject(previous) || !(pointer in previous));
}

function gapsOf(text) {
  const parsed = text == null ? {} : parseJson(text);
  return isObject(parsed.value) ? parsed.value : {};
}

function recordedIds(text) {
  const value = text == null ? undefined : parseJson(text).value;
  return (Array.isArray(value?.cases) ? value.cases : []).map((item) => item?.id);
}

function checkKnownGaps(file, ctx, failures) {
  const { surface } = GAP_FILE.exec(file).groups;
  const text = ctx.newText(file);
  if (text == null) return;
  const parsed = parseJson(text);
  if ('error' in parsed) {
    failures.push(`${file}: not valid JSON (${parsed.error})`);
    return;
  }
  for (const problem of knownGapProblems(parsed.value)) failures.push(`${file}: ${problem}`);
  if (!ctx.diffMode || !isObject(parsed.value)) return;
  const previous = gapsOf(ctx.oldText(file));
  for (const [key, gap] of Object.entries(parsed.value)) {
    if (knownGapProblems({ [key]: gap }).length || !isNewGap(previous[key], gap)) continue;
    const { suite, caseId } = GAP_KEY.exec(key).groups;
    const caseFile = file.replace(/known-gaps\/[a-z0-9-]+\.json$/, `cases/${surface}/${suite}.json`);
    if (recordedIds(ctx.oldText(caseFile)).includes(caseId) && !ctx.retired.has(file))
      failures.push(
        `${file}: declares a new gap for recorded case ${suite}#${caseId}; a recorded case must keep passing, fix the runtime (docs/test-kinds.md).`,
      );
  }
}

export function check({ files, newText, oldText, diffOf = () => '', legacy = new Set() }) {
  const failures = [];
  const diffMode = Boolean(oldText);
  if (files.includes(RETIREMENT_FILE)) failures.push(...ledgerProblems(newText(RETIREMENT_FILE)));
  const ctx = {
    newText,
    oldText,
    diffOf,
    legacy,
    diffMode,
    legacyParity: legacyParityTags(newText(LEGACY_PARITY_FILE)),
    retired: diffMode ? retiredByChange(newText, oldText) : new Set(),
  };
  if (files.includes(LEGACY_PARITY_FILE)) failures.push(...legacyParityProblems(ctx));
  for (const file of files) {
    if (TEST_FILE.test(file)) checkFile(file, ctx, failures);
    else if (CASE_FILE.test(file)) checkCaseFile(file, ctx, failures);
    else if (GAP_FILE.test(file)) checkKnownGaps(file, ctx, failures);
  }
  return failures;
}

function run(args) {
  if (args[0] === '--report') {
    return reportKinds();
  }
  let options;
  if (args[0] === '--staged') {
    options = {
      files: git(['diff', '--cached', '--name-only', '--diff-filter=AMD', '--no-renames', '-z'])
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
      files: git(['diff', '--name-only', '--diff-filter=AMD', '--no-renames', '-z', mergeBase, head])
        .split('\0')
        .filter(Boolean),
      newText: (file) => git(['show', `${head}:${file}`], { allowFailure: true }),
      oldText: (file) => git(['show', `${mergeBase}:${file}`], { allowFailure: true }),
      diffOf: (file) => git(['diff', '-U0', '--no-renames', mergeBase, head, '--', file]),
    };
  } else {
    options = { files: args, newText: workingText };
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

function reportKinds() {
  // Tracked files deleted in the working tree have no text on disk and are not counted.
  const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean);
  const files = tracked.filter((file) => TEST_FILE.test(file) && workingText(file) !== null);
  const counts = {};
  for (const file of files) {
    const parsed = parseTestKinds(workingText(file));
    const kinds = new Set([...(parsed.fileKinds ?? []), ...parsed.regions.flatMap((region) => region.kinds)]);
    if (!kinds.size) kinds.add('untagged');
    for (const kind of kinds) counts[kind] = (counts[kind] ?? 0) + 1;
  }
  const cases = tracked.filter((file) => CASE_FILE.test(file) && workingText(file) !== null);
  const replay = { suites: cases.length, cases: 0 };
  for (const file of cases) {
    const value = parseJson(workingText(file)).value;
    replay.cases += Array.isArray(value?.cases) ? value.cases.length : 0;
  }
  console.log(JSON.stringify({ files: files.length, counts, replay }, null, 1));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = run(process.argv.slice(2));
