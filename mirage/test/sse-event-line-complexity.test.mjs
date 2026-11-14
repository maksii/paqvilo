// @test-kind security: SSE parsing avoids repeated scans of malformed long event names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { eventLineParts } from '../testing/event-line.mjs';

test('SSE field parsing preserves colon, space, and line-terminator behavior', () => {
  assert.deepEqual(eventLineParts('data: hello:world'), ['data', 'hello:world']);
  assert.deepEqual(eventLineParts('data:  text'), ['data', ' text']);
  assert.deepEqual(eventLineParts('no colon\u2028'), ['no colon\u2028', '']);
  assert.equal(eventLineParts(`${'x'.repeat(100_000)}:text\u2028`), null);
});
