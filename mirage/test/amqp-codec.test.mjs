// AMQP 1.0 encoder, decoder and frame writer (mirage/lib/amqp-client.mjs) against byte layouts from the OASIS specification
// (types 1.6, transport 2.2-2.3, security 5.2), independent of the fake broker that shares the codec.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AMQP_HEADER, CODE, Described, SASL_HEADER, decode, decodeMessage, described, encode, encodeMessage, frame, readFrame, sym, ubyte, uint, ulong } from '../lib/amqp-client.mjs';
import { fakeCodec } from '../testing/amqp-fake-broker.mjs';

const hex = (buffer) => Buffer.from(buffer).toString('hex');

test('primitive encodings follow the types section byte layouts', () => {
  assert.equal(hex(encode(null)), '40');
  assert.equal(hex(encode(true)), '41');
  assert.equal(hex(encode(uint(0))), '43');
  assert.equal(hex(encode(uint(7))), '5207');
  assert.equal(hex(encode(uint(300))), '700000012c');
  assert.equal(hex(encode(ulong(0x10))), '5310');
  assert.equal(hex(encode(sym('PLAIN'))), 'a305504c41494e');
  assert.equal(hex(encode('é')), 'a102c3a9');
  assert.equal(hex(encode(Buffer.from([1, 2]))), 'a0020102');
  assert.equal(hex(encode(-1)), '55ff');
  assert.equal(hex(encode(new Date(1))), '830000000000000001');
  assert.equal(hex(encode([])), '45');
  // described list: 0x00, descriptor smallulong 0x10 (open), list8 size 3 count 2 [str "a", null]
  assert.equal(hex(encode(described(CODE.open, ['a', null]))), '005310c00502a1016140');
  assert.equal(hex(encode(Buffer.alloc(300))).slice(0, 10), 'b00000012c');
});

test('the decoder reads lists, maps, arrays of symbols and described values', () => {
  const sasl = Buffer.from('e01202a305504c41494e09414e4f4e594d4f5553', 'hex'); // array8 of sym: PLAIN, ANONYMOUS (as a broker sends sasl-server-mechanisms)
  assert.deepEqual(decode(sasl)[0], ['PLAIN', 'ANONYMOUS']);
  const value = { list: [1, 'two', null, true, 2.5, 2 ** 40], map: { k: 'v' }, at: new Date(1_700_000_000_000), bin: Buffer.from('xyz') };
  const [round] = decode(encode(value));
  assert.deepEqual(round, value);
  const [open] = decode(encode(described(CODE.open, ['container', null, uint(65536)])));
  assert.ok(open instanceof Described);
  assert.equal(open.descriptor, CODE.open);
  assert.deepEqual(open.value, ['container', null, 65536]);
  assert.throws(() => decode(Buffer.from('a105ab', 'hex')), RangeError, 'truncated input is refused');
});

test('frames carry size, doff 2, type and channel; an empty frame is a heartbeat', () => {
  const bytes = frame(1, 0, described(CODE.saslInit, [sym('PLAIN')]), null);
  assert.equal(bytes.readUInt32BE(0), bytes.length);
  assert.deepEqual([...bytes.subarray(4, 8)], [2, 1, 0, 0]);
  const read = readFrame(Buffer.concat([bytes, Buffer.from([0])]), 1 << 20);
  assert.equal(read.size, bytes.length);
  assert.equal(read.type, 1);
  assert.equal(read.performative.descriptor, CODE.saslInit);
  assert.equal(readFrame(bytes.subarray(0, 5), 1 << 20), null, 'an incomplete frame waits for more bytes');
  assert.equal(readFrame(Buffer.from([0, 0, 0, 8, 2, 0, 0, 0]), 512).performative, null);
  assert.throws(() => readFrame(Buffer.from([0, 0, 0, 4, 2, 0, 0, 0]), 512), RangeError);
  assert.equal(hex(SASL_HEADER), '414d515003010000');
  assert.equal(hex(AMQP_HEADER), '414d515000010000');
});

