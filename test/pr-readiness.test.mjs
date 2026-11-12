// @test-kind tooling: check:pr qualification of GitHub's effective PR head, merge state and gate results.
import test from 'node:test';
import assert from 'node:assert/strict';
import { qualifyPullRequest } from '../scripts/pr-readiness.mjs';

const head = 'a'.repeat(40);
const ready = {
  headRefOid: head,
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  statusCheckRollup: ['CI gate', 'Security gate'].map((name) => ({
    __typename: 'CheckRun',
    name,
    status: 'COMPLETED',
    conclusion: 'SUCCESS',
  })),
};

test('successful historical jobs cannot qualify a blocked PR', () => {
  const report = qualifyPullRequest({ ...ready, mergeStateStatus: 'BLOCKED' }, head);
  assert.equal(report.ok, false);
  assert.deepEqual(report.reasons, ['GitHub merge state is BLOCKED.']);
});

test('readiness requires the pushed head, effective merge state and completed gates', () => {
  assert.equal(qualifyPullRequest(ready, head).ok, true);
  assert.equal(
    qualifyPullRequest(
      { ...ready, statusCheckRollup: [...ready.statusCheckRollup, { __typename: 'StatusContext', state: 'SUCCESS' }] },
      head,
    ).ok,
    true,
    'a completed commit status has no check-run status field',
  );
  for (const state of [
    {
      ...ready,
      statusCheckRollup: [ready.statusCheckRollup[0], { ...ready.statusCheckRollup[1], conclusion: 'FAILURE' }],
    },
    { ...ready, headRefOid: 'b'.repeat(40) },
    { ...ready, mergeStateStatus: 'UNKNOWN' },
    { ...ready, mergeable: 'CONFLICTING' },
    { ...ready, isDraft: true },
    { ...ready, statusCheckRollup: [] },
    { ...ready, statusCheckRollup: ready.statusCheckRollup.slice(0, 1) },
    {
      ...ready,
      statusCheckRollup: [...ready.statusCheckRollup, { __typename: 'CheckRun', name: 'Tests', status: 'IN_PROGRESS' }],
    },
    { ...ready, statusCheckRollup: [...ready.statusCheckRollup, { __typename: 'StatusContext', state: 'PENDING' }] },
  ])
    assert.equal(qualifyPullRequest(state, head).ok, false, JSON.stringify(state));
  assert.equal(qualifyPullRequest(ready, null).ok, false);
});

test('a failed result for a required gate cannot be hidden by a successful result with the same name', () => {
  const conflict = {
    ...ready,
    statusCheckRollup: [
      ...ready.statusCheckRollup,
      { __typename: 'CheckRun', name: 'CI gate', status: 'COMPLETED', conclusion: 'FAILURE' },
    ],
  };
  const result = qualifyPullRequest(conflict, head);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((reason) => reason.includes('CI gate')));
});

test('an expected commit status is still pending', () => {
  const pending = {
    ...ready,
    statusCheckRollup: [...ready.statusCheckRollup, { __typename: 'StatusContext', state: 'EXPECTED' }],
  };
  assert.equal(qualifyPullRequest(pending, head).ok, false);
});

test('successful required gates cannot hide another failed or cancelled check on the same head', () => {
  for (const conclusion of ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', null]) {
    const report = qualifyPullRequest(
      {
        ...ready,
        statusCheckRollup: [
          ...ready.statusCheckRollup,
          {
            __typename: 'CheckRun',
            name: 'Additional browser runner',
            status: 'COMPLETED',
            conclusion,
          },
        ],
      },
      head,
    );
    assert.equal(report.ok, false, String(conclusion));
    assert.ok(
      report.reasons.some((reason) => reason.includes('unsuccessful')),
      String(conclusion),
    );
  }
  for (const state of ['FAILURE', 'ERROR'])
    assert.equal(
      qualifyPullRequest(
        {
          ...ready,
          statusCheckRollup: [
            ...ready.statusCheckRollup,
            { __typename: 'StatusContext', context: 'External validation', state },
          ],
        },
        head,
      ).ok,
      false,
      state,
    );
  for (const conclusion of ['SUCCESS', 'NEUTRAL', 'SKIPPED'])
    assert.equal(
      qualifyPullRequest(
        {
          ...ready,
          statusCheckRollup: [
            ...ready.statusCheckRollup,
            { __typename: 'CheckRun', name: 'Inapplicable optional job', status: 'COMPLETED', conclusion },
          ],
        },
        head,
      ).ok,
      true,
      conclusion,
    );
});

const timedRun = (name, conclusion, startedAt, workflowName = 'CI') => ({
  __typename: 'CheckRun',
  name,
  status: 'COMPLETED',
  conclusion,
  startedAt,
  workflowName,
});

