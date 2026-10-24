import test from 'node:test';
import assert from 'node:assert/strict';
import {
  columnMetadata,
  row,
  nbcRow,
  encodeTypedValue,
  decodeTypedValue,
  decodeRow,
} from '../lib/dataverse-tds-types.mjs';

// [column, [[input, expected], ...]]; expected is what decoding returns (null for NULL).
const cases = [
  [
    { name: 'i', type: 'int' },
    [
      [0, 0],
      [-1, -1],
      [2147483647, 2147483647],
      [-2147483648, -2147483648],
      [null, null],
    ],
  ],
  [
    { name: 's', type: 'smallint' },
    [
      [-32768, -32768],
      [32767, 32767],
      [null, null],
    ],
  ],
  [
    { name: 't', type: 'tinyint' },
    [
      [0, 0],
      [255, 255],
      [null, null],
    ],
  ],
  [
    { name: 'b', type: 'bigint' },
    [
      [9007199254740993n, 9007199254740993n],
      [-9223372036854775808n, -9223372036854775808n],
      [42, 42n],
      [null, null],
    ],
  ],
  [
    { name: 'bit', type: 'bit' },
    [
      [true, true],
      [false, false],
      [null, null],
    ],
  ],
  [
    { name: 'r', type: 'real' },
    [
      [1.5, 1.5],
      [-0.25, -0.25],
      [null, null],
    ],
  ],
  [
    { name: 'f', type: 'float' },
    [
      [0.1, 0.1],
      [-1e300, -1e300],
      [null, null],
    ],
  ],
  [
    { name: 'm', type: 'money' },
    [
      ['922337203685477.5807', '922337203685477.5807'],
      ['-922337203685477.5808', '-922337203685477.5808'],
      ['-0.0001', '-0.0001'],
      ['12', '12.0000'],
      [null, null],
    ],
  ],
  [
    { name: 'd', type: 'decimal', precision: 10, scale: 4 },
    [
      ['-12.3400', '-12.3400'],
      ['0.0001', '0.0001'],
      ['123456.7890', '123456.7890'],
      [null, null],
    ],
  ],
  [
    { name: 'd', type: 'decimal', precision: 9, scale: 2 },
    [
      ['-1234567.89', '-1234567.89'],
      ['0', '0.00'],
    ],
  ],
  [
    { name: 'n', type: 'numeric', precision: 38, scale: 0 },
    [
      ['-99999999999999999999999999999999999999', '-99999999999999999999999999999999999999'],
      ['99999999999999999999999999999999999999', '99999999999999999999999999999999999999'],
    ],
  ],
  [
    { name: 'dt', type: 'datetime' },
    [
      ['1753-01-01 00:00:00.000', '1753-01-01 00:00:00.000'],
      ['1900-01-01 00:00:00.003', '1900-01-01 00:00:00.003'],
      ['2024-02-29 13:45:10.997', '2024-02-29 13:45:10.997'],
      ['9999-12-31 23:59:59.997', '9999-12-31 23:59:59.997'],
      [null, null],
    ],
  ],
  [
    { name: 'sdt', type: 'smalldatetime' },
    [
      ['1900-01-01 00:00:00', '1900-01-01 00:00:00'],
      ['2079-06-06 23:59:00', '2079-06-06 23:59:00'],
      ['2024-02-29 13:45:00', '2024-02-29 13:45:00'],
      [null, null],
    ],
  ],
  [
    { name: 'dd', type: 'date' },
    [
      ['0001-01-01', '0001-01-01'],
      ['1900-01-01', '1900-01-01'],
      ['9999-12-31', '9999-12-31'],
      [null, null],
    ],
  ],
  [
    { name: 'd0', type: 'datetime2', scale: 0 },
    [
      ['2009-12-30 13:51:35', '2009-12-30 13:51:35'],
      [null, null],
    ],
  ],
  [{ name: 'd3', type: 'datetime2', scale: 3 }, [['2024-02-29 13:45:10.997', '2024-02-29 13:45:10.997']]],
  [
    { name: 'd7', type: 'datetime2', scale: 7 },
    [
      ['2009-12-30 13:51:35.4299569', '2009-12-30 13:51:35.4299569'],
      ['0001-01-01 00:00:00.5', '0001-01-01 00:00:00.5000000'],
      ['2024-02-29', '2024-02-29 00:00:00.0000000'],
      [null, null],
    ],
  ],
  [
    { name: 'g', type: 'uniqueidentifier' },
    [
      ['6F9619FF-8B86-D011-B42D-00C04FC964FF', '6F9619FF-8B86-D011-B42D-00C04FC964FF'],
      ['6f9619ff-8b86-d011-b42d-00c04fc964ff', '6F9619FF-8B86-D011-B42D-00C04FC964FF'],
      ['00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000'],
      [null, null],
    ],
  ],
  [
    { name: 's', type: 'nvarchar', length: 10 },
    [
      ['Contoso', 'Contoso'],
      ['', ''],
      ['Zürich ✓', 'Zürich ✓'],
      [null, null],
    ],
  ],
  [
    { name: 'x', type: 'nvarchar', length: 'max' },
    [
      ['a'.repeat(20000), 'a'.repeat(20000)],
      ['é\u{1F600}'.repeat(5000), 'é\u{1F600}'.repeat(5000)],
      ['', ''],
      [null, null],
    ],
  ],
  [
    { name: 'u', type: 'nvarchar' },
    [
      ['short', 'short'],
      [null, null],
    ],
  ],
];