test('message sections round-trip: annotations, properties, application properties and a data body', () => {
  const at = new Date(1_800_000_000_000);
  const bytes = encodeMessage({ header: [null, null, null, null, uint(2)], annotations: new Map([[sym('x-opt-scheduled-enqueue-time'), at]]),
    properties: ['fx-id', null, null, null, null, null, sym('application/json')], applicationProperties: { x_kind: 'fx', n: 3 }, body: Buffer.from('{"a":1}') });
  assert.equal(hex(bytes.subarray(0, 3)), '005370', 'the header section comes first');
  const message = decodeMessage(bytes);
  assert.equal(message.header[4], 2);
  assert.deepEqual(message.annotations, { 'x-opt-scheduled-enqueue-time': at });
  assert.equal(message.properties[0], 'fx-id');
  assert.equal(message.properties[6], 'application/json');
  assert.deepEqual(message.applicationProperties, { x_kind: 'fx', n: 3 });
  assert.equal(message.body.toString(), '{"a":1}');
  assert.deepEqual(decodeMessage(encodeMessage({ body: { v: 1 } })).body, { v: 1 }, 'a non-binary body is an amqp-value section');
});

// Golden performatives written by hand from the transport field tables (2.7.3 attach, 2.7.4 flow, 2.7.5 transfer,
// 2.7.6 disposition) with the compact encodings of types 1.6; both the client codec and the fake broker's own codec must agree.
const GOLDEN = [
  { name: 'attach (receiver of q, local l)', fields: ['l', 0, true, 0, 0, [CODE.source, ['q']], [CODE.target, ['l']]],
    value: described(CODE.attach, ['l', uint(0), true, ubyte(0), ubyte(0), described(CODE.source, ['q']), described(CODE.target, ['l'])]),
    hex: '005312' + 'c01c07' + 'a1016c' + '43' + '41' + '5000' + '5000' + '005328c00401a10171' + '005329c00401a1016c' },
  { name: 'flow (handle 1, credit 10, drain)', fields: [0, 5000, 0, 5000, 1, 0, 10, null, true],
    value: described(CODE.flow, [uint(0), uint(5000), uint(0), uint(5000), uint(1), uint(0), uint(10), null, true]),
    hex: '005313' + 'c01409' + '43' + '7000001388' + '43' + '7000001388' + '5201' + '43' + '520a' + '40' + '41' },
  { name: 'transfer (handle 0, delivery 0, tag aa, unsettled)', fields: [0, 0, Buffer.from([0xaa]), 0, false, false],
    value: described(CODE.transfer, [uint(0), uint(0), Buffer.from([0xaa]), uint(0), false, false]),
    hex: '005314' + 'c00906' + '43' + '43' + 'a001aa' + '43' + '42' + '42' },
  { name: 'disposition (receiver settles 1 accepted)', fields: [true, 1, 1, true, [CODE.accepted, []]],
    value: described(CODE.disposition, [true, uint(1), uint(1), true, described(CODE.accepted, [])]),
    hex: '005315' + 'c00b05' + '41' + '5201' + '5201' + '41' + '00532445' },
];
const plain = (value) => (value instanceof Described ? [value.descriptor, plain(value.value)] : value?.d !== undefined ? [value.d, plain(value.v)] : Array.isArray(value) ? value.map(plain) : value);

test('golden performative bytes: the client encodes them, and both codecs read every field at its spec position', () => {
  for (const { name, value, hex: golden, fields } of GOLDEN) {
    assert.equal(hex(encode(value)), golden, `${name}: client encoding`);
    const [client] = decode(Buffer.from(golden, 'hex'));
    assert.deepEqual(plain(client.value), fields, `${name}: client decoding`);
    const [fake] = fakeCodec.dec(Buffer.from(golden, 'hex'), 0);
    assert.deepEqual(plain(fake.v), fields, `${name}: fake broker decoding`);
  }
  // The fake answers with wide encodings (uint32, ulong descriptor, str32, list32); the client reads them at the same positions.
  const { enc, desc, list, uint: u, val } = fakeCodec;
  const wide = enc(desc(CODE.flow, list([u(0), u(5000), u(0), u(5000), u(1), u(0), u(10), val(null), val(true)])));
  assert.equal(hex(wide.subarray(0, 11)), '00' + '800000000000000013' + 'd0', 'descriptor 0x13 as ulong, then list32');
  assert.equal(wide[1], 0x80, 'the fake encodes the descriptor as a full ulong');
  assert.deepEqual(plain(decode(wide)[0].value), GOLDEN[1].fields);
});
