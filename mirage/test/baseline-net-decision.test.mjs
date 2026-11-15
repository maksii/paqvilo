// @test-kind security: the browser-level write decision of a live capture blocks portal writes and passes reads, sign-in traffic and other origins
import test from 'node:test';
import assert from 'node:assert/strict';
import { captureNetDecision } from '../baseline-capture.mjs';
import { captureDecisionCases } from './support/capture-decision-cases.mjs';

const origin = 'https://portal.invalid';

// A request as the browser-session net hands it to the decision: CDP method, URL, headers and resource type. A navigation
// is a Document.
const netRequest = ({ method, url, navigation, headers }) => ({
  method,
  url,
  headers,
  resourceType: navigation ? 'Document' : 'Fetch',
});
const decisionFor = (options) => captureNetDecision({ origin, ...options });

for (const item of captureDecisionCases) {
  test(item.name, () => {
    const { action } = decisionFor(item.options)(netRequest(item.request));
    assert.equal(action, item.block ? 'block' : 'continue', item.name);
  });
}
