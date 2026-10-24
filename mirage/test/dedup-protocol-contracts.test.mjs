import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readRawBody } from '../lib/http-body.mjs';
import { decodeClrMessage, clrOutputFailure } from '../lib/plugin-clr-protocol.mjs';
import { fieldValue } from '../lib/fetchxml-engine.mjs';
import { columnValue } from '../lib/odata-query.mjs';
import { validateCalculatedColumns } from '../lib/dataverse-calculated.mjs';
import { validateFormulaColumns } from '../lib/dataverse-formula.mjs';
import { validateRollups } from '../lib/dataverse-rollup.mjs';
import { compileODataPermissionQuery, odataPermissionPathFeatures } from '../lib/odata-permission-query.mjs';
import { readMessageRecords, messageCollection, argsOf, idOf } from '../lib/dataverse-message-context.mjs';

test('raw HTTP body bounds count exact bytes, preserve binary/BOM and propagate stream failures', async () => {
  const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0, 0xff]);
  const limitError = new Error('protocol-specific limit');
  const options = { maximum: bytes.length, tooLarge: () => limitError };
  assert.deepEqual(await readRawBody(Readable.from([bytes.subarray(0, 2), bytes.subarray(2)]), options), bytes);
  assert.deepEqual(await readRawBody(Readable.from([]), options), Buffer.alloc(0));
  await assert.rejects(readRawBody(Readable.from([bytes, Buffer.from([1])]), options), (error) => error === limitError);
  const streamError = new Error('cancelled');
  const stream = Readable.from(
    (async function* () {
      yield bytes;
      throw streamError;
    })(),
  );
  await assert.rejects(readRawBody(stream, options), (error) => error === streamError);
});

test('CLR parsing preserves worker-specific oversized line policy and pending RPC refusals', () => {
  for (const line of ['{', 'null', '[]', 'true', '3'])
    assert.equal(decodeClrMessage(line).error.code, 'LocalPluginProtocol');
  assert.equal(decodeClrMessage('{"kind":"unknown"}').error.message, 'Unknown CLR host message.');
  assert.equal(
    decodeClrMessage('{"kind":"rpc"}', { pending: true }).error.message,
    'Concurrent CLR SDK calls are unsupported.',
  );
  for (const kind of ['result', 'failure'])
    assert.equal(
      decodeClrMessage(JSON.stringify({ kind }), { pending: true }).error.message,
      'CLR completed with a pending SDK callback.',
    );
  for (const kind of ['rpc', 'trace', 'result', 'failure'])
    assert.deepEqual(decodeClrMessage(JSON.stringify({ kind })).message, { kind });
  assert.equal(decodeClrMessage('{"kind":"trace"}', { pooled: true, active: false }).error.code, 'LocalPluginProtocol');
  const oversized = ' '.repeat(4 * 1024 * 1024 + 1);
  assert.equal(decodeClrMessage(oversized).error.code, 'LocalPluginOutputLimit');
  assert.equal(decodeClrMessage(oversized, { pooled: true }).error.code, 'LocalPluginProtocol');
  assert.equal(clrOutputFailure('stderr', 65536), null);
  assert.equal(clrOutputFailure('stderr', 65537).code, 'LocalPluginOutputLimit');
  assert.equal(clrOutputFailure('stdout', 8 * 1024 * 1024), null);
  assert.equal(clrOutputFailure('stdout', 8 * 1024 * 1024 + 1).code, 'LocalPluginOutputLimit');
});

test('both query engines retain direct-field precedence, lookup scalars and missing values', () => {
  for (const read of [fieldValue, columnValue]) {
    assert.equal(read(null, 'ownerid'), undefined);
    assert.equal(read({}, 'ownerid'), undefined);
    assert.equal(read({ ownerid: null, _ownerid_value: 'alias' }, 'ownerid'), null);
    assert.equal(read({ ownerid: undefined, _ownerid_value: 'alias' }, 'ownerid'), undefined);
    const lookup = { id: 'id', logical_name: 'x_table' };
    assert.equal(read({ ownerid: lookup }, 'ownerid'), lookup);
    assert.equal(read({ ownerid: lookup }, '_ownerid_value'), 'id');
    assert.equal(read({ _ownerid_value: 'id' }, 'ownerid'), 'id');
    assert.equal(read(Object.create({ ownerid: 'inherited' }), 'ownerid'), undefined);
    assert.equal(read({ ownerid: { value: 0 } }, '_ownerid_value'), 0);
  }
});