for (const [column, samples] of cases) {
  test(`round trip ${column.type} ${column.length ?? column.precision ?? column.scale ?? ''}`.trim(), () => {
    for (const [input, expected] of samples) {
      const bytes = encodeTypedValue(column, input);
      const out = decodeTypedValue(bytes, 0);
      assert.deepEqual(out.value, expected, `${column.type} input ${String(input).slice(0, 40)}`);
      assert.equal(out.type, column.type);
      assert.equal(out.next, bytes.length);
    }
  });
}

test('uniqueidentifier wire bytes use the MS-TDS mixed-endian layout', () => {
  // 6F9619FF-8B86-D011-B42D-00C04FC964FF is FF 19 96 6F 86 8B 11 D0 B4 2D 00 C0 4F C9 64 FF on the wire.
  assert.deepEqual(
    encodeTypedValue({ type: 'uniqueidentifier' }, '6F9619FF-8B86-D011-B42D-00C04FC964FF'),
    Buffer.from([
      0x24, 0x10, 0x10, 0xff, 0x19, 0x96, 0x6f, 0x86, 0x8b, 0x11, 0xd0, 0xb4, 0x2d, 0x00, 0xc0, 0x4f, 0xc9, 0x64, 0xff,
    ]),
  );
});

test('negative decimal: sign byte 0 and little-endian magnitude', () => {
  // -12.3400 with scale 4 is unscaled -123400 = 0x01E208, 8 magnitude bytes after the sign.
  const bytes = encodeTypedValue({ type: 'decimal', precision: 10, scale: 4 }, '-12.3400');
  assert.deepEqual(bytes, Buffer.from([0x6a, 9, 10, 4, 9, 0x00, 0x08, 0xe2, 0x01, 0, 0, 0, 0, 0]));
});

test('decimal rejects more fraction digits than the scale and overflowing precision', () => {
  assert.throws(
    () => encodeTypedValue({ type: 'decimal', precision: 10, scale: 2 }, '1.234'),
    /more than 2 fraction digits/,
  );
  assert.throws(() => encodeTypedValue({ type: 'decimal', precision: 4, scale: 0 }, '10000'), /exceeds precision 4/);
});

test('datetime and date day counts: 1900-01-01 is 693595 days after 0001-01-01', () => {
  assert.deepEqual(encodeTypedValue({ type: 'date' }, '1900-01-01').subarray(2), Buffer.from([0x5b, 0x95, 0x0a]));
});

test('datetime minimum is -53690 days from 1900, signed little-endian', () => {
  const bytes = encodeTypedValue({ type: 'datetime' }, '1753-01-01 00:00:00.000'); // TYPE_INFO is 2 bytes, then length 8
  assert.deepEqual(bytes.subarray(3, 7), Buffer.from([0x46, 0x2e, 0xff, 0xff]));
});

test('out-of-range temporal values are rejected', () => {
  assert.throws(() => encodeTypedValue({ type: 'datetime' }, '1752-12-31 23:59:59.000'), /datetime value out of range/);
  assert.throws(() => encodeTypedValue({ type: 'date' }, '0000-01-01'), /date value out of range/);
  assert.throws(
    () => encodeTypedValue({ type: 'smalldatetime' }, '2079-06-07 00:00:00'),
    /smalldatetime value out of range/,
  );
});

