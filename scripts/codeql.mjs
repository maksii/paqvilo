// Local CodeQL gate: the CLI bundle and security-extended suites the Security workflow runs, over the validated tree
// as CI checks it out, failing on every result GitHub has not dismissed.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { classifyChanges } from '../.github/scripts/change-scope.mjs';
import { assertOwnedCiState } from './ci-workspace-lease.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The bundle github/codeql-action@<action> installs (its src/defaults.json), with the release asset digests.
export const CODEQL_BUNDLE = {
  action: '9b3254085494b55a0f7c4c2b3d2d52cc712ce370',
  version: '2.27.3',
  assets: {
    win32: ['codeql-bundle-win64.tar.gz', 'b1a54af0e0657bc8dd2201474373aae6cee72c20d820a3a89423013f2465533d'],
    linux: ['codeql-bundle-linux64.tar.gz', '64518dc413c8e7b5733fee2489e830a899bb1e3f28c8873b5869d5cc90164c5c'],
    darwin: ['codeql-bundle-osx64.tar.gz', '5a035e81cd8c76622d0e453d1d5197cfee46177f171d623f15fbb560a0b2b215'],
  },
};

export const codeqlLanguages = () => JSON.parse(classifyChanges([]).languages);
export const securitySuite = (language) => {
  const pack = language === 'javascript-typescript' ? 'javascript' : language;
  return `codeql/${pack}-queries:codeql-suites/${pack}-security-extended.qls`;
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0)
    throw new Error(
      `${path.basename(command)} ${args[0]} failed: ${(result.stderr || result.error?.message || '').trim()}`,
    );
  return result.stdout;
}

// Worktrees share one bundle: it lives beside the common Git directory, in the main checkout's ignored state.
function toolCache() {
  const common = run('git', ['--no-optional-locks', 'rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
  return path.join(path.dirname(common), '.paqvilo', 'tools', `codeql-${CODEQL_BUNDLE.version}`);
}

/** A completed bundle is immutable. Only its installer may replace incomplete
 * files, and another invocation waits without touching those files. */
export async function ensureCodeqlBundle({
  cache,
  digest,
  executable,
  install,
  wait = () => setTimeout(50),
  timeoutMs = 600000,
}) {
  const marker = path.join(cache, '.complete');
  const complete = () => {
    try {
      return fs.readFileSync(marker, 'utf8') === digest;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return false;
    }
  };
  if (complete()) return executable;
  fs.mkdirSync(cache, { recursive: true });
  const lock = path.join(cache, '.install.lock'),
    token = randomUUID(),
    deadline = Date.now() + timeoutMs;
  for (;;) {
    if (complete()) return executable;
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline)
        throw new Error(
          `CodeQL bundle installation still owns ${lock}; inspect its installer before removing an abandoned lock.`,
          { cause: error },
        );
      await wait();
    }
  }
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token }), { flag: 'wx' });
  let failure;
  try {
    if (!complete()) {
      // The cache is under this ESM checkout; bundle Node helpers are CommonJS.
      fs.writeFileSync(path.join(cache, 'package.json'), '{ "type": "commonjs" }\n');
      await install();
      fs.writeFileSync(marker, digest);
    }
  } catch (error) {
    failure = error;
  }
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
    if (owner.token !== token) throw new Error('CodeQL installer ownership changed; retaining its lock.');
    fs.rmSync(lock, { recursive: true });
  } catch (error) {
    if (failure)
      throw new AggregateError(
        [failure, error],
        `${failure.message}; CodeQL installer cleanup failed: ${error.message}`,
        { cause: error },
      );
    throw error;
  }
  if (failure) throw failure;
  return executable;
}

