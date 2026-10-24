// Dataverse TDS request messages: SQL_BATCH and RPC decoding, sp_executesql mapping, DONE/RETURNSTATUS/ERROR/ATTENTION
// encodings. Buffers are built byte by byte from MS-TDS 2.2.6 and 2.2.7, not with the module under test.
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  READ_ONLY_ERROR,
  TdsProtocolError,
  attentionAck,
  decodeRpc,
  decodeSqlBatch,
  doneInProc,
  doneProc,
  doneToken,
  errorToken,
  readOnlyError,
  returnStatus,
  rpcToQuery,
} = await import('../lib/dataverse-tds-messages.mjs');

const u16 = (v) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
};
const u32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v);
  return b;
};
const utf16 = (s) => Buffer.from(s, 'utf16le');
const bVarchar = (s) => Buffer.concat([Buffer.from([s.length]), utf16(s)]);
const COLLATION = Buffer.from([0x09, 0x04, 0xd0, 0x00, 0x34]);

// ALL_HEADERS (22 bytes): total, then one transaction descriptor header of 18 bytes.
function allHeaders(transaction = 0n) {
  const header = Buffer.concat([u32(18), u16(2), Buffer.alloc(8), u32(1)]);
  header.writeBigUInt64LE(transaction, 6);
  return Buffer.concat([u32(22), header]);
}
// NVARCHAR(4000) TYPE_INFO, then a USHORT byte length and UTF-16LE value; null is 0xFFFF.
const nvarchar = (s) => {
  const type = Buffer.from([0xe7, 0xa0, 0x0f, ...COLLATION]);
  return s === null ? Buffer.concat([type, u16(0xffff)]) : Buffer.concat([type, u16(utf16(s).length), utf16(s)]);
};
// INTN(4) TYPE_INFO, then a one-byte length and the little-endian value.
const int4 = (v) => {
  const value = Buffer.alloc(5);
  value[0] = 4;
  value.writeInt32LE(v, 1);
  return Buffer.concat([Buffer.from([0x26, 4]), value]);
};
const param = (name, typed) => Buffer.concat([bVarchar(name), Buffer.from([0]), typed]);

function executeSqlRpc(stmt, ...params) {
  return Buffer.concat([
    allHeaders(),
    u16(0xffff),
    u16(10),
    u16(0),
    param('', nvarchar(stmt)),
    param('', nvarchar('@p1 int, @p2 nvarchar(4000)')),
    ...params,
  ]);
}

test('SQL_BATCH carries the transaction descriptor and UTF-16LE text', () => {
  const batch = decodeSqlBatch(Buffer.concat([allHeaders(0x1122n), utf16('SELECT 1 AS x')]));
  assert.equal(batch.headers.transaction.descriptor, 0x1122n);
  assert.equal(batch.headers.transaction.outstandingRequests, 1);
  assert.equal(batch.sql, 'SELECT 1 AS x');
  assert.throws(() => decodeSqlBatch(Buffer.concat([allHeaders(), Buffer.from([0x53])])), TdsProtocolError);
  assert.throws(() => decodeSqlBatch(allHeaders().subarray(0, 10)), TdsProtocolError);
});

test('sp_executesql RPC maps to a parameterised query', () => {
  const payload = executeSqlRpc('SELECT @p1 AS a, @p2 AS b', param('@p1', int4(42)), param('@p2', nvarchar(null)));
  const rpc = decodeRpc(payload);
  assert.equal(rpc.procId, 10);
  assert.equal(rpc.procName, undefined);
  assert.equal(rpc.params.length, 4);
  assert.deepEqual(rpcToQuery(rpc), { sql: 'SELECT @p1 AS a, @p2 AS b', params: { '@p1': 42, '@p2': null } });
});

test('RPC by procedure name and unsupported procedures', () => {
  const byName = Buffer.concat([
    allHeaders(),
    u16('sp_executesql'.length),
    utf16('sp_executesql'),
    u16(0),
    param('', nvarchar('SELECT 1')),
  ]);
  assert.deepEqual(rpcToQuery(decodeRpc(byName)), { sql: 'SELECT 1', params: {} });
  const prepare = decodeRpc(Buffer.concat([allHeaders(), u16(0xffff), u16(11), u16(0)]));
  assert.throws(() => rpcToQuery(prepare), /RPC 11 is not supported/);
  assert.throws(() => rpcToQuery(decodeRpc(executeSqlRpc(null))), /NVARCHAR statement/);
  assert.throws(() => decodeRpc(allHeaders().subarray(0, 10)), TdsProtocolError);
});

test('DONE variants encode status flags, command and row count', () => {
  assert.equal(doneToken({ more: true, rowCount: 3, curCmd: 0xc1 }).toString('hex'), 'fd1100c100' + '0300000000000000');
  assert.equal(doneProc({ error: true }).toString('hex'), 'fe' + '0200' + '0000' + '0000000000000000');
  assert.equal(doneInProc({}).toString('hex'), 'ff' + '0000' + '0000' + '0000000000000000');
});

test('RETURNSTATUS and ATTENTION acknowledgement', () => {
  assert.equal(returnStatus(0).toString('hex'), '79' + '00000000');
  assert.equal(returnStatus(-1).toString('hex'), '79' + 'ffffffff');
  assert.equal(attentionAck().toString('hex'), 'fd' + '2000' + '0000' + '0000000000000000');
});

test('ERROR token length and read-only error', () => {
  const error = errorToken({ number: 18456, message: 'Login failed.' });
  assert.equal(error[0], 0xaa);
  assert.equal(error.readUInt16LE(1), error.length - 3);
  assert.equal(error.readInt32LE(3), 18456);
  const sequence = readOnlyError();
  assert.equal(sequence[0], 0xaa);
  assert.equal(sequence.readInt32LE(3), READ_ONLY_ERROR.number);
  assert.equal(sequence.subarray(sequence.length - 13).toString('hex'), 'fd0200' + '0000' + '0000000000000000');
});
