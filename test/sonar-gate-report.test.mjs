// @test-kind tooling: scripts/sonar-gate-report.mjs prints why a SonarQube quality gate failed
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { sonarGateReport } from '../scripts/sonar-gate-report.mjs';

const base = 'https://sonar.example.test';
const token = 'INVENTED-TOKEN';
const project = 'invented-project';

const gateBody = {
  projectStatus: {
    status: 'ERROR',
    conditions: [
      { status: 'OK', metricKey: 'coverage', actualValue: '90', comparator: 'LT', errorThreshold: '80' },
      { status: 'ERROR', metricKey: 'new_violations', actualValue: '3', comparator: 'GT', errorThreshold: '0' },
    ],
  },
};

const issuesBody = {
  total: 2,
  issues: [
    {
      rule: 'invented:rule-one',
      component: `${project}:scripts/example.mjs`,
      line: 12,
      message: 'Remove the unused value.',
    },
    { rule: 'invented:rule-two', component: `${project}:test/example.test.mjs`, message: 'Name the test better.' },
  ],
};

const hotspotsBody = {
  paging: { pageIndex: 1, pageSize: 100, total: 1 },
  hotspots: [
    {
      ruleKey: 'invented:hotspot-rule',
      component: `${project}:lense/fixture.mjs`,
      line: 7,
      message: 'Review the fixture address.',
    },
  ],
};

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function stubFetch(routes) {
  const requests = [];
  const fetchImpl = async (url) => {
    const requested = new URL(url);
    requests.push(requested);
    const route = routes[requested.pathname];
    return route ? route() : jsonResponse({}, 404);
  };
  return { fetchImpl, requests };
}

const healthyRoutes = {
  '/api/qualitygates/project_status': () => jsonResponse(gateBody),
  '/api/issues/search': () => jsonResponse(issuesBody),
  '/api/hotspots/search': () => jsonResponse(hotspotsBody),
};

test('lists the failed gate condition, the new-code issues and the hotspots for a branch', async () => {
  const { fetchImpl, requests } = stubFetch(healthyRoutes);
  const lines = await sonarGateReport({ base, token, project, branch: 'invented-branch', fetchImpl });
  assert.deepEqual(lines, [
    'Quality gate: ERROR',
    '  FAILED new_violations: actual 3, GT 0',
    'Open issues in new code: 2',
    '  invented:rule-one scripts/example.mjs:12 Remove the unused value.',
    '  invented:rule-two test/example.test.mjs:- Name the test better.',
    'Security hotspots to review in new code: 1',
    '  invented:hotspot-rule lense/fixture.mjs:7 Review the fixture address.',
  ]);
  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.searchParams.get('branch'), 'invented-branch');
    assert.equal(request.searchParams.has('pullRequest'), false);
  }
});

test('selects a pull request analysis with the pullRequest parameter only', async () => {
  const { fetchImpl, requests } = stubFetch(healthyRoutes);
  await sonarGateReport({ base, token, project, pullRequest: '23', fetchImpl });
  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.searchParams.get('pullRequest'), '23');
    assert.equal(request.searchParams.has('branch'), false);
  }
});

test('keeps the gate and hotspot lines when the issues endpoint refuses the token', async () => {
  const { fetchImpl } = stubFetch({
    ...healthyRoutes,
    '/api/issues/search': () => jsonResponse({}, 401),
  });
  const lines = await sonarGateReport({ base, token, project, branch: 'invented-branch', fetchImpl });
  assert.deepEqual(lines, [
    'Quality gate: ERROR',
    '  FAILED new_violations: actual 3, GT 0',
    '  (could not read api/issues/search: HTTP 401)',
    'Security hotspots to review in new code: 1',
    '  invented:hotspot-rule lense/fixture.mjs:7 Review the fixture address.',
  ]);
  for (const line of lines) {
    assert.equal(line.includes(token), false);
    assert.equal(line.includes('sonar.example.test'), false);
  }
});

test('explains a hotspot refusal in plain words and keeps other hotspot failures generic', async () => {
  const openIssues = [
    'Open issues in new code: 2',
    '  invented:rule-one scripts/example.mjs:12 Remove the unused value.',
    '  invented:rule-two test/example.test.mjs:- Name the test better.',
  ];
  for (const status of [401, 403]) {
    const { fetchImpl } = stubFetch({ ...healthyRoutes, '/api/hotspots/search': () => jsonResponse({}, status) });
    const lines = await sonarGateReport({ base, token, project, branch: 'invented-branch', fetchImpl });
    assert.deepEqual(lines, [
      'Quality gate: ERROR',
      '  FAILED new_violations: actual 3, GT 0',
      ...openIssues,
      '  (the token is not allowed to read security hotspots; the quality gate conditions above already count them)',
    ]);
  }
  const { fetchImpl } = stubFetch({ ...healthyRoutes, '/api/hotspots/search': () => jsonResponse({}, 500) });
  const lines = await sonarGateReport({ base, token, project, branch: 'invented-branch', fetchImpl });
  assert.equal(lines.at(-1), '  (could not read api/hotspots/search: HTTP 500)');
});

test('the workflow runs the gate report as the last step of its job and only after a failure', async () => {
  const workflow = parse(await readFile(new URL('../.github/workflows/sonarqube.yml', import.meta.url), 'utf8'));
  const reporting = Object.values(workflow.jobs).map((job) => {
    const index = job.steps.findIndex((step) => step.run === 'node scripts/sonar-gate-report.mjs');
    return { index, steps: job.steps, step: job.steps[index] };
  });
  const found = reporting.filter((entry) => entry.index >= 0);
  assert.equal(found.length, 1);
  assert.equal(found[0].step.if, 'failure()');
  assert.equal(found[0].index, found[0].steps.length - 1);
});
