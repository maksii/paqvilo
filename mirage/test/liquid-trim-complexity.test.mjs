// @test-kind security: Liquid whitespace control handles long template literals without repeated suffix scans.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assignParts, tokenize, variableSegments } from '../lib/liquid-engine.mjs';
import { workerAnswer } from './support/worker-answer.mjs';

// The unanchored patterns that the linear scans replaced. They are the oracle of the differential tests only.
const WORD = String.raw`\p{L}\p{Mn}\p{Nd}\p{Pc}`;
const OLD_ASSIGN = new RegExp(String.raw`((?:\(?[${WORD}\-.[\]]\)?)+)\s*=\s*(.*)\s*`, 'u');
const OLD_VARIABLE = new RegExp(String.raw`\[[^\]]+\]|[${WORD}\-]+\??`, 'gu');
const DIFFERENTIAL_INPUTS = 200_000;
const DIFFERENTIAL_ALPHABET = [...'aZ_9é=  \n-\'"|()[].'];

// A seeded generator (mulberry32), so every run compares the same inputs.
function seededRandom(seed) {
  let state = seed;
  return (count) => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * count);
  };
}

function randomMarkup(random, maxLength) {
  let text = '';
  for (let length = random(maxLength + 1); length > 0; length--)
    text += DIFFERENTIAL_ALPHABET[random(DIFFERENTIAL_ALPHABET.length)];
  return text;
}

const ENGINE_URL = new URL('../lib/liquid-engine.mjs', import.meta.url).href;
const WORKER_SOURCE = `
  const { parentPort, workerData } = require('node:worker_threads');
  import(workerData.module).then(async ({ LiquidContext, LiquidEngine }) => {
    const engine = new LiquidEngine({ loadTemplateSource: async () => '' });
    try {
      await engine.parse(workerData.source).render(new LiquidContext(engine, {}));
      parentPort.postMessage({ ok: true });
    } catch (error) {
      parentPort.postMessage({ ok: false, name: error.constructor.name, message: error.message });
    }
  });
`;

// Parsing is synchronous, so a hostile template runs in a worker that posts one answer and then ends by itself. The
// answer is returned after the worker's own exit; the test's timeout, through the signal, is the hang guard.
function renderInWorker(source, signal) {
  return workerAnswer(WORKER_SOURCE, { eval: true, workerData: { module: ENGINE_URL, source }, signal });
}

test('left whitespace control trims only final spaces and tabs', () => {
  // Base e66e7154 normalizes the trim marker in the emitted token.
  assert.deepEqual([...tokenize('before \t{{- x }}')], ['before', '{{ x }}']);
  const literal = `${' '.repeat(100_000)}x`;
  assert.equal(tokenize(`${literal}{{- x }}`)[0], literal);
  assert.equal(tokenize('before\n \t{{- x }}')[0], 'before\n');
});

test('a malformed assign with a long parenthesised name raises the syntax error', async (t) => {
  const outcome = await renderInWorker(`{% assign ${'(a)'.repeat(200_000)}x %}`, t.signal);
  assert.deepEqual(outcome, {
    ok: false,
    name: 'LiquidSyntaxError',
    message: "Syntax Error in 'assign' tag - Valid syntax: assign [var] = [source]",
  });
});

test('a long unclosed variable path parses and renders without a quadratic scan', async (t) => {
  assert.deepEqual(await renderInWorker(`{{ ${'a['.repeat(100_000)} }}`, t.signal), { ok: true });
});

// @test-kind contract: the linear assign scan gives the unanchored pattern's name and value on seeded inputs.
test('assign name and value match the unanchored pattern on seeded inputs', () => {
  const random = seededRandom(20_261_112);
  for (let index = 0; index < DIFFERENTIAL_INPUTS; index++) {
    const markup = randomMarkup(random, 12);
    const expected = OLD_ASSIGN.exec(markup);
    const found = assignParts(markup);
    assert.deepEqual(
      found ? [found.name, found.value] : null,
      expected ? [expected[1], expected[2]] : null,
      JSON.stringify(markup),
    );
  }
});

// @test-kind contract: the linear variable scan gives the bracket and name pattern's segments on seeded inputs.
test('variable path segments match the bracket and name pattern on seeded inputs', () => {
  const random = seededRandom(20_261_113);
  for (let index = 0; index < DIFFERENTIAL_INPUTS; index++) {
    const markup = randomMarkup(random, 14);
    assert.deepEqual(
      variableSegments(markup),
      [...markup.matchAll(OLD_VARIABLE)].map((match) => match[0]),
      JSON.stringify(markup),
    );
  }
});
