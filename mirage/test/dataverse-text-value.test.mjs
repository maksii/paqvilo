import { specimenApi, ID, API } from './support/specimen-api.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { encodeDataverseText } from '../lib/dataverse-text-value.mjs';
test('primitive text encoding respects explicit provider MIME types and header casing', () => {
  for (const name of ['content-type', 'Content-Type', 'CONTENT-TYPE']) {
    for (const type of ['application/octet-stream', 'Application/JSON; charset=utf-8', 'application/xml']) {
      const result = { status: 200, headers: { [name]: type }, body: 'provider bytes' };
      assert.equal(encodeDataverseText({ kind: 'value' }, result), result);
    }
    const result = { status: 200, headers: { [name]: 'Text/Plain; charset=UTF-8' }, body: 'value' };
    const encoded = encodeDataverseText({ kind: 'value' }, result);
    assert.equal(encoded.body, '\uFEFFvalue');
    assert.equal(encoded.headers, result.headers);
  }
  const existingBom = { status: 200, body: '\uFEFFliteral leading character' };
  assert.equal(
    encodeDataverseText({ kind: 'value' }, existingBom).body,
    '\uFEFF\uFEFFliteral leading character',
    'encoding BOM does not consume an authored leading character',
  );
});
test('Dataverse primitive text and counts carry a BOM without changing JSON, nulls or binary streams', async (t) => {
  const { api, request } = await specimenApi(t);
  const raw = async (path, expected) => {
    const response = await request(path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('content-type'), 'text/plain');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(bytes, Buffer.from('\uFEFF' + expected), path);
  };
  for (const [column, value] of Object.entries({
    name: 'Unicode Ω 日本語 😀',
    memo: 'line one\r\nline two',
    quantity: '7',
    enabled: 'true',
    amount: '1.25',
    price: '2.5',
    stamp: '2020-01-15T12:34:56Z',
  }))
    await t.test(column, () => raw(`specimens(${ID})/${column}/$value`, value));
  await raw('specimens/$count', '1');
  await raw(`specimens(${ID})/parts/$count`, '1');
  await raw('activitypointers/$count', '0');
  const empty = await request(`specimens(${ID})/empty/$value`);
  assert.equal(empty.status, 204);
  assert.equal((await empty.arrayBuffer()).byteLength, 0);
  const json = await request(`specimens(${ID})/name`),
    jsonBytes = Buffer.from(await json.arrayBuffer());
  assert.notDeepEqual(jsonBytes.subarray(0, 3), Buffer.from([239, 187, 191]));
  assert.equal(JSON.parse(jsonBytes).value, 'Unicode Ω 日本語 😀');
  const file = Buffer.from('\uFEFFbinary file bytes');
  assert.equal(
    (
      await request(`specimens(${ID})/attachment`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/octet-stream', 'x-ms-file-name': 'owned.txt' },
        body: file,
      })
    ).status,
    204,
  );
  const download = await request(`specimens(${ID})/attachment/$value`);
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), file);
  const png = PNG.sync.write({ width: 1, height: 1, data: Buffer.from([25, 50, 75, 255]) });
  assert.equal(
    (
      await request(`specimens(${ID})`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ photo: png.toString('base64') }),
      })
    ).status,
    204,
  );
  for (const suffix of ['', '?size=full']) {
    const image = await request(`specimens(${ID})/photo/$value${suffix}`);
    assert.equal(image.status, 200);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  }
  const batch = await request('$batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      requests: [
        { id: 'raw', method: 'GET', url: `${api.origin}${API}specimens(${ID})/quantity/$value` },
        { id: 'count', method: 'GET', url: `${api.origin}${API}specimens/$count` },
      ],
    }),
  });
  assert.equal(batch.status, 200);
  const batchBytes = Buffer.from(await batch.arrayBuffer());
  assert.ok(batchBytes.includes(Buffer.from('\r\n\r\n\uFEFF7\r\n')));
  assert.ok(batchBytes.includes(Buffer.from('\r\n\r\n\uFEFF1\r\n')));
  assert.equal((batchBytes.toString().match(/Content-Type: text\/plain/gi) ?? []).length, 2);
});
