// Shared storage provider contract suite. A project runs it against its own adapter:
//   runStorageContract(test, async (t) => myProvider(t), { skip: ['sas'] });
// makeProvider(t) returns a fresh, empty provider and registers its own cleanup with t.after().
// Every case drives the provider through guardProvider(), the same wrapper the storage router uses.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ProviderError, guardProvider } from '../lib/storage-provider.mjs';
import { systemClock } from '../lib/runtime-clock.mjs';

export const STORAGE_CONTRACT_CASES = Object.freeze([
  'round-trip',
  'range',
  'conditions',
  'block-commit',
  'list-paging',
  'sas',
  'key-rejection',
  'large-stream',
  'unavailable',
  'delete',
  'head',
]);

async function bytesOf(body) {
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
const providerError = (code) => (error) => {
  assert.ok(error instanceof ProviderError, `expected ProviderError ${code}, got ${error?.name}: ${error?.message}`);
  assert.equal(error.code, code);
  assert.equal(typeof error.provider, 'string');
  return true;
};

// clock.now() (epoch ms) sets the SAS expiries, so a provider built on a fixed clock passes the same way as one on wall time.
export function runStorageContract(
  test,
  makeProvider,
  { skip = [], label = 'storage contract', clock = systemClock } = {},
) {
  for (const name of skip)
    if (!STORAGE_CONTRACT_CASES.includes(name)) throw new TypeError(`Unknown storage contract case '${name}'`);
  const raw = new WeakMap();
  const make = async (t) => {
    const provider = await makeProvider(t);
    const guarded = guardProvider(provider);
    raw.set(guarded, provider);
    return guarded;
  };
  const run = (name, title, fn) =>
    test(`${label} ${name}: ${title}`, { skip: skip.includes(name) }, async (t) => fn(await make(t), t));

  run('round-trip', 'put then get returns the same bytes, content type and metadata', async (s) => {
    const put = await s.put('contract/round.txt', Buffer.from('invented bytes'), {
      contentType: 'text/plain',
      metadata: { origin: 'contract' },
    });
    assert.equal(put.key, 'contract/round.txt');
    assert.equal(put.size, 14);
    assert.equal(put.sha256, createHash('sha256').update('invented bytes').digest('hex'));
    assert.ok(put.etag);
    const got = await s.get('Contract/Round.txt');
    assert.equal((await bytesOf(got.body)).toString(), 'invented bytes');
    assert.equal(got.contentType, 'text/plain');
    assert.deepEqual(got.metadata, { origin: 'contract' });
    assert.equal(got.etag, put.etag);
    const empty = await s.put('contract/empty', Buffer.alloc(0));
    assert.equal(empty.size, 0);
    assert.equal((await bytesOf((await s.get('contract/empty')).body)).length, 0);
  });

  run('range', 'get with an inclusive range returns that slice', async (s) => {
    await s.put('contract/range.bin', Buffer.from('0123456789'));
    const got = await s.get('contract/range.bin', { range: { start: 2, end: 5 } });
    assert.equal((await bytesOf(got.body)).toString(), '2345');
    assert.deepEqual(got.range, { start: 2, end: 5 });
    assert.equal((await bytesOf((await s.get('contract/range.bin', { range: { start: 7 } })).body)).toString(), '789');
    await assert.rejects(s.get('contract/range.bin', { range: { start: 10, end: 12 } }), providerError('InvalidRange'));
  });

  run('conditions', 'ETag changes per write and If-Match / If-None-Match are enforced', async (s) => {
    const first = await s.put('contract/etag', Buffer.from('a'));
    const second = await s.put('contract/etag', Buffer.from('a'), { ifMatch: first.etag });
    assert.notEqual(second.etag, first.etag);
    await assert.rejects(
      s.put('contract/etag', Buffer.from('b'), { ifMatch: first.etag }),
      providerError('PreconditionFailed'),
    );
    await assert.rejects(s.put('contract/etag', Buffer.from('b'), { ifNoneMatch: '*' }), providerError('Conflict'));
    await s.put('contract/etag-new', Buffer.from('c'), { ifNoneMatch: '*' });
    await assert.rejects(
      s.put('contract/etag-missing', Buffer.from('d'), { ifMatch: '*' }),
      providerError('PreconditionFailed'),
    );
    const notModified = await s.get('contract/etag', { ifNoneMatch: second.etag });
    assert.equal(notModified.notModified, true);
    assert.equal(notModified.body, null);
    const modified = await s.get('contract/etag', { ifNoneMatch: first.etag });
    assert.equal((await bytesOf(modified.body)).toString(), 'a');
    await assert.rejects(s.delete('contract/etag', { ifMatch: first.etag }), providerError('PreconditionFailed'));
    assert.equal(await s.delete('contract/etag', { ifMatch: second.etag }), true);
  });

  run('block-commit', 'staged blocks commit in the listed order and are invisible before commit', async (s) => {
    await s.put('contract/blocks', Buffer.from('BB'), { blockId: 'b' });
    await s.put('contract/blocks', Buffer.from('AA'), { blockId: 'a' });
    await s.put('contract/blocks', Buffer.from('ignored'), { blockId: 'unused' });
    assert.equal(await s.head('contract/blocks'), null);
    const committed = await s.commit('contract/blocks', ['a', 'b', 'a'], { contentType: 'application/x-invented' });
    assert.equal(committed.size, 6);
    const got = await s.get('contract/blocks');
    assert.equal((await bytesOf(got.body)).toString(), 'AABBAA');
    assert.equal(got.contentType, 'application/x-invented');
    await assert.rejects(s.commit('contract/other', ['missing']), providerError('NotFound'));
  });

  run('list-paging', 'list filters by prefix and pages with a continuation token', async (s) => {
    for (const name of ['p/c', 'p/a', 'p/e', 'p/b', 'p/d', 'q/a']) await s.put(name, Buffer.from(name));
    const seen = [];
    let continuation = null,
      pages = 0;
    do {
      const page = await s.list('p/', { pageSize: 2, continuation });
      assert.ok(page.items.length <= 2);
      for (const item of page.items) {
        assert.equal(typeof item.size, 'number');
        assert.ok(item.etag);
        seen.push(item.key);
      }
      continuation = page.continuation;
      pages += 1;
    } while (continuation && pages < 10);
    assert.deepEqual(seen, ['p/a', 'p/b', 'p/c', 'p/d', 'p/e']);
    assert.equal(pages, 3);
    assert.deepEqual((await s.list('missing/')).items, []);
  });

  run('sas', 'SAS URLs verify, and expired, tampered or under-privileged URLs are refused', async (s) => {
    await s.put('contract/sas.txt', Buffer.from('signed'));
    const url = await s.sas('contract/sas.txt', { permission: 'r', expiresOn: new Date(clock.now() + 60_000) });
    assert.doesNotMatch(url, /\.\./);
    const verified = await s.verifySas(url);
    assert.equal(verified.key, 'contract/sas.txt');
    assert.equal(verified.permission, 'r');
    await assert.rejects(s.verifySas(url, { permission: 'w' }), providerError('Unauthorized'));
    const expired = await s.sas('contract/sas.txt', { permission: 'r', expiresOn: new Date(clock.now() - 1000) });
    await assert.rejects(s.verifySas(expired), providerError('Unauthorized'));
    const tampered = new URL(url, 'http://localhost');
    tampered.searchParams.set('sp', 'rw');
    await assert.rejects(s.verifySas(tampered.href), providerError('Unauthorized'));
    await assert.rejects(s.verifySas(url.replace('sas.txt', 'other.txt')), providerError('Unauthorized'));
  });

  run('key-rejection', 'invalid keys are refused before the implementation sees them', async (s) => {
    const bad = [
      '',
      '/leading',
      'a/../b',
      '..',
      'a/./b',
      'a//b',
      'a/.',
      'a\\b',
      'nul\0key',
      '-dash-first',
      'space key',
      'query?x=1',
      'a'.repeat(1025),
      42,
    ];
    for (const key of bad) {
      await assert.rejects(
        s.put(key, Buffer.from('x')),
        providerError('InvalidKey'),
        `put accepted ${JSON.stringify(String(key).slice(0, 20))}`,
      );
      await assert.rejects(s.get(key), providerError('InvalidKey'));
    }
    await assert.rejects(s.list('../'), providerError('InvalidKey'));
    const error = await s.put('secret?sig=abc', Buffer.from('x')).catch((e) => e);
    assert.doesNotMatch(error.message, /sig=abc/);
  });

  run('large-stream', 'a 20 MiB AsyncIterable body is consumed as a stream and read back in chunks', async (s) => {
    const chunkSize = 64 * 1024,
      chunks = 320; // 20 MiB
    const written = createHash('sha256');
    let produced = 0;
    async function* body() {
      // One reused buffer: a provider that keeps references instead of consuming each chunk stores corrupt bytes.
      const chunk = Buffer.allocUnsafe(chunkSize);
      for (let i = 0; i < chunks; i += 1) {
        chunk.fill(i % 251);
        written.update(chunk);
        produced += 1;
        yield chunk;
      }
    }
    const put = await s.put('contract/large.bin', body());
    assert.equal(produced, chunks);
    assert.equal(put.size, chunkSize * chunks);
    const expected = written.digest('hex');
    assert.equal(put.sha256, expected);
    const got = await s.get('contract/large.bin');
    const read = createHash('sha256');
    let largest = 0,
      size = 0;
    for await (const piece of got.body) {
      read.update(piece);
      largest = Math.max(largest, piece.length);
      size += piece.length;
    }
    assert.equal(size, chunkSize * chunks);
    assert.equal(read.digest('hex'), expected);
    assert.ok(largest < size / 4, `get returned one ${largest}-byte chunk instead of a stream`);
  });

  run('unavailable', 'a closed provider and connection failures answer Unavailable', async (s) => {
    const provider = raw.get(s);
    // Connection-level failures from an adapter map to Unavailable without the adapter doing it.
    const refusing = guardProvider({
      ...provider,
      descriptor: provider.descriptor,
      async get() {
        throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' });
      },
    });
    await assert.rejects(refusing.get('contract/any'), providerError('Unavailable'));
    await s.close();
    await assert.rejects(s.put('contract/after-close', Buffer.from('x')), providerError('Unavailable'));
    await assert.rejects(s.head('contract/after-close'), providerError('Unavailable'));
  });

  run('delete', 'delete is idempotent and reports whether the object existed', async (s) => {
    await s.put('contract/delete', Buffer.from('x'));
    assert.equal(await s.delete('contract/delete'), true);
    assert.equal(await s.delete('contract/delete'), false);
    await assert.rejects(s.get('contract/delete'), providerError('NotFound'));
  });

  run('head', 'head returns metadata for an object and null when absent', async (s) => {
    assert.equal(await s.head('contract/absent'), null);
    const put = await s.put('contract/head', Buffer.from('abc'), { contentType: 'text/plain', metadata: { a: '1' } });
    const head = await s.head('contract/head');
    assert.equal(head.size, 3);
    assert.equal(head.etag, put.etag);
    assert.equal(head.contentType, 'text/plain');
    assert.deepEqual(head.metadata, { a: '1' });
    assert.ok(!Number.isNaN(Date.parse(head.lastModified)));
    assert.equal(head.body, undefined);
  });
}
