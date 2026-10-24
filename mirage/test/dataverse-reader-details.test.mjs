import { specimenApi, ID, API } from './support/specimen-api.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
test('Dataverse HTTP structured reader errors retain causes without touching internal SDK/portal formatting', async (t) => {
  const { store, api, request } = await specimenApi(t);
  const beforeRow = JSON.stringify(store.state.tables.specimen[0]);
  for (const body of ['null', '[]']) {
    const unknown = await request('absent_records', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    assert.equal(unknown.status, 404, 'unknown entity stays ahead of root payload diagnostics');
    const unauthenticated = await fetch(api.origin + API + 'specimens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    assert.equal(unauthenticated.status, 401, 'authentication stays ahead of payload diagnostics');
  }

  for (const field of ['name', 'quantity', 'enabled', 'amount', 'price', 'stamp'])
    for (const value of [[], {}])
      for (const method of ['POST', 'PATCH'])
        await t.test(method + ' ' + field + ' ' + (Array.isArray(value) ? 'array' : 'object'), async () => {
          const response = await request(method === 'POST' ? 'specimens' : 'specimens(' + ID + ')', {
            method,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ [field]: value }),
          });
          assert.equal(response.status, 400);
          const error = (await response.json()).error;
          assert.equal(error.code, '0x80048d19');
          assert.ok(error.message.includes(method === 'POST' ? "Entity :'specimens'" : "Entity :''"));
          assert.ok(error.message.includes(Array.isArray(value) ? "'StartArray'" : "'StartObject'"));
          assert.ok(error.message.includes("'PrimitiveValue' node was expected"));
          if (!Array.isArray(value)) assert.ok(error.message.includes("property named '" + field + "'"));
          assert.equal(error.message.includes('   at '), false);
        });
  for (const body of ['null', '[]'])
    for (const method of ['POST', 'PATCH']) {
      const response = await request(method === 'POST' ? 'specimens' : 'specimens(' + ID + ')', {
        method,
        headers: { 'content-type': 'application/json' },
        body,
      });
      assert.equal(response.status, 400);
      const error = (await response.json()).error;
      assert.equal(error.code, '0x80048d19');
      assert.ok(error.message.includes("'EndOfInput'"));
      assert.ok(error.message.includes("'StartObject' node was expected"));
    }
  const lexeme = '1.2345678901234567890123456789';
  const exact = await request('specimens', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"quantity":' + lexeme + '}',
  });
  assert.equal(exact.status, 400);
  assert.ok((await exact.json()).error.message.includes(lexeme), 'raw numeric literal preserved');
  const mapping = store.state.mappings.specimen;
  assert.throws(
    () => store.coerceRecord(mapping, { quantity: [] }, { dataverseWebApi: true }),
    (error) => error.message.includes('Cannot convert') && !error.message.includes('StartArray'),
  );
  assert.throws(
    () => store.coerceRecord(mapping, { quantity: {} }, { coerce: true }),
    (error) => error.message.includes('Cannot convert') && !error.message.includes('StartObject'),
  );
  assert.equal(store.state.tables.specimen.length, 1);
  assert.equal(JSON.stringify(store.state.tables.specimen[0]), beforeRow);
});
