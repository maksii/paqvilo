import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectionSummary } from '../lense/inspection-summary.mjs';
test('inspection summaries preserve refusal details and count missing arrays without fabricating access', () => {
  const report = {
    path: '/private',
    revision: 7,
    permissionMode: 'enforce',
    sourceRoots: ['invented'],
    page: {
      name: 'Private',
      url: '/private',
      access: { allowed: false, status: 403, code: 'Denied', reason: 'Member required', rules: [{ id: 'rule' }] },
    },
    tables: [{ logicalName: 'specimen' }],
    related: { shortcuts: [1, 2] },
  };
  const summary = inspectionSummary(report);
  assert.equal(summary.revision, 7);
  assert.deepEqual(summary.page.access, { allowed: false, status: 403, code: 'Denied', reason: 'Member required' });
  assert.deepEqual(summary.tables, ['specimen']);
  assert.equal(summary.counts.accessRules, 1);
  assert.equal(summary.counts.related, 2);
  assert.equal(summary.counts.templates, 0);
  assert.equal(inspectionSummary({ page: { name: 'Unknown' } }).page.access.allowed, null);
  assert.equal(inspectionSummary({}).page, null);
});