test('each derived-column export retains its exact validation diagnostics and normalized keys', () => {
  for (const [name, validate] of [
    ['calculatedColumns', validateCalculatedColumns],
    ['formulaColumns', validateFormulaColumns],
    ['rollups', validateRollups],
  ]) {
    assert.deepEqual(validate(undefined), {});
    for (const invalid of [null, [], 1, false])
      assert.throws(() => validate(invalid), { message: `${name} must map '<table>.<column>' to functions.` });
    assert.throws(() => validate({ invalid: () => 1 }), {
      message: `${name} key 'invalid' must be '<table>.<column>'.`,
    });
    for (const invalid of [1, async () => 1])
      assert.throws(() => validate({ 'x_item.x_total': invalid }), {
        message: `${name}['x_item.x_total'] must be a synchronous function (row, ctx) => value.`,
      });
    const fn = () => 2;
    assert.deepEqual(validate({ 'X_Item.X_Total': fn }), { 'x_item.x_total': fn });
  }
});

test('permission calibration and conversion agree on grant selection without turning calibration into authorization', () => {
  const authored = '<fetch><entity name="x_item"><attribute name="x_itemid"/></entity></fetch>';
  const identities = [
    [{ roles: ['Reader'] }, { roles: ['Reader'] }, true],
    [{ roles: ['Foreign'] }, { roles: ['Reader'] }, false],
    [
      { roleSource: 'memberships', roleIds: ['{AAAAAAAA-0000-4000-8000-000000000001}'] },
      { imported: true, roleIds: ['aaaaaaaa-0000-4000-8000-000000000001'], roles: ['Foreign'] },
      true,
    ],
    [{ roleSource: 'memberships', roleIds: [] }, { imported: true, roles: ['Reader'] }, false],
    [{}, { enabled: false }, false],
    [{}, { operations: ['update'] }, false],
    [{}, { entity: 'x_other' }, false],
    [{}, { entity: '*' }, true],
    [{}, {}, true],
  ];
  for (const [identity, grant, selected] of identities) {
    const permissions = [{ id: 'grant', entity: 'x_item', ...grant }];
    const features = odataPermissionPathFeatures({ table: 'x_item', permissions, identity });
    assert.equal(features.paths.length, selected ? 1 : 0);
    assert.equal(features.nativeQualified, false);
    const convert = () => compileODataPermissionQuery(authored, { permissions, identity });
    if (selected) assert.ok(convert().xml.includes('name="x_item"'));
    else assert.throws(convert, { status: 403, code: 'PermissionDenied' });
  }
});

test('message read dispatch keeps effective principal separate from caller and preserves context and selection', async () => {
  const calls = [],
    caller = {},
    identity = {},
    user = {},
    system = {};
  const context = {
    origin: 'http://127.0.0.1',
    version: 'v9.2',
    user,
    caller,
    identity,
    requestId: 'request',
    url: new URL('http://127.0.0.1/?$select=x_name'),
  };
  const mapping = { entitySet: 'x_items', idColumn: 'x_itemid' };
  const api = {
    store: { resolveMapping: () => mapping },
    records: {
      handle: async (call) => {
        calls.push(call);
        return { body: { value: [{ x_name: 'Invented' }] } };
      },
    },
  };
  await messageCollection(api, context, 'x_item', []);
  assert.equal(calls.length, 0);
  await messageCollection(api, context, 'x_item', ['00000000-0000-4000-8000-000000000001'], system);
  const call = calls[0];
  assert.equal(call.user, system);
  assert.equal(call.caller, caller);
  assert.equal(call.identity, identity);
  assert.equal(call.requestId, context.requestId);
  assert.equal(call.version, context.version);
  assert.equal(call.url.searchParams.get('$select'), 'x_name');
  assert.equal(call.url.searchParams.get('$filter'), 'x_itemid eq 00000000-0000-4000-8000-000000000001');
  await readMessageRecords(api, context, new URL('http://127.0.0.1/api/data/v9.2/x_items'));
  assert.equal(calls[1].user, user);
  assert.deepEqual(argsOf({ body: '{"shared":1,"action":2}', params: { shared: 3 } }), { shared: 3, action: 2 });
  assert.equal(
    idOf({ '@odata.id': 'x_items(00000000-0000-4000-8000-000000000001)' }),
    '00000000-0000-4000-8000-000000000001',
  );
});
