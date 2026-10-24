import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNoElements } from './assert-markup.mjs';

test('markup checks reject mixed-case and template-contained elements while accepting escaped labels', () => {
  assertNoElements('&lt;SCRIPT&gt;label&lt;/SCRIPT&gt;', ['script']);
  for (const markup of ['<ScRiPt>1</ScRiPt>', '<template><SCRIPT>1</SCRIPT></template>', '<IMG src=x>']) {
    assert.throws(() => assertNoElements(markup, ['script', 'img']), /Unexpected/);
  }
});
