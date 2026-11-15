// @test-kind security: legacy form trim overrides handle long nonterminal whitespace without repeated rescans.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

for (const file of ['xrm-webform-compat.js', 'crmentityformview-compat.js']) {
  test(`${file} trims only the original whitespace characters`, () => {
    const source = readFileSync(new URL(`../lib/${file}`, import.meta.url), 'utf8');
    const marker = 'String.prototype.trim = function () {';
    const start = source.indexOf(marker);
    const end = source.indexOf('  };', start);
    assert.ok(start >= 0 && end > start);
    const trim = runInNewContext(`'use strict'; (${source.slice(start + marker.indexOf('function'), end).trim()}})`);
    assert.equal(trim.call('  text \t'), 'text');
    const text = `${' '.repeat(100_000)}x${' '.repeat(100_000)}y`;
    assert.equal(trim.call(text), `x${' '.repeat(100_000)}y`);
    let getters = 0;
    let calls = 0;
    const receiver = {
      get replace() {
        getters++;
        return function (...args) {
          calls++;
          assert.equal(this, receiver);
          assert.equal(args.length, 2);
          assert.equal(args[0].flags, 'g');
          assert.equal(args[1], '');
          return 'custom';
        };
      },
    };
    assert.equal(trim.call(receiver), 'custom');
    assert.equal(getters, 1);
    assert.equal(calls, 1);
    const failure = new Error('fixture replace failure');
    assert.throws(
      () =>
        trim.call({
          replace() {
            throw failure;
          },
        }),
      (error) => error === failure,
    );
    assert.throws(
      () => trim.call(null),
      (error) => error?.name === 'TypeError',
    );
  });
}
