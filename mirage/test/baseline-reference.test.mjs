import test from 'node:test';
import assert from 'node:assert/strict';
import { redact, leaks } from '../../scripts/baseline-reference.mjs';

test('the reference reduces ids, URL hosts and e-mail addresses and flags what remains', () => {
  const text = redact(
    'Sign in "https://login.windows.net/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b/oauth2" by a.b@example.invalid',
  );
  assert.equal(text, 'Sign in "https://{host}/{guid}/oauth2" by {email}');
  assert.deepEqual(leaks(text), []);
  assert.deepEqual(leaks('served by tenant.powerappsportals.com'), ['tenant.powerappsportals.com']);
});
