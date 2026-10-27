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
