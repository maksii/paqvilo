// @test-kind security: HTML snippet conversion stays responsive for unbounded malformed tags while preserving displayed text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registrationSnippetText } from '../lib/registration-snippet-text.mjs';

test('registration snippet removes tags and preserves block separation and entity order', () => {
  assert.equal(registrationSnippetText('<p>Hi&nbsp;<b>A</b></p><div>&amp;lt; &lt; &#39;</div>'), "Hi A &lt; < '");
  // Base e66e7154 consumes from the first opener through the next closing angle bracket.
  assert.equal(registrationSnippetText('<p unfinished <strong>text'), 'text');
  assert.equal(registrationSnippetText('<p x <b>text</b>tail'), 'texttail');
});

test('registration snippet handles long malformed tag prefixes', () => {
  const value = '<p '.repeat(100_000);
  assert.equal(registrationSnippetText(value), value.trim());
  assert.equal(registrationSnippetText('<'.repeat(100_000)), '<'.repeat(100_000));
});
