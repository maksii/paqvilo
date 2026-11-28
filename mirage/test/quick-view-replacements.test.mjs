// @test-kind contract: delayed quick-view reconciliation requires the browser's consecutive child-document lifecycle.
import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileQuickViewReplacement } from '../lib/quick-view-replacements.mjs';

function observedReplacement() {
  const origin = 'http://127.0.0.1:3000';
  const path = '/_portal/quickform-template-path/ef44fc0f-2cab-46e1-9817-767b0445b22a';
  const binding = '?entityid=fixture&entityname=book&formname=Book&controlid=detail&entityprimarykeyname=bookid';
  const common = { type: 'Document', method: 'GET', frameId: 'child', status: 200, mimeType: 'text/html' };
  const before = {
    ...common,
    path: path + binding + '&isprofilepage=false&lang=en-US',
    requestId: 'request-1',
    loaderId: 'loader-1',
    startedTimestamp: 1,
    observedTicks: 100,
  };
  const successor = {
    ...common,
    path: path + binding,
    requestId: 'request-2',
    loaderId: 'loader-2',
    startedTimestamp: 1.2,
    finishedTimestamp: 1.9,
    observedTicks: 200,
    quickViewRefresh: 'e'.repeat(64),
  };
  const childCommit = { event: 'frameNavigated', frameId: 'child', parentFrameId: 'parent' };
  const events = [
    { ...childCommit, loaderId: before.loaderId, observedTicks: 120 },
    {
      event: 'frameRequestedNavigation',
      frameId: 'child',
      reason: 'scriptInitiated',
      path: successor.path,
      observedTicks: 180,
    },
    { ...childCommit, loaderId: successor.loaderId, observedTicks: 800 },
  ];
  const request = {
    method: 'GET',
    path: before.path,
    type: 'document',
    cdpFrameId: 'child',
    startedTicks: 102,
    endedTicks: 798,
    finished: false,
  };
  const failure = { method: 'GET', errorText: 'net::ERR_ABORTED', requestKey: '1', status: 200 };
  const reconcile = () => reconcileQuickViewReplacement(failure, { origin, request, rows, events });
  const rows = [before, successor];
  return { before, successor, request, rows, events, reconcile };
}

test('the initial document abort must belong to the successor commit', () => {
  const { before, request, events, reconcile } = observedReplacement();
  assert.equal(reconcile()?.replacement.requestId, 'request-2');
  request.endedTicks = 185;
  events[2].observedTicks = 210;
  assert.equal(reconcile(), null, 'abort before the replacement send');
  request.endedTicks = 208;
  before.failure = 'net::ERR_ABORTED';
  before.failedTimestamp = 1.1;
  before.failedObservedTicks = 207;
  assert.equal(reconcile(), null, 'browser network abort before the replacement send');
  before.failedTimestamp = 1.21;
  assert.equal(reconcile()?.replacement.requestId, 'request-2');
  request.endedTicks = 799;
  events[2].observedTicks = 800;
  assert.equal(reconcile(), null, 'browser network abort long before the replacement commit');
  before.failedObservedTicks = 798;
  assert.equal(reconcile()?.replacement.requestId, 'request-2');
  events[0].parentFrameId = 'other-parent';
  assert.equal(reconcile(), null, 'different parent frame');
});

test('an intervening event in the same child frame invalidates a delayed replacement', () => {
  const { successor, rows, events, reconcile } = observedReplacement();
  events.splice(2, 0, { ...events[1], observedTicks: 260 });
  assert.equal(reconcile(), null, 'another requested navigation');
  events[2] = { ...events[3], loaderId: 'another-document', observedTicks: 280 };
  assert.equal(reconcile(), null, 'another committed document');
  events[2] = { event: 'frameDetached', frameId: 'child', observedTicks: 290 };
  assert.equal(reconcile(), null, 'frame detach');
  events.splice(2, 1);
  rows.push({ ...successor, requestId: 'request-3', startedTimestamp: 1.3, observedTicks: 300 });
  assert.equal(reconcile(), null, 'another dispatched document request');
});
