// Read-only verification of GitHub's effective PR state, not historical job success.
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function checkKey(check) {
  return check.__typename === 'StatusContext'
    ? JSON.stringify(['status', check.context ?? ''])
    : JSON.stringify(['run', check.workflowName ?? '', check.name ?? '']);
}

const TERMINAL_STATUS_STATES = new Set(['SUCCESS', 'FAILURE', 'ERROR']);
// GitHub reports queued runs with a 0001-01-01 start time; no real run starts before this instant.
const EARLIEST_REPORTED_TIME = Date.parse('2000-01-01T00:00:00Z');

function isSettled(check) {
  return check.__typename === 'StatusContext' ? TERMINAL_STATUS_STATES.has(check.state) : check.status === 'COMPLETED';
}

// An unsettled entry or one without a plausible timestamp counts as the newest, so a queued or running rerun
// cannot be hidden by an older result.
function checkTime(check) {
  const time = Date.parse(check.__typename === 'StatusContext' ? check.createdAt : check.startedAt);
  if (!isSettled(check) || Number.isNaN(time) || time < EARLIEST_REPORTED_TIME) return Number.POSITIVE_INFINITY;
  return time;
}

// Keeps the newest result of each check in each workflow; a rerun or a later push supersedes older results.
function newestChecks(checks) {
  return [...Map.groupBy(checks, checkKey).values()].flatMap((group) => {
    const newest = Math.max(...group.map(checkTime));
    return group.filter((check) => checkTime(check) === newest);
  });
}

export function qualifyPullRequest(pr, expectedHead) {
  const checks = newestChecks(pr.statusCheckRollup ?? []);
  const gates = ['CI gate', 'Security gate'];
  const reasons = [];
  if (!expectedHead || pr.headRefOid !== expectedHead) reasons.push('The PR head differs from the checked-out commit.');
  if (pr.isDraft) reasons.push('The PR is a draft.');
  if (pr.mergeable !== 'MERGEABLE') reasons.push(`Mergeability is ${pr.mergeable ?? 'UNKNOWN'}.`);
  if (pr.mergeStateStatus !== 'CLEAN') reasons.push(`GitHub merge state is ${pr.mergeStateStatus ?? 'UNKNOWN'}.`);
  for (const gate of gates) {
    const results = checks.filter((check) => check.name === gate);
    if (!results.length || results.some((check) => check.status !== 'COMPLETED' || check.conclusion !== 'SUCCESS'))
      reasons.push(`${gate} has no unambiguous successful result for this PR head.`);
  }
  const pending = checks.filter((check) => !isSettled(check));
  if (pending.length) reasons.push(`${pending.length} checks have not completed.`);
  const failed = checks.filter((check) =>
    check.__typename === 'StatusContext'
      ? ['FAILURE', 'ERROR'].includes(check.state)
      : check.status === 'COMPLETED' && !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(check.conclusion),
  );
  if (failed.length)
    reasons.push(
      `${failed.length} checks are unsuccessful: ${failed.map((check) => check.name ?? check.context ?? 'unnamed check').join(', ')}.`,
    );
  return {
    schemaVersion: 1,
    ok: reasons.length === 0,
    url: pr.url,
    head: pr.headRefOid,
    mergeState: pr.mergeStateStatus,
    reasons,
  };
}

function command(program, args) {
  const result = spawnSync(program, args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  if (result.status !== 0) throw new Error(result.error?.message || result.stderr.trim() || `${program} failed.`);
  return result.stdout.trim();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { pr: { type: 'string' }, repo: { type: 'string' } }, strict: true });
    const head = command('git', ['--no-optional-locks', 'rev-parse', 'HEAD']);
    const pr = JSON.parse(
      command('gh', [
        'pr',
        'view',
        ...(values.pr ? [values.pr] : []),
        ...(values.repo ? ['--repo', values.repo] : []),
        '--json',
        'url,headRefOid,isDraft,mergeable,mergeStateStatus,statusCheckRollup',
      ]),
    );
    const report = qualifyPullRequest(pr, head);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