test('a newer run of the same check on the same head supersedes its cancelled or failed earlier runs', () => {
  const superseded = {
    ...ready,
    statusCheckRollup: [
      timedRun('Unit tests', 'CANCELLED', '2026-11-01T10:00:00Z'),
      timedRun('CI gate', 'FAILURE', '2026-11-01T10:01:00Z'),
      timedRun('Unit tests', 'SUCCESS', '2026-11-01T10:01:00Z'),
      timedRun('CI gate', 'SUCCESS', '2026-11-01T10:20:00Z'),
      timedRun('Security gate', 'SUCCESS', '2026-11-01T10:05:00Z', 'Security'),
    ],
  };
  assert.equal(qualifyPullRequest(superseded, head).ok, true);
  const newerStatusContext = {
    ...ready,
    statusCheckRollup: [
      ...ready.statusCheckRollup,
      {
        __typename: 'StatusContext',
        context: 'External validation',
        state: 'FAILURE',
        createdAt: '2026-11-01T10:00:00Z',
      },
      {
        __typename: 'StatusContext',
        context: 'External validation',
        state: 'SUCCESS',
        createdAt: '2026-11-01T10:30:00Z',
      },
    ],
  };
  assert.equal(qualifyPullRequest(newerStatusContext, head).ok, true);
});

test('an older success cannot hide a newer failure of a required gate on the same head', () => {
  const reversed = {
    ...ready,
    statusCheckRollup: [
      timedRun('CI gate', 'SUCCESS', '2026-11-01T10:01:00Z'),
      timedRun('CI gate', 'FAILURE', '2026-11-01T10:20:00Z'),
      timedRun('Security gate', 'SUCCESS', '2026-11-01T10:05:00Z', 'Security'),
    ],
  };
  const result = qualifyPullRequest(reversed, head);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((reason) => reason.includes('CI gate')));
});

test('a newer run still in progress keeps the check pending instead of trusting its older success', () => {
  const rerunning = {
    ...ready,
    statusCheckRollup: [
      timedRun('CI gate', 'SUCCESS', '2026-11-01T10:01:00Z'),
      {
        __typename: 'CheckRun',
        name: 'CI gate',
        status: 'IN_PROGRESS',
        conclusion: null,
        startedAt: '2026-11-01T10:30:00Z',
        workflowName: 'CI',
      },
      timedRun('Security gate', 'SUCCESS', '2026-11-01T10:05:00Z', 'Security'),
    ],
  };
  const result = qualifyPullRequest(rerunning, head);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((reason) => reason.includes('CI gate')));
});

test('a same-named check from another workflow is not superseded and its failure still blocks', () => {
  const otherWorkflow = {
    ...ready,
    statusCheckRollup: [
      ...ready.statusCheckRollup,
      timedRun('Build', 'FAILURE', '2026-11-01T10:00:00Z', 'CI'),
      timedRun('Build', 'SUCCESS', '2026-11-01T10:05:00Z', 'Release'),
    ],
  };
  const result = qualifyPullRequest(otherWorkflow, head);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((reason) => reason.includes('Build')));
});

test('a queued rerun with the placeholder start time cannot be hidden by an older success', () => {
  const queued = {
    ...ready,
    statusCheckRollup: [
      timedRun('CI gate', 'SUCCESS', '2026-11-01T10:01:00Z'),
      {
        __typename: 'CheckRun',
        name: 'CI gate',
        status: 'QUEUED',
        conclusion: null,
        startedAt: '0001-01-01T00:00:00Z',
        workflowName: 'CI',
      },
      timedRun('Security gate', 'SUCCESS', '2026-11-01T10:05:00Z', 'Security'),
    ],
  };
  const result = qualifyPullRequest(queued, head);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((reason) => reason.includes('CI gate')));
});

test('an in-progress rerun keeps the check pending whatever its start time relative to an older success', () => {
  const rerunning = {
    ...ready,
    statusCheckRollup: [
      timedRun('CI gate', 'SUCCESS', '2026-11-01T10:20:00Z'),
      {
        __typename: 'CheckRun',
        name: 'CI gate',
        status: 'IN_PROGRESS',
        conclusion: null,
        startedAt: '2026-11-01T09:00:00Z',
        workflowName: 'CI',
      },
      timedRun('Security gate', 'SUCCESS', '2026-11-01T10:05:00Z', 'Security'),
    ],
  };
  const result = qualifyPullRequest(rerunning, head);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((reason) => reason.includes('CI gate')));
});

test('a pending status context keeps its check blocked whatever its creation time relative to a success', () => {
  const pendingContext = {
    ...ready,
    statusCheckRollup: [
      ...ready.statusCheckRollup,
      {
        __typename: 'StatusContext',
        context: 'External validation',
        state: 'SUCCESS',
        createdAt: '2026-11-01T10:30:00Z',
      },
      {
        __typename: 'StatusContext',
        context: 'External validation',
        state: 'PENDING',
        createdAt: '2026-11-01T10:00:00Z',
      },
    ],
  };
  const result = qualifyPullRequest(pendingContext, head);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((reason) => reason.includes('checks have not completed')));
});

test('a completed run with a timestamp before 2000 counts as newest and its failure still blocks', () => {
  const implausibleTime = {
    ...ready,
    statusCheckRollup: [
      ...ready.statusCheckRollup,
      timedRun('Build', 'SUCCESS', '2026-11-01T10:05:00Z', 'CI'),
      timedRun('Build', 'FAILURE', '1999-12-31T23:59:59Z', 'CI'),
    ],
  };
  const result = qualifyPullRequest(implausibleTime, head);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((reason) => reason.includes('Build')));
});