test('nvarchar(max) uses PLP chunks with a total length and a zero terminator', () => {
  const bytes = encodeTypedValue({ type: 'nvarchar', length: 'max' }, 'a'.repeat(10000));
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([0xe7, 0xff, 0xff, 0x09, 0x04, 0xd0, 0x00, 0x34]));
  assert.equal(bytes.readBigUInt64LE(8), 20000n);
  const chunks = [];
  for (let p = 16, n = bytes.readUInt32LE(p); n !== 0; p += 4 + n, n = bytes.readUInt32LE(p)) chunks.push(n);
  assert.deepEqual(chunks, [8000, 8000, 4000]);
  assert.equal(bytes.readUInt32LE(bytes.length - 4), 0);
});

test('NULL markers: 0xFFFF for fixed nvarchar, all 0xFF for PLP, 0x00 for other types', () => {
  assert.deepEqual(encodeTypedValue({ type: 'nvarchar', length: 4 }, null).subarray(8), Buffer.from([0xff, 0xff]));
  assert.deepEqual(encodeTypedValue({ type: 'nvarchar', length: 'max' }, null).subarray(8), Buffer.alloc(8, 0xff));
  assert.deepEqual(encodeTypedValue({ type: 'int' }, null).subarray(2), Buffer.from([0x00]));
});

test('non-nullable columns reject NULL', () => {
  assert.throws(() => encodeTypedValue({ name: 'a', type: 'int', nullable: false }, null), /column a is not nullable/);
  assert.throws(() => nbcRow([{ name: 'a', type: 'int', nullable: false }], [null]), /column a is not nullable/);
});

test('unsupported types and wrong value counts are rejected', () => {
  assert.throws(() => encodeTypedValue({ type: 'xml' }, 'x'), /unsupported TDS column type: xml/);
  assert.throws(() => row([{ type: 'int' }, { type: 'int' }], [1]), /expected 2 values, got 1/);
});

test('COLMETADATA carries the token, count, UserType, flags, TYPE_INFO and name', () => {
  assert.deepEqual(
    columnMetadata([{ name: 'a', type: 'int', nullable: false }]),
    Buffer.from([0x81, 1, 0, 0, 0, 0, 0, 0, 0, 0x26, 4, 1, 0x61, 0x00]),
  );
  assert.deepEqual(
    columnMetadata([{ name: '', type: 'nvarchar', length: 4 }]),
    Buffer.from([0x81, 1, 0, 0, 0, 0, 0, 1, 0, 0xe7, 8, 0, 0x09, 0x04, 0xd0, 0x00, 0x34, 0]),
  );
  assert.deepEqual(columnMetadata([]), Buffer.from([0x81, 0xff, 0xff]));
});

const nbcColumns = [
  { name: 'a', type: 'int' },
  { name: 'b', type: 'nvarchar', length: 10 },
  { name: 'c', type: 'bit' },
];

test('ROW encodes NULLs inline with their zero-length markers', () => {
  const bytes = row(nbcColumns, [null, 'x', null]);
  assert.deepEqual(bytes, Buffer.from([0xd1, 0x00, 0x02, 0x00, 0x78, 0x00, 0x00]));
  assert.deepEqual(decodeRow(nbcColumns, bytes).values, [null, 'x', null]);
});

test('NBCROW sets a null bitmap bit per NULL column and omits their data', () => {
  const bytes = nbcRow(nbcColumns, [null, 'x', null]);
  assert.deepEqual(bytes, Buffer.from([0xd2, 0x05, 0x02, 0x00, 0x78, 0x00]));
  const out = decodeRow(nbcColumns, bytes);
  assert.deepEqual(out.values, [null, 'x', null]);
  assert.equal(out.next, bytes.length);
});

test('NBCROW and ROW round trip many columns across bitmap bytes', () => {
  const columns = Array.from({ length: 10 }, (_, i) => ({ name: `c${i}`, type: 'int' }));
  const values = columns.map((_, i) => (i % 3 === 0 ? null : i * 7));
  assert.deepEqual(decodeRow(columns, nbcRow(columns, values)).values, values);
  assert.deepEqual(decodeRow(columns, row(columns, values)).values, values);
});
