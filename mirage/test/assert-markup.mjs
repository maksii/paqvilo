import assert from 'node:assert/strict';
import { parseFragment } from 'parse5';

/** Inspect actual HTML elements, including template content and mixed-case tags. */
export function assertNoElements(markup, names) {
  const forbidden = new Set(names.map(name => name.toLowerCase()));
  const pending = [parseFragment(markup)];
  while (pending.length) {
    const node = pending.pop();
    assert.equal(forbidden.has(node.tagName?.toLowerCase()), false, `Unexpected ${node.tagName} element`);
    pending.push(...node.childNodes ?? []);
    if (node.content) pending.push(node.content);
  }
}
