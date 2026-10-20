// Builds a minimal managed assembly image (DOS and PE headers, one .NET section pair, CLI header and the #~, #Strings, #GUID
// and #Blob streams) for the reader and registration tests. It writes only the tables the reader reads (Module, TypeRef,
// TypeDef, InterfaceImpl, NestedClass, Assembly) with 2-byte indexes, so the image is small and deterministic. Invented names.

const BSJB = 0x424a5342;
const TABLE = { Module: 0, TypeRef: 1, TypeDef: 2, InterfaceImpl: 9, NestedClass: 41, Assembly: 32 };

const le = (value, width) => { const bytes = Buffer.alloc(width); bytes.writeUIntLE(value, 0, width); return bytes; };
const pad = (bytes, size = 4) => Buffer.concat([bytes, Buffer.alloc((size - (bytes.length % size)) % size)]);
const split = (full) => { const at = full.lastIndexOf('.'); return at < 0 ? ['', full] : [full.slice(0, at), full.slice(at + 1)]; };

// A heap with the leading empty entry; equal entries share one index.
function heap() {
  const parts = [Buffer.alloc(1)], known = new Map();
  let size = 1;
  return {
    put(bytes) {
      const key = bytes.toString('latin1');
      if (known.has(key)) return known.get(key);
      const index = size;
      known.set(key, index);
      parts.push(bytes);
      size += bytes.length;
      return index;
    },
    bytes: () => Buffer.concat(parts),
  };
}

