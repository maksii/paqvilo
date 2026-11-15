// @test-kind contract: the supplied matrix logger observes successive stages in their original order.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { sourceFixture } from './fixtures/source-site.mjs';
import { portalMatrix } from '../portal-matrix.mjs';

test('the next portal stage starts before work queued by the prior completion logger', async (t) => {
  const { root } = await sourceFixture(t, {
    prefix: 'paqvilo-matrix-order-',
    files: {
      'a/website.yml': 'adx_websiteid: site-a\nadx_name: A\n',
      'b/website.yml': 'adx_websiteid: site-b\nadx_name: B\n',
      'mirage.project.yml':
        'version: 2\ndefaultPortal: a\nwatch: false\nportals:\n  - { id: a, path: a }\n  - { id: b, path: b }\nsolutions: []\nreferences: []\n',
    },
  });
  const events = [];
  await portalMatrix({
    project: path.join(root, 'mirage.project.yml'),
    only: ['import'],
    log: (line) => {
      if (line.startsWith('a: import ') && !line.includes('…')) {
        events.push('a-done');
        queueMicrotask(() => events.push('marker'));
      }
      if (line.startsWith('b: import…')) events.push('b-start');
    },
  });
  assert.deepEqual(events, ['a-done', 'b-start', 'marker']);
});
