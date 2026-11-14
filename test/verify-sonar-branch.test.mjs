// @test-kind tooling: full-source Sonar gating fails closed on scanner and paginated API inconsistencies.
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { verifySonarBranch } from '../scripts/verify-sonar-branch.mjs';

const revision = 'a'.repeat(40);
const branch = 'sonar-findings-0.9.8';
const secret = 'synthetic-test-token';

async function fixture(t, options = {}) {
  const calls = [];
  const statuses = [...(options.statuses ?? [])];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture.invalid');
    calls.push(url);
    if (request.headers.authorization !== `Bearer ${secret}`) {
      response.writeHead(401).end();
      return;
    }
    if (options.httpFailure) {
      response.writeHead(503).end(secret);
      return;
    }
    response.setHeader('content-type', 'application/json');
    if (options.invalidJson) {
      response.end('not JSON');
      return;
    }
    if (url.pathname === '/api/ce/task') {
      response.end(
        JSON.stringify({
          task: {
            id: 'task-1',
            type: 'REPORT',
            status: 'SUCCESS',
            componentKey: 'paqvilo',
            branch,
            analysisId: 'analysis-1',
            ...options.task,
            ...(statuses.length ? { status: statuses.shift() } : {}),
          },
        }),
      );
      return;
    }
    if (url.pathname === '/api/issues/search') {
      const page = Number(url.searchParams.get('p'));
      const total = options.total ?? 0;
      const count = Math.max(0, Math.min(100, total - (page - 1) * 100));
      const issues = Array.from({ length: count }, (_, index) => ({
        key: `issue-${(page - 1) * 100 + index}`,
        project: 'paqvilo',
        branch,
      }));
      const data = { total, p: page, ps: 100, paging: { pageIndex: page, pageSize: 100, total }, issues };
      options.mutate?.(data, page);
      response.end(JSON.stringify(data));
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  ownedFixture(t).add(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  const host = `http://127.0.0.1:${server.address().port}`;
  const report = `projectKey=paqvilo\nserverUrl=${host}\nceTaskId=task-1\n`;
  let gitChecks = 0;
  const run = (overrides = {}) =>
    verifySonarBranch({
      report,
      host,
      token: secret,
      branch,
      revision,
      checkGit: () => {
        gitChecks++;
      },
      ...overrides,
    });
  return {
    calls,
    run,
    get gitChecks() {
      return gitChecks;
    },
  };
}

test('accepts only its completed branch task and a consistent empty issue page', async (t) => {
  const f = await fixture(t);
  const result = await f.run();
  assert.deepEqual(result, { analysisId: 'analysis-1', branch, revision, unresolved: 0 });
  assert.equal(f.gitChecks, 2);
  assert.equal(f.calls[0].searchParams.get('id'), 'task-1');
  assert.equal(f.calls[1].searchParams.get('branch'), branch);
  assert.equal(f.calls[1].searchParams.get('resolved'), 'false');
});

test('polls its exact compute task until analysis completes', async (t) => {
  const f = await fixture(t, { statuses: ['PENDING', 'IN_PROGRESS', 'SUCCESS'] });
  let waits = 0;
  const result = await f.run({
    wait: async () => {
      waits++;
    },
  });
  assert.equal(result.unresolved, 0);
  assert.equal(waits, 2);
  assert.equal(f.calls.filter((url) => url.pathname.endsWith('/task')).length, 3);
});

test('reads every page before rejecting unresolved findings', async (t) => {
  const f = await fixture(t, { total: 101 });
  await assert.rejects(f.run(), /101 unresolved/);
  assert.deepEqual(
    f.calls.filter((url) => url.pathname.endsWith('/search')).map((url) => url.searchParams.get('p')),
    ['1', '2'],
  );
});

test('rejects malformed, inconsistent, duplicate and truncated issue pages', async (t) => {
  for (const mutate of [
    (data) => {
      data.total = -1;
    },
    (data) => {
      data.paging.total++;
    },
    (data) => {
      data.issues.pop();
    },
    (data) => {
      data.issues[1].key = data.issues[0].key;
    },
    (data, page) => {
      if (page === 2) data.total++;
    },
  ]) {
    const f = await fixture(t, { total: 101, mutate });
    await assert.rejects(f.run(), /Sonar issue/);
  }
});

test('rejects wrong compute task identity, project, branch, and status', async (t) => {
  for (const task of [
    { id: 'other' },
    { componentKey: 'other' },
    { branch: 'other' },
    { status: 'FAILED' },
    { analysisId: '' },
    { analysisId: '   ' },
    { analysisId: {} },
    { pullRequest: '40' },
  ]) {
    const f = await fixture(t, { task });
    await assert.rejects(f.run(), /compute task/);
  }
});

test('fails closed on HTTP and JSON errors without printing response secrets', async (t) => {
  for (const options of [{ httpFailure: true }, { invalidJson: true }]) {
    const f = await fixture(t, options);
    await assert.rejects(f.run(), (error) => !error.message.includes(secret) && /Sonar API/.test(error.message));
  }
});

test('rejects mismatched scanner reports and dirty candidate checks', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.run({ report: 'projectKey=other\nserverUrl=http://127.0.0.1\nceTaskId=task-1\n' }),
    /scanner report/,
  );
  await assert.rejects(f.run({ report: 'projectKey=paqvilo\nprojectKey=other\n' }), /duplicate keys/);
  await assert.rejects(
    f.run({
      checkGit: () => {
        throw new Error('dirty candidate');
      },
    }),
    /dirty candidate/,
  );
  assert.equal(f.calls.length, 0);
});
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

