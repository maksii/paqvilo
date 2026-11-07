import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { startSaver } from '../baseline-suite.mjs';

const post = (saver, run, body) =>
  fetch(saver.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-baseline-token': saver.token, 'x-baseline-run': run },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
function stream(saver, run) {
  let request;
  const replied = new Promise((resolve, reject) => {
    request = http.request(
      saver.url,
      {
        method: 'POST',
        headers: { 'x-baseline-token': saver.token, 'x-baseline-run': run, 'content-type': 'application/json' },
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      },
    );
    request.on('error', reject);
    request.write('{"fixture":"');
  });
  // A close test intentionally aborts the request before a response exists.
  void replied.catch(() => {});
  return { request, replied };
}
// The receiver's server, captured as startSaver creates it. Its handler is the first 'request' listener, so a 'request'
// listener added here runs after the receiver has admitted (or refused) the headers: the signal a streamed post waits for.
async function observedSaver(t) {
  let server;
  const create = http.createServer;
  const created = t.mock.method(http, 'createServer', (...args) => (server = create(...args)));
  const saver = await startSaver();
  created.mock.restore();
  return { saver, admitted: () => once(server, 'request') };
}

test('streaming old headers cannot deliver their body to the next run', async (t) => {
  const { saver, admitted } = await observedSaver(t);
  t.after(() => saver.close());
  const first = saver.expect();
  const headers = admitted();
  const pending = stream(saver, first.run);
  await headers;
  const next = saver.expect();
  let settled = false;
  next.received.then(
    () => (settled = true),
    () => (settled = true),
  );
  pending.request.end('previous-run"}');
  // The receiver settles a wait while it handles the body, before it sends the 409 the client reads here.
  assert.equal(await pending.replied, 409);
  await assert.rejects(first.received, /superseded/);
  assert.equal(settled, false, 'the rejected old body must not resolve/reject the new promise');
  assert.equal((await post(saver, next.run, { fixture: 'next-run' })).status, 204);
  assert.deepEqual(await next.received, { fixture: 'next-run' });
  assert.deepEqual(
    saver.late.map((value) => value.run),
    [first.run],
  );
});

test('malformed evidence rejects its own wait without an unhandled rejection before the caller awaits it', async (t) => {
  const saver = await startSaver();
  t.after(() => saver.close());
  const expected = saver.expect();
  assert.equal((await post(saver, expected.run, '{malformed-json')).status, 400);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(expected.received, SyntaxError);
  const next = saver.expect();
  assert.equal((await post(saver, next.run, { fixture: 'valid' })).status, 204);
  assert.deepEqual(await next.received, { fixture: 'valid' });
});

test('a consumed run refuses duplicate posts without changing its result', async (t) => {
  const saver = await startSaver();
  t.after(() => saver.close());
  const expected = saver.expect();
  assert.equal((await post(saver, expected.run, { fixture: 'first' })).status, 204);
  assert.deepEqual(await expected.received, { fixture: 'first' });
  assert.equal((await post(saver, expected.run, { fixture: 'duplicate' })).status, 409);
  assert.deepEqual(await expected.received, { fixture: 'first' });
});

test('closing an incomplete owned request settles the wait and releases all receiver connections', async (t) => {
  const { saver, admitted } = await observedSaver(t);
  const expected = saver.expect();
  const headers = admitted();
  const pending = stream(saver, expected.run);
  await headers;
  const first = saver.close(),
    second = saver.close();
  assert.strictEqual(first, second);
  await first;
  await assert.rejects(expected.received, /receiver closed/);
  assert.throws(() => saver.expect(), /receiver is closed/);
  pending.request.destroy();
});

test('aborted evidence rejects only the corresponding wait and a later run still works', async (t) => {
  const { saver, admitted } = await observedSaver(t);
  t.after(() => saver.close());
  const expected = saver.expect();
  const headers = admitted();
  const pending = stream(saver, expected.run);
  await headers;
  pending.request.destroy();
  await assert.rejects(expected.received, /before its body completed|aborted/);
  const next = saver.expect();
  assert.equal((await post(saver, next.run, { fixture: 'recovered' })).status, 204);
  assert.deepEqual(await next.received, { fixture: 'recovered' });
});
