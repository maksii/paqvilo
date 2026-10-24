import test from 'node:test';
import assert from 'node:assert/strict';
import { qualifyNativePaging } from '../portal-harness/native-paging.mjs';
test('native paging requires contiguous successful terminal pages and the same complete source/version witnesses', () => {
  const snapshot = {
      siteId: 'site',
      contactId: 'actor',
      complete: true,
      permissionSnapshotHash: 'p',
      membershipSnapshotHash: 'm',
      dataSnapshotHash: 'd',
      rowVersionSnapshotHash: 'v',
    },
    plan = {
      id: 'invented',
      primaryId: 'widgetid',
      pageSize: 2,
      fields: [{ name: 'widgetid', source: 'widgetid', type: 'guid' }],
    };
  const part = (page, ids, more) => ({
    before: snapshot,
    after: snapshot,
    capture: {
      requests: ['liquid', 'webapi'].map((lane) => ({ caseId: 'invented', lane, page, operationId: lane + page })),
      liquidPages: [
        { operationId: 'liquid' + page, outcome: 'success', rows: ids.map((widgetid) => ({ widgetid })), more },
      ],
      results: [
        {
          lane: 'webapi',
          operationId: 'webapi' + page,
          status: 200,
          body: JSON.stringify({ value: ids.map((widgetid) => ({ widgetid })) }),
        },
      ],
    },
  });
  const first = part(1, ['one', 'two'], true),
    last = part(2, ['three'], false),
    extra = part(3, [], false),
    okay = qualifyNativePaging({ captures: [first, last, extra], plan });
  assert.equal(okay.qualified, true);
  assert.equal(okay.equal, true);
  assert.equal(okay.lanes.liquid.count, 3);
  assert.equal(okay.lanes.liquid.extraPages, 1);
  for (const captures of [
    [first],
    [last],
    [first, first, last],
    [first, part(2, ['one'], false)],
    [first, { ...last, after: { ...snapshot, rowVersionSnapshotHash: 'changed' } }],
  ])
    assert.equal(qualifyNativePaging({ captures, plan }).qualified, false);
});
