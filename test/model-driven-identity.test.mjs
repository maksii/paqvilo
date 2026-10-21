import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createModelDrivenIdentity } from '../lense/model-driven-identity.mjs';
import { interceptOrigin } from '../lense/intercept.mjs';
import { fakeBrowser } from './fake-browser.mjs';

test('request identity affects only owned same-origin Dataverse API requests, preserves explicit callers and stops without replay', async () => {
  const origin = 'https://invented.example.com', b = fakeBrowser(), owned = b.openTab(origin + '/main.aspx'), other = b.openTab(origin + '/main.aspx');
  const identity = createModelDrivenIdentity({ origin, page: owned.page }), objectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  assert.equal(identity.start('not-a-guid'), false); assert.equal(identity.start(objectId), true);
  const dispose = await interceptOrigin(b.context, origin, async route => { identity.prepare(route); await route.fallback(); }, { ownsPage: page => page === owned.page });
  try {
    assert.equal(other.cdp.listenerCount('Fetch.requestPaused'), 0);
    const cases = [
      ['/api/data/v9.2/inv_items', {}, true],
      ['/api/data/v9.2/$batch', { authorization: 'invented-test-token' }, true],
      ['/api/data/v9.2/inv_items', { MSCRMCallerID: 'explicit-native-caller' }, false],
      ['/api/data/v9.2/inv_items', { CallerObjectId: 'explicit-native-caller' }, false],
      ['/api/data/v9.2evil/inv_items', {}, false],
      ['/WebResources/code.js', {}, false],
      ['https://foreign.example/api/data/v9.2/inv_items', {}, false],
    ];
    for (const [index, [path, headers, expected]] of cases.entries()) {
      owned.cdp.emit('Fetch.requestPaused', { requestId: String(index), frameId: 'main', resourceType: 'XHR', request: { url: new URL(path, origin).href, method: 'PATCH', headers } });
      await setImmediate();
      const answers = b.answers(String(index)); assert.equal(answers.length, 1);
      const added = answers[0].headers?.find(header => header.name === 'callerobjectid');
      assert.equal(added?.value === objectId, expected);
      if (expected && headers.authorization) assert.equal(answers[0].headers.find(header => header.name === 'authorization').value, headers.authorization);
    }
    identity.stop(); assert.equal(identity.active, false);
    owned.cdp.emit('Fetch.requestPaused', { requestId: 'stopped', resourceType: 'Fetch', request: { url: origin + '/api/data/v9.2/inv_items', method: 'POST', headers: {} } });
    await setImmediate(); assert.equal(b.answers('stopped')[0].headers, undefined);
    identity.close(); assert.equal(identity.start(objectId), false);
    assert.equal(b.fetched.length, 0, 'continued writes are not resent by an API client');
  } finally { await dispose(); }
});
