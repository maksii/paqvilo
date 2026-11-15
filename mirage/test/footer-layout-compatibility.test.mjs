// @test-kind compatibility: footer CSS matching retains the original source and malformed-input semantics
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerShellConventions } from '../lib/extensions.mjs';
import { observedFooterLayout } from '../lib/footer-capture.mjs';

registerShellConventions('footer-layout-compatibility', { footerLogoClass: 'fixture-footer-logo' });
const path = '/styles/fixture.css';
const sourceCss = '.fixture-footer-logo svg { max-height: 2rem }';
// Captured from e66e7154 by .paqvilo/pr40/generate-footer-baseline.mjs.
const baseline = JSON.parse(readFileSync(new URL('./fixtures/footer-layout-base.json', import.meta.url), 'utf8'));

test('footer layout matches the base algorithm on generated and malformed CSS', () => {
  const atoms = [
    '.fixture-footer-logo svg{width:auto}',
    '.fixture-footer-logo svg{x:1}',
    '.other{}',
    '}',
    '{',
    '/*',
    '*/',
    '"',
    "'",
    '\\',
    ' ',
    '\n',
    ';width:auto;',
    '/*x*/',
  ];
  let seed = 0x12345678;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % atoms.length;
  const fixtures = [
    '',
    '/* unclosed /*',
    '.other{} .fixture-footer-logo svg{width:auto}',
    '"\\} .fixture-footer-logo svg{width:auto}',
  ];
  for (let sample = 0; sample < 2000; sample++) {
    let css = '';
    for (let part = 0, n = next() + 1; part < n; part++) css += atoms[next()];
    fixtures.push(css);
  }
  assert.equal(baseline.base, 'e66e7154');
  assert.equal(fixtures.length, baseline.results.length);
  for (const [index, observedCss] of fixtures.entries())
    assert.deepEqual(
      observedFooterLayout({ path, sourceCss, observedCss }) ?? null,
      baseline.results[index],
      observedCss,
    );
});

// @test-kind security: many matching CSS rules are scanned with bounded work and preserve the result
test('footer layout handles many candidate rules and unterminated comments', () => {
  const observedCss = '.other{} .fixture-footer-logo svg{height:1px}'.repeat(30000) + '/*'.repeat(30000);
  assert.equal(observedFooterLayout({ path, sourceCss, observedCss }), undefined);
});
