// @test-kind security: local CAPTCHA fixture proofs are bounded, private, expiring, single-use, and scoped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createLocalCaptcha } from '../lib/local-captcha.mjs';

const scope = { owner: 'visitor:one', kind: 'webform', formId: 'entry', stepId: 'second' };
const challenge = () => ({ prompt: 'What is 2 + 3?', answer: '5' });

test('a fixture CAPTCHA proof can be redeemed only once for its original visitor, form and step', () => {
  const captcha = createLocalCaptcha({ challenge });
  const issued = captcha.issue(scope);
  assert.deepEqual(Object.keys(issued).sort(), ['id', 'prompt']);
  const proof = { challengeId: issued.id, answer: '5' };
  assert.equal(captcha.redeem({ ...scope, owner: 'visitor:other' }, proof), false);
  assert.equal(captcha.redeem({ ...scope, formId: 'other' }, proof), false);
  assert.equal(captcha.redeem({ ...scope, stepId: 'third' }, proof), false);
  assert.equal(captcha.redeem({ ...scope, kind: 'entityform' }, proof), false);
  assert.equal(captcha.redeem(scope, proof), true);
  assert.equal(captcha.redeem(scope, proof), false);
});

test('a fixture CAPTCHA answer expires at its deadline and a wrong answer cannot be replayed', () => {
  let now = 25;
  const captcha = createLocalCaptcha({ challenge, now: () => now, lifetimeMs: 10 });
  const wrong = captcha.issue(scope);
  assert.equal(captcha.redeem(scope, { challengeId: wrong.id, answer: '7' }), false);
  assert.equal(captcha.redeem(scope, { challengeId: wrong.id, answer: '5' }), false);
  const expired = captcha.issue(scope);
  now = 35;
  assert.equal(captcha.redeem(scope, { challengeId: expired.id, answer: '5' }), false);
});

test('only valid fixture results with an owner can issue proofs and the live challenge window is bounded', () => {
  const invalid = createLocalCaptcha({ challenge: () => ({ prompt: 'No answer' }) });
  assert.equal(invalid.issue(scope), null);
  const captcha = createLocalCaptcha({ challenge, limit: 1 });
  assert.equal(captcha.issue({ ...scope, owner: null }), null);
  const first = captcha.issue(scope);
  captcha.issue(scope);
  assert.equal(captcha.redeem(scope, { challengeId: first.id, answer: '5' }), false);
});

test('the browser JSON submit handler reads fixture proof fields into the dedicated proof envelope', async () => {
  const runtime = readFileSync(new URL('../lib/webforms-compat.js', import.meta.url), 'utf8');
  const portalSimulation = { postbackToken: 'test-token' };
  const send = [];
  runInNewContext(runtime, {
    document: { readyState: 'loading', addEventListener() {} },
    location: { pathname: '/form/', search: '', assign() {} },
    URLSearchParams,
    CustomEvent: class {},
    __portalSimulation: portalSimulation,
    async fetch(url, options) {
      send.push({ url, body: JSON.parse(options.body) });
      return {
        ok: true,
        async json() {
          return { outcome: { type: 'redirect', url: '/done/' } };
        },
      };
    },
  });
  const controls = {
    'script[type="application/json"][data-paqvilo-mirage-form-config]': {
      textContent: JSON.stringify({ operation: 'create', submitUrl: '/submit', fields: [] }),
    },
    '[data-pp-captcha-challenge]': { value: 'opaque' },
    '[data-pp-captcha-answer]': { value: '5' },
  };
  await portalSimulation.webForms.submit(
    {
      querySelector: (selector) => controls[selector] ?? null,
      querySelectorAll: () => [],
      dispatchEvent() {},
    },
    'submit',
  );
  assert.equal(send.length, 1);
  assert.equal(send[0].url, '/submit');
  assert.deepEqual(send[0].body.captchaProofToken, { challengeId: 'opaque', answer: '5' });
  assert.deepEqual(send[0].body.values, {});
});