export async function codeqlExecutable({ env = process.env, platform = process.platform } = {}) {
  if (env.PAQ_CODEQL) {
    const version = JSON.parse(run(env.PAQ_CODEQL, ['version', '--format=json'])).version;
    if (version !== CODEQL_BUNDLE.version)
      throw new Error(`PAQ_CODEQL is CodeQL ${version}; the Security workflow runs ${CODEQL_BUNDLE.version}.`);
    return env.PAQ_CODEQL;
  }
  const asset = CODEQL_BUNDLE.assets[platform];
  if (!asset)
    throw new Error(`No pinned CodeQL bundle for ${platform}; set PAQ_CODEQL to a ${CODEQL_BUNDLE.version} CLI.`);
  const cache = toolCache();
  const executable = path.join(cache, 'codeql', platform === 'win32' ? 'codeql.exe' : 'codeql');
  return ensureCodeqlBundle({
    cache,
    executable,
    digest: asset[1],
    install: async () => {
      console.log(`[codeql] Downloading the pinned CodeQL ${CODEQL_BUNDLE.version} bundle once for every worktree.`);
      // Windows scanners can hold freshly extracted files, so serialize this
      // in-place installation instead of publishing a renamed bundle tree.
      fs.rmSync(path.join(cache, 'codeql'), { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
      const staging = fs.mkdtempSync(path.join(cache, '.download-'));
      try {
        run('gh', [
          'release',
          'download',
          `codeql-bundle-v${CODEQL_BUNDLE.version}`,
          '--repo',
          'github/codeql-action',
          '--pattern',
          asset[0],
          '--dir',
          staging,
        ]);
        const archive = path.join(staging, asset[0]);
        if ((await fileDigest(archive)) !== asset[1]) throw new Error('CodeQL bundle digest mismatch.');
        const tar =
          platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
        run(tar, ['-xzf', archive, '-C', cache]);
      } finally {
        fs.rmSync(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
      }
    },
  });
}

/** Readers see a complete immutable GitHub analysis, never a partially written
 * shared-cache file from a concurrent analysis. */
export function publishSarifCache(file, contents) {
  JSON.parse(contents);
  const temporary = `${file}.tmp-${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, contents, { flag: 'wx' });
    try {
      fs.renameSync(temporary, file);
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error.code) || fs.readFileSync(file, 'utf8') !== contents) throw error;
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

async function fileDigest(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

const resultKey = (rule, file, lineHash) => `${rule}\0${file}\0${lineHash}`;

function sarifResults(sarif) {
  return (sarif.runs ?? []).flatMap((entry) =>
    (entry.results ?? []).map((result) => {
      const location = result.locations?.[0]?.physicalLocation;
      return {
        rule: result.ruleId ?? result.rule?.id,
        file: location?.artifactLocation?.uri,
        line: location?.region?.startLine,
        column: location?.region?.startColumn,
        lineHash: result.partialFingerprints?.primaryLocationLineHash,
        message: result.message?.text ?? '',
      };
    }),
  );
}

/** Fingerprints of the analysis results that GitHub alerts on the same ref and commit record as dismissed. */
export function dismissedKeys(analysisSarif, alerts, commit) {
  const dismissed = alerts.filter(
    (alert) => alert.state === 'dismissed' && alert.most_recent_instance?.commit_sha === commit,
  );
  const keys = new Set();
  for (const result of sarifResults(analysisSarif)) {
    if (!result.lineHash) continue;
    const match = dismissed.some(({ rule, most_recent_instance: { location } }) => {
      return (
        rule.id === result.rule &&
        location.path === result.file &&
        location.start_line === result.line &&
        (location.start_column ?? 1) === (result.column ?? 1)
      );
    });
    if (match) keys.add(resultKey(result.rule, result.file, result.lineHash));
  }
  return keys;
}

/** Local results that would be open alerts: everything without a dismissed fingerprint. */
export function undismissedResults(localSarif, keys) {
  return sarifResults(localSarif).filter(
    (result) => !result.lineHash || !keys.has(resultKey(result.rule, result.file, result.lineHash)),
  );
}

function gh(endpoint, { accept, paginate = false } = {}) {
  const args = ['api', '--method', 'GET', endpoint, ...(accept ? ['-H', `Accept: ${accept}`] : [])];
  if (paginate) args.push('--paginate', '--slurp');
  const output = run('gh', args);
  return paginate ? JSON.parse(output).flat() : JSON.parse(output);
}

// Alert states are repository-wide; each ref's latest analyses supply the fingerprints for its dismissed alerts.
// Main and every open PR's merge ref cover dismissals made on the base, on a release PR and on this branch's PR.
function githubDismissals(cacheDirectory) {
  let repository;
  try {
    repository = run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();
  } catch (error) {
    throw new Error(
      'The local CodeQL gate needs the GitHub CLI signed in to read dismissed alerts; run gh auth login.',
      { cause: error },
    );
  }
  const refs = [
    'refs/heads/main',
    ...gh(`repos/${repository}/pulls?state=open&per_page=100`, { paginate: true }).map(
      (pull) => `refs/pull/${pull.number}/merge`,
    ),
  ];
  const keys = new Set();
  for (const ref of refs) {
    const query = `ref=${encodeURIComponent(ref)}&tool_name=CodeQL&per_page=100`;
    const alerts = gh(`repos/${repository}/code-scanning/alerts?${query}&state=dismissed`, { paginate: true });
    if (!alerts.length) continue;
    const latest = new Map();
    for (const analysis of gh(`repos/${repository}/code-scanning/analyses?${query}`, { paginate: true }))
      if (!latest.has(analysis.category)) latest.set(analysis.category, analysis); // Newest first.
    for (const analysis of latest.values()) {
      // An analysis never changes, so its SARIF is fetched once.
      const cached = path.join(cacheDirectory, `analysis-${analysis.id}.sarif`);
      let sarif;
      try {
        sarif = JSON.parse(fs.readFileSync(cached, 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
        const contents = run('gh', [
          'api',
          `repos/${repository}/code-scanning/analyses/${analysis.id}`,
          '-H',
          'Accept: application/sarif+json',
        ]);
        sarif = JSON.parse(contents);
        publishSarifCache(cached, contents);
      }
      for (const key of dismissedKeys(sarif, alerts, analysis.commit_sha)) keys.add(key);
    }
  }
  return keys;
}

export async function codeqlGate({
  checkout = root,
  executable = codeqlExecutable,
  execute = run,
  dismissals = githubDismissals,
  snapshot,
  log = console.log,
  report = console.error,
} = {}) {
  // Legacy runners remove ci/codeql. A sibling run root survives those older
  // processes as well as concurrent invocations of this implementation.
  const state = assertOwnedCiState(checkout),
    parent = path.join(state, 'codeql-runs');
  fs.mkdirSync(parent, { recursive: true });
  if (path.relative(state, fs.realpathSync(parent)) !== 'codeql-runs')
    throw new Error('CodeQL run state must remain inside its checkout CI directory.');
  const work = fs.mkdtempSync(path.join(parent, `run-${process.pid}-`));
  const source = path.join(work, 'source');
  fs.mkdirSync(source, { recursive: true });
  const manifest = {
    version: 1,
    startedAt: new Date().toISOString(),
    bundle: CODEQL_BUNDLE.version,
    languages: codeqlLanguages(),
    status: 'running',
    source: 'source',
    analyses: [],
  };
  const save = () => fs.writeFileSync(path.join(work, 'report.json'), JSON.stringify(manifest, null, 2) + '\n');
  log(`[codeql] Evidence: ${work}`);
  save();
  try {
    const codeql = await executable();
    if (snapshot) manifest.sourceTree = await snapshot(source);
    else {
      // CI analyses only tracked content of one validated index, never local data.
      const tree = () => execute('git', ['--no-optional-locks', 'write-tree'], { cwd: checkout });
      manifest.sourceTree = String(await tree()).trim();
      await execute(
        'git',
        ['--no-optional-locks', 'checkout-index', '--all', `--prefix=${source.replaceAll('\\', '/')}/`],
        { cwd: checkout },
      );
      if (manifest.sourceTree !== String(await tree()).trim())
        throw new Error('The validated index changed while exporting CodeQL sources.');
    }
    save();
    const cacheDirectory = path.join(path.dirname(path.dirname(codeql)), 'analyses');
    fs.mkdirSync(cacheDirectory, { recursive: true });
    const keys = await dismissals(cacheDirectory);
    const findings = [];
    for (const language of codeqlLanguages()) {
      const database = path.join(work, `db-${language}`);
      const output = path.join(work, `${language}.sarif`);
      const started = performance.now();
      const analysis = {
        language,
        suite: securitySuite(language),
        category: `/language:${language}`,
        database: path.basename(database),
        sarif: path.basename(output),
        status: 'creating',
      };
      manifest.analyses.push(analysis);
      save();
      await execute(
        codeql,
        [
          'database',
          'create',
          database,
          `--language=${language}`,
          '--build-mode=none',
          `--source-root=${source}`,
          '--threads=0',
          '--overwrite',
        ],
        { cwd: source },
      );
      analysis.status = 'analyzing';
      save();
      await execute(codeql, [
        'database',
        'analyze',
        database,
        securitySuite(language),
        '--format=sarif-latest',
        `--output=${output}`,
        `--sarif-category=/language:${language}`,
        '--threads=0',
      ]);
      const open = undismissedResults(JSON.parse(fs.readFileSync(output, 'utf8')), keys);
      analysis.status = 'complete';
      analysis.undismissed = open.length;
      save();
      log(
        `[codeql] ${language}: ${open.length} undismissed finding(s) (${((performance.now() - started) / 1000).toFixed(1)} s)`,
      );
      findings.push(...open);
    }
    for (const finding of findings)
      report(`${finding.file}:${finding.line}: ${finding.rule}: ${finding.message.split('\n')[0]}`);
    if (findings.length)
      throw new Error(
        `CodeQL reports ${findings.length} finding(s) that would block the Security gate. Fix them, or review and dismiss false positives on GitHub. SARIF: ${work}`,
      );
    manifest.status = 'complete';
    manifest.completedAt = new Date().toISOString();
    save();
    log('[codeql] No undismissed CodeQL findings.');
    return { work, manifest };
  } catch (error) {
    manifest.status = 'failed';
    manifest.completedAt = new Date().toISOString();
    manifest.failure = error.message;
    try {
      save();
    } catch (recordError) {
      throw new AggregateError(
        [error, recordError],
        `${error.message}; could not record CodeQL failure: ${recordError.message}. Evidence: ${work}`,
        { cause: recordError },
      );
    }
    throw new Error(`${error.message} CodeQL evidence: ${work}`, { cause: error });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await codeqlGate();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
