import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function cleanCandidate(revision) {
  const options = { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
  const head = execFileSync('git', ['rev-parse', 'HEAD'], options).trim();
  const changes = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], options);
  if (head !== revision || changes !== '')
    throw new Error('Sonar analysis requires the exact clean candidate checkout.');
}

function parseReport(text) {
  const values = Object.create(null);
  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator < 0) continue;
    const key = line.slice(0, separator);
    if (Object.hasOwn(values, key)) throw new Error('Sonar scanner report contains duplicate keys.');
    values[key] = line.slice(separator + 1);
  }
  return values;
}

async function readApi(base, token, endpoint, query, fetchImpl) {
  const url = new URL(endpoint, base);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new Error('Sonar API request failed.');
  }
  if (!response.ok) throw new Error(`Sonar API returned HTTP ${response.status}.`);
  try {
    return await response.json();
  } catch {
    throw new Error('Sonar API returned invalid JSON.');
  }
}

async function completedTask(base, token, scanner, branch, fetchImpl, wait) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const { task } = await readApi(base, token, 'api/ce/task', { id: scanner.ceTaskId }, fetchImpl);
    if (
      task?.id !== scanner.ceTaskId ||
      task.type !== 'REPORT' ||
      task.componentKey !== 'paqvilo' ||
      task.branch !== branch ||
      task.pullRequest
    )
      throw new Error('Sonar compute task has unexpected identity.');
    if (task.status === 'SUCCESS') {
      if (typeof task.analysisId !== 'string' || !task.analysisId.trim())
        throw new Error('Sonar compute task did not return an analysis ID.');
      return task;
    }
    if (!['PENDING', 'IN_PROGRESS'].includes(task.status) || attempt === 59)
      throw new Error('Sonar compute task did not complete successfully.');
    await wait(1000);
  }
  throw new Error('Sonar compute task did not complete successfully.');
}

function validateIssuePage(data, page, pageSize, previousTotal, branch, seen) {
  if (
    !Number.isSafeInteger(data.total) ||
    data.total < 0 ||
    data.total > 10000 ||
    data.p !== page ||
    data.ps !== pageSize ||
    data.paging?.pageIndex !== page ||
    data.paging?.pageSize !== pageSize ||
    data.paging?.total !== data.total ||
    !Array.isArray(data.issues) ||
    (previousTotal !== undefined && previousTotal !== data.total)
  )
    throw new Error('Sonar issue pagination is incomplete or inconsistent.');
  const expected = Math.min(pageSize, data.total - (page - 1) * pageSize);
  if (data.issues.length !== expected) throw new Error('Sonar issue page is incomplete.');
  for (const issue of data.issues) {
    if (
      typeof issue.key !== 'string' ||
      !issue.key ||
      seen.has(issue.key) ||
      issue.project !== 'paqvilo' ||
      (issue.branch !== undefined && issue.branch !== branch)
    )
      throw new Error('Sonar issue page contains inconsistent entries.');
    seen.add(issue.key);
  }
}

async function unresolvedIssues(base, token, branch, fetchImpl) {
  const pageSize = 100;
  let total;
  const seen = new Set();
  for (let page = 1; ; page++) {
    const data = await readApi(
      base,
      token,
      'api/issues/search',
      {
        componentKeys: 'paqvilo',
        branch,
        resolved: 'false',
        p: page,
        ps: pageSize,
      },
      fetchImpl,
    );
    validateIssuePage(data, page, pageSize, total, branch, seen);
    total = data.total;
    if (seen.size === total) return total;
  }
}

/** Verify the completed full-branch task and every page of unresolved issues. */
export async function verifySonarBranch({
  report,
  host,
  token,
  branch,
  revision,
  fetchImpl = fetch,
  checkGit = cleanCandidate,
  wait = delay,
}) {
  if (!token || !branch || !/^[0-9a-f]{40}$/i.test(revision ?? ''))
    throw new Error('Missing Sonar branch, revision or token.');
  checkGit(revision);
  const base = new URL(host.endsWith('/') ? host : `${host}/`);
  const scanner = parseReport(report);
  if (
    !scanner.ceTaskId ||
    scanner.projectKey !== 'paqvilo' ||
    scanner.serverUrl?.replace(/\/$/, '') !== base.href.replace(/\/$/, '')
  )
    throw new Error('Sonar scanner report does not match the configured project and server.');
  // The scanner receives this clean checkout's exact revision. Its CE task binds
  // the result to the project and branch; analysis-history revision access requires
  // Sonar project administration and is intentionally not requested by CI.
  const task = await completedTask(base, token, scanner, branch, fetchImpl, wait);
  const total = await unresolvedIssues(base, token, branch, fetchImpl);
  checkGit(revision);
  if (total !== 0) throw new Error(`Full-source Sonar analysis has ${total} unresolved issue(s).`);
  return { analysisId: task.analysisId, branch, revision, unresolved: 0 };
}

async function main() {
  if (process.argv.length !== 2) throw new Error('Unexpected Sonar verifier arguments.');
  const report = await readFile('.scannerwork/report-task.txt', 'utf8');
  const result = await verifySonarBranch({
    report,
    host: process.env.SONAR_HOST_URL,
    token: process.env.SONAR_TOKEN,
    branch: process.env.SONAR_FULL_BRANCH,
    revision: process.env.SONAR_EXPECTED_REVISION,
  });
  process.stdout.write(`Full-source Sonar branch ${result.branch}: zero unresolved issues.\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