test('workflow runs full branch and PR analyses from one head and all nine physical jobs for six logical lanes', async () => {
  const workflow = parse(await readFile(new URL('../.github/workflows/sonarqube.yml', import.meta.url), 'utf8'));
  const analysis = workflow.jobs.analysis;
  assert.equal(analysis.name, 'SonarQube analysis and quality gate');
  assert.equal(analysis.needs, 'coverage');
  const jobs = workflow.jobs.coverage.strategy.matrix.include;
  assert.equal(jobs.length, 9);
  assert.equal(new Set(jobs.map((job) => job.artifact)).size, 9);
  assert.deepEqual(
    new Set(jobs.map((job) => `${job.suite}/${job.lane}`)),
    new Set(['lense/unit', 'lense/browser', 'mirage/unit', 'mirage/browser', 'examples/unit', 'examples/browser']),
  );
  const checkout = analysis.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  assert.match(checkout.with.ref, /github\.event\.pull_request\.head\.sha/);
  const scanners = analysis.steps.filter((step) => step.uses?.startsWith('SonarSource/sonarqube-scan-action@'));
  assert.equal(scanners.length, 2);
  const reportPaths = jobs.map((job) => `coverage/sonar-coverage-${job.artifact}/lcov.info`).sort();
  for (const scanner of scanners) {
    assert.deepEqual(
      scanner.with.args
        .match(/-Dsonar\.javascript\.lcov\.reportPaths=([^\s]+)/)[1]
        .split(',')
        .sort(),
      reportPaths,
    );
    assert.ok(scanner.with.args.includes('-Dsonar.qualitygate.wait=true'));
  }
  assert.match(scanners[0].with.args, /sonar\.branch\.name=.*github\.head_ref/);
  assert.match(scanners[0].with.args, /sonar\.scm\.revision=.*pull_request\.head\.sha/);
  const gate = analysis.steps.findIndex((step) => step.run === 'node scripts/verify-sonar-branch.mjs');
  assert.ok(gate > analysis.steps.indexOf(scanners[0]) && gate < analysis.steps.indexOf(scanners[1]));
});

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('CLI rejects unexpected arguments before reading a scanner report', () => {
  const script = fileURLToPath(new URL('../scripts/verify-sonar-branch.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--unexpected'], { encoding: 'utf8', windowsHide: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unexpected Sonar verifier arguments/);
});
