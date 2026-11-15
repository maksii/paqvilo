// @test-kind tooling: the tests' timer attribution names the module whose frame called a replaced timer function.
import assert from 'node:assert/strict';
import test from 'node:test';
import { calledFrom } from './support/timer-origin.mjs';
import { armTimer } from './fixtures/timer-origin-caller.mjs';

const CALLER = new URL('./fixtures/timer-origin-caller.mjs', import.meta.url).href;
const FIXTURES = new URL('./fixtures/', import.meta.url).href;
const ELSEWHERE = new URL('../lib/', import.meta.url).href;

test('a replaced timer call is attributed to the module and directory of the frame that made it', (t) => {
  const seen = [];
  t.mock.method(globalThis, 'setTimeout', () => {
    seen.push([
      calledFrom(CALLER, import.meta.url),
      calledFrom(FIXTURES, import.meta.url),
      calledFrom(ELSEWHERE, import.meta.url),
    ]);
  });
  armTimer();
  assert.deepEqual(seen, [[true, true, false]]);
});

test('a timer call made by the recording test file itself is attributed to no other module', (t) => {
  const seen = [];
  t.mock.method(globalThis, 'setTimeout', () => {
    seen.push([
      calledFrom(CALLER, import.meta.url),
      calledFrom(FIXTURES, import.meta.url),
      calledFrom(ELSEWHERE, import.meta.url),
    ]);
  });
  setTimeout(() => {}, 0);
  assert.deepEqual(seen, [[false, false, false]]);
});

test('a call that does not pass through the named recorder is attributed to nothing', (t) => {
  const seen = [];
  t.mock.method(globalThis, 'setTimeout', () => {
    seen.push(calledFrom(CALLER, new URL('./not-the-recorder.mjs', import.meta.url).href));
  });
  armTimer();
  assert.deepEqual(seen, [false]);
});

test('attribution leaves the stack trace limit as it found it', (t) => {
  const limit = Error.stackTraceLimit;
  t.after(() => {
    Error.stackTraceLimit = limit;
  });
  Error.stackTraceLimit = 3;
  calledFrom(CALLER, import.meta.url);
  assert.equal(Error.stackTraceLimit, 3);
});