// Blob length prefix (ECMA-335 §II.24.2.4): one, two or four bytes.
function blobLength(length) {
  if (length < 0x80) return Buffer.from([length]);
  if (length < 0x4000) return Buffer.from([0x80 | (length >> 8), length & 0xff]);
  return Buffer.from([0xc0 | (length >>> 24), (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff]);
}

/**
 * An assembly image. typeRefs are full names of external types. typeDefs are { full, base, interfaces, nestedIn? } where
 * full is the CLR name (a nested type is written as Outer+Inner, with nestedIn set to the outer's full name). base and the
 * interfaces name a local typeDef first, then a typeRef, so a local `Microsoft.Xrm.Sdk.IPlugin` is possible.
 * noCli drops the CLI header; strongName sets the CLI flag; publicKey (a Buffer) is the strong-name key blob.
 */
export function buildAssembly({ name = 'Contoso.Plugins', version = '1.0.0.0', culture = null, publicKey = null, strongName = publicKey !== null, pe32 = false, noCli = false, typeRefs = [], typeDefs = [], metadataSignature = BSJB } = {}) {
  const strings = heap(), blobs = heap();
  const str = (value) => (value === '' || value == null ? 0 : strings.put(Buffer.from(`${value}\0`, 'utf8')));
  const blob = (bytes) => (bytes == null || bytes.length === 0 ? 0 : blobs.put(Buffer.concat([blobLength(bytes.length), bytes])));

  // Rows: the widths are 2 bytes for indexes and coded indexes (the counts are small), 4 for the fixed u4 columns.
  const local = (full) => typeDefs.findIndex((typeDef) => typeDef.full === full);
  const rowOfLocal = (full) => local(full) + 2; // row 1 is <Module>
  const resolve = (full) => {
    if (full == null) return 0;
    if (local(full) >= 0) return rowOfLocal(full) << 2;
    const ref = typeRefs.indexOf(full);
    if (ref < 0) throw new Error(`fixture: unknown type ${full}`);
    return ((ref + 1) << 2) | 1;
  };
  // Column widths per table. A TypeRef's scope is the Module row (tag 0, row 1), which is 1 << 2.
  const widths = { Module: [2, 2, 2, 2, 2], TypeRef: [2, 2, 2], TypeDef: [4, 2, 2, 2, 2, 2], InterfaceImpl: [2, 2], NestedClass: [2, 2], Assembly: [4, 2, 2, 2, 2, 4, 2, 2, 2] };
  const rows = {
    Module: [[0, str(name), 1, 0, 0]],
    TypeRef: typeRefs.map((full) => { const [namespace, short] = split(full); return [1 << 2, str(short), str(namespace)]; }),
    TypeDef: [[0, str('<Module>'), str(''), 0, 1, 1], ...typeDefs.map((typeDef) => {
      const [namespace, short] = typeDef.nestedIn ? ['', typeDef.full.split('+').pop()] : split(typeDef.full);
      return [0x00100001, str(short), str(namespace), resolve(typeDef.base ?? null), 1, 1];
    })],
    InterfaceImpl: typeDefs.flatMap((typeDef, index) => (typeDef.interfaces ?? []).map((iface) => [index + 2, resolve(iface)])),
    NestedClass: typeDefs.filter((typeDef) => typeDef.nestedIn).map((typeDef) => [rowOfLocal(typeDef.full), rowOfLocal(typeDef.nestedIn)]),
    Assembly: [[0x8004, ...version.split('.').map(Number), 0, blob(publicKey), str(name), str(culture)]],
  };
  const present = Object.entries(TABLE).filter(([key]) => rows[key].length > 0).sort((a, b) => a[1] - b[1]);
  const valid = present.reduce((mask, [, id]) => mask + 2 ** id, 0);
  const data = Buffer.concat(present.flatMap(([key]) => rows[key].map((row) => Buffer.concat(row.map((value, column) => le(value, widths[key][column]))))));
  const tableStream = Buffer.concat([
    Buffer.from([0, 0, 0, 0, 2, 0, 0, 1]), le(valid % 2 ** 32, 4), le(Math.floor(valid / 2 ** 32), 4), Buffer.alloc(8),
    ...present.map(([key]) => le(rows[key].length, 4)), data,
  ]);
  const streams = [['#~', pad(tableStream)], ['#Strings', pad(strings.bytes())], ['#GUID', Buffer.alloc(16, 0x11)], ['#Blob', pad(blobs.bytes())]];

  // Metadata root (§24.2.1), then the stream headers and the stream bodies.
  const version16 = Buffer.from('v4.0.30319\0\0', 'latin1');
  const headerSize = 16 + version16.length + 4 + streams.reduce((sum, [streamName]) => sum + 8 + pad(Buffer.from(`${streamName}\0`)).length, 0);
  let offset = headerSize;
  const streamHeaders = streams.map(([streamName, body]) => {
    const header = Buffer.concat([le(offset, 4), le(body.length, 4), pad(Buffer.from(`${streamName}\0`, 'latin1'))]);
    offset += body.length;
    return header;
  });
  const metadata = Buffer.concat([
    le(metadataSignature, 4), le(1, 2), le(1, 2), le(0, 4), le(version16.length, 4), version16, le(0, 2), le(streams.length, 2),
    ...streamHeaders, ...streams.map(([, body]) => body),
  ]);

  // PE layout: headers in the first 0x200 bytes; a filler section at RVA 0x1000; the CLI header and metadata at RVA 0x2000.
  const cli = Buffer.alloc(72);
  cli.writeUInt32LE(72, 0); cli.writeUInt16LE(2, 4); cli.writeUInt16LE(5, 6);
  cli.writeUInt32LE(0x2000 + 0x80, 8); cli.writeUInt32LE(metadata.length, 12);
  cli.writeUInt32LE(1 | (strongName ? 0x8 : 0), 16);
  const text = Buffer.concat([cli, Buffer.alloc(0x80 - cli.length), metadata]);
  const textRaw = Math.ceil(text.length / 0x200) * 0x200;
  const headers = Buffer.alloc(0x200);
  headers.write('MZ', 0, 'latin1');
  headers.writeUInt32LE(0x40, 0x3c);
  headers.write('PE\0\0', 0x40, 'latin1');
  const coff = 0x44, optionalSize = pe32 ? 224 : 240, optional = 0x58;
  headers.writeUInt16LE(pe32 ? 0x14c : 0x8664, coff);
  headers.writeUInt16LE(2, coff + 2);
  headers.writeUInt16LE(optionalSize, coff + 16);
  headers.writeUInt16LE(0x2102, coff + 18);
  headers.writeUInt16LE(pe32 ? 0x10b : 0x20b, optional);
  const directories = optional + (pe32 ? 96 : 112);
  headers.writeUInt32LE(16, optional + (pe32 ? 92 : 108));
  if (!noCli) {
    headers.writeUInt32LE(0x2000, directories + 14 * 8);
    headers.writeUInt32LE(72, directories + 14 * 8 + 4);
  }
  const sections = optional + optionalSize;
  const section = (at, sectionName, virtualSize, rva, rawSize, rawPointer) => {
    headers.write(sectionName, at, 'latin1');
    headers.writeUInt32LE(virtualSize, at + 8); headers.writeUInt32LE(rva, at + 12);
    headers.writeUInt32LE(rawSize, at + 16); headers.writeUInt32LE(rawPointer, at + 20);
  };
  section(sections, '.rsrc', 0x200, 0x1000, 0x200, 0x200);
  section(sections + 40, '.text', text.length, 0x2000, textRaw, 0x400);
  return Buffer.concat([headers, Buffer.alloc(0x200), text, Buffer.alloc(textRaw - text.length)]);
}

// The base64 content the Dataverse API stores in pluginassembly.content.
export const assemblyBase64 = (options) => buildAssembly(options).toString('base64');

// A public key blob of invented bytes, long enough for the two-byte blob length.
export const fakePublicKey = Buffer.from(Array.from({ length: 160 }, (_, index) => (index * 37 + 11) & 0xff));

// A synthetic CMS envelope for certificate *inspection*, with an intentionally empty signature. It establishes no image trust.
// The supplied X.509 certificate was generated locally by the tests, never copied from a private project or live service.
export function certificateInspectionFixture(certDer, { precedingCertificates = [] } = {}) {
  const item = (offset) => {
    const start = offset, tag = certDer[offset++];
    let length = certDer[offset++];
    if (length & 128) {
      const count = length & 127;
      length = 0;
      for (let n = 0; n < count; n++) length = length * 256 + certDer[offset++];
    }
    return { tag, start, content: offset, end: offset + length };
  };
  const root = item(0), tbs = item(root.content), first = item(tbs.content);
  const serial = first.tag === 0xa0 ? item(first.end) : first;
  const signatureAlgorithm = item(serial.end), issuer = item(signatureAlgorithm.end);
  const der = (tag, ...parts) => {
    const bytes = Buffer.concat(parts), length = [];
    for (let value = bytes.length; value; value = Math.floor(value / 256)) length.unshift(value % 256);
    return Buffer.concat([Buffer.from([tag]), bytes.length < 128 ? Buffer.from([bytes.length]) : Buffer.from([128 + length.length, ...length]), bytes]);
  };
  const sequence = (...parts) => der(0x30, ...parts), set = (...parts) => der(0x31, ...parts);
  const integer = Buffer.from([2, 1, 1]);
  const signer = sequence(integer, sequence(certDer.subarray(issuer.start, issuer.end), certDer.subarray(serial.start, serial.end)), sequence(), sequence(), der(4));
  const signedData = sequence(integer, set(), sequence(), der(0xa0, ...precedingCertificates, certDer), set(signer));
  const cms = sequence(Buffer.from('06092a864886f70d010702', 'hex'), der(0xa0, signedData));
  const source = buildAssembly({ name: 'Invented.CertificateProbe' });
  const offset = Math.ceil(source.length / 8) * 8, entry = Buffer.alloc(Math.ceil((cms.length + 8) / 8) * 8);
  entry.writeUInt32LE(cms.length + 8, 0); entry.writeUInt16LE(0x200, 4); entry.writeUInt16LE(2, 6); cms.copy(entry, 8);
  const image = Buffer.concat([source, Buffer.alloc(offset - source.length), entry]);
  const pe = image.readUInt32LE(0x3c), optional = pe + 24, directories = optional + (image.readUInt16LE(optional) === 0x20b ? 112 : 96);
  image.writeUInt32LE(offset, directories + 32); image.writeUInt32LE(entry.length, directories + 36);
  return { image, cms, encodedIssuer: certDer.subarray(issuer.start, issuer.end).toString('base64') };
}
