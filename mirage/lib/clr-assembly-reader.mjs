// Reads the metadata of a .NET (CLR) assembly for plug-in registration (ECMA-335 Partition II: §24 physical layout, §22
// tables). Pure: it parses bytes and never loads or executes the assembly. It returns the identity (name, version, culture,
// public key token), the strong-name state, and each type with whether it is a plug-in (implements Microsoft.Xrm.Sdk.IPlugin)
// or a workflow activity (derives from System.Activities.CodeActivity). Every table is laid out, because row sizes depend on
// the row counts of the tables before them; only Assembly, TypeDef, TypeRef, InterfaceImpl and NestedClass are read.
import { createHash, X509Certificate } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

const PLUGIN_INTERFACE = 'Microsoft.Xrm.Sdk.IPlugin';
const ACTIVITY_BASE = 'System.Activities.CodeActivity';
const PE_SIGNATURE = 0x00004550;
const METADATA_SIGNATURE = 0x424a5342; // "BSJB"
const CLI_DIRECTORY = 14;
const STRONG_NAME_SIGNED = 0x8; // COMIMAGE_FLAGS_STRONGNAMESIGNED
const TYPE_REF = 1, TYPE_DEF = 2, INTERFACE_IMPL = 9, NESTED_CLASS = 41, ASSEMBLY = 32;

export class InvalidAssembly extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidAssembly';
  }
}
const invalid = (message) => new InvalidAssembly(message);

// Bounds-checked little-endian reads: every offset comes from the file, so each is checked before it is used.
function at(buffer, offset, size, what) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + size > buffer.length) throw invalid(`truncated ${what}`);
  return offset;
}
const u8 = (buffer, offset, what) => buffer.readUInt8(at(buffer, offset, 1, what));
const u16 = (buffer, offset, what) => buffer.readUInt16LE(at(buffer, offset, 2, what));
const u32 = (buffer, offset, what) => buffer.readUInt32LE(at(buffer, offset, 4, what));

// Coded indexes (§24.2.6): the low bits tag the target table; the targets are table ids, null for unused tags.
const CODED = {
  TypeDefOrRef: [2, [2, 1, 27]],
  HasConstant: [2, [4, 8, 23]],
  HasCustomAttribute: [5, [6, 4, 1, 2, 8, 9, 10, 0, 14, 23, 20, 17, 26, 27, 32, 35, 38, 39, 40, 42, 44, 43]],
  HasFieldMarshal: [1, [4, 8]],
  HasDeclSecurity: [2, [2, 6, 32]],
  MemberRefParent: [3, [2, 1, 26, 6, 27]],
  HasSemantics: [1, [20, 23]],
  MethodDefOrRef: [1, [6, 10]],
  MemberForwarded: [1, [4, 6]],
  Implementation: [2, [38, 35, 39]],
  CustomAttributeType: [3, [null, null, 6, 10, null]],
  ResolutionScope: [2, [0, 26, 35, 1]],
  TypeOrMethodDef: [1, [2, 6]],
};

// Column layouts by table id (§22). u1/u2/u4 are fixed; str, guid and blob are heap indexes; i:N is a simple index into
// table N (decimal); c:Kind is a coded index.
const COLUMNS = [
  'u2 str guid guid guid', // 0 Module
  'c:ResolutionScope str str', // 1 TypeRef
  'u4 str str c:TypeDefOrRef i:4 i:6', // 2 TypeDef
  'i:4', // 3 FieldPtr
  'u2 str blob', // 4 Field
  'i:6', // 5 MethodPtr
  'u4 u2 u2 str blob i:8', // 6 MethodDef
  'i:8', // 7 ParamPtr
  'u2 u2 str', // 8 Param
  'i:2 c:TypeDefOrRef', // 9 InterfaceImpl
  'c:MemberRefParent str blob', // 10 MemberRef
  'u1 u1 c:HasConstant blob', // 11 Constant
  'c:HasCustomAttribute c:CustomAttributeType blob', // 12 CustomAttribute
  'c:HasFieldMarshal blob', // 13 FieldMarshal
  'u2 c:HasDeclSecurity blob', // 14 DeclSecurity
  'u2 u4 i:2', // 15 ClassLayout
  'u4 i:4', // 16 FieldLayout
  'blob', // 17 StandAloneSig
  'i:2 i:20', // 18 EventMap
  'i:20', // 19 EventPtr
  'u2 str c:TypeDefOrRef', // 20 Event
  'i:2 i:23', // 21 PropertyMap
  'i:23', // 22 PropertyPtr
  'u2 str blob', // 23 Property
  'u2 i:6 c:HasSemantics', // 24 MethodSemantics
  'i:2 c:MethodDefOrRef c:MethodDefOrRef', // 25 MethodImpl
  'str', // 26 ModuleRef
  'blob', // 27 TypeSpec
  'u2 c:MemberForwarded str i:26', // 28 ImplMap
  'u4 i:4', // 29 FieldRVA
  'u4 u4', // 30 ENCLog
  'u4', // 31 ENCMap
  'u4 u2 u2 u2 u2 u4 blob str str', // 32 Assembly
  'u4', // 33 AssemblyProcessor
  'u4 u4 u4', // 34 AssemblyOS
  'u2 u2 u2 u2 u4 blob str str blob', // 35 AssemblyRef
  'u4 i:35', // 36 AssemblyRefProcessor
  'u4 u4 u4 i:35', // 37 AssemblyRefOS
  'u4 str blob', // 38 File
  'u4 u4 str str c:Implementation', // 39 ExportedType
  'u4 u4 str c:Implementation', // 40 ManifestResource
  'i:2 i:2', // 41 NestedClass
  'u2 u2 c:TypeOrMethodDef str', // 42 GenericParam
  'c:MethodDefOrRef blob', // 43 MethodSpec
  'i:42 c:TypeDefOrRef', // 44 GenericParamConstraint
];

// The #~ stream (§24.2.6): heap index sizes, the row count of each present table, then the rows.
function readTables(stream) {
  const heapSizes = u8(stream, 6, '#~ stream');
  const valid = [u32(stream, 8, '#~ stream'), u32(stream, 12, '#~ stream')];
  const present = [];
  for (let id = 0; id < 64; id++) if (((id < 32 ? valid[0] : valid[1]) >>> (id % 32)) & 1) present.push(id);
  const counts = new Array(COLUMNS.length).fill(0);
  let offset = 24;
  for (const id of present) {
    if (!COLUMNS[id]) throw invalid(`unsupported metadata table 0x${id.toString(16)}`);
    counts[id] = u32(stream, offset, '#~ row counts');
    offset += 4;
  }
  const heap = { str: heapSizes & 0x1 ? 4 : 2, guid: heapSizes & 0x2 ? 4 : 2, blob: heapSizes & 0x4 ? 4 : 2 };
  const widthOf = (token) => {
    if (token === 'u1') return 1;
    if (token === 'u2') return 2;
    if (token === 'u4') return 4;
    if (token in heap) return heap[token];
    if (token.startsWith('i:')) return counts[Number(token.slice(2))] < 0x10000 ? 2 : 4;
    const [bits, targets] = CODED[token.slice(2)];
    const rows = Math.max(0, ...targets.map((target) => (target === null ? 0 : counts[target])));
    return rows < 2 ** (16 - bits) ? 2 : 4;
  };
  const tables = [];
  for (const id of present) {
    const widths = COLUMNS[id].split(' ').map(widthOf);
    const size = widths.reduce((sum, width) => sum + width, 0);
    if (offset + size * counts[id] > stream.length) throw invalid('truncated metadata table');
    const rows = [];
    for (let row = 0; row < counts[id]; row++) {
      rows.push(widths.map((width) => {
        const value = width === 1 ? stream.readUInt8(offset) : width === 2 ? stream.readUInt16LE(offset) : stream.readUInt32LE(offset);
        offset += width;
        return value;
      }));
    }
    tables[id] = rows;
  }
  return tables;
}

// The coded index value is the row (1-based) shifted past the tag bits; row 0 is null.
function decodeCoded(kind, value) {
  const [bits, targets] = CODED[kind];
  const table = targets[value & ((1 << bits) - 1)];
  const row = value >>> bits;
  return table == null || row === 0 ? null : { table, row };
}

// The metadata root (§24.2.1) and its stream headers; each stream is a view of the metadata image.
function streamsOf(image) {
  if (u32(image, 0, 'metadata root') !== METADATA_SIGNATURE) throw invalid('missing metadata signature');
  let offset = 16 + u32(image, 12, 'metadata root');
  const count = u16(image, offset + 2, 'metadata root');
  offset += 4;
  const streams = new Map();
  for (let i = 0; i < count; i++) {
    const start = u32(image, offset, 'stream header'), size = u32(image, offset + 4, 'stream header');
    const nameStart = offset + 8, nameEnd = image.indexOf(0, nameStart);
    if (nameEnd < 0 || nameEnd - nameStart > 32) throw invalid('bad stream name');
    const name = image.toString('latin1', nameStart, nameEnd);
    offset = nameStart + Math.ceil((name.length + 1) / 4) * 4;
    if (start + size > image.length) throw invalid(`stream ${name} is outside the metadata`);
    streams.set(name, image.subarray(start, start + size));
  }
  return streams;
}

// Heap entries (§24.2.2 strings, §24.2.4 blobs). Index 0 is the empty entry.
function stringAt(strings, index) {
  if (index === 0) return '';
  if (index >= strings.length) throw invalid('string index outside #Strings');
  const end = strings.indexOf(0, index);
  if (end < 0) throw invalid('unterminated string in #Strings');
  return strings.toString('utf8', index, end);
}
function blobAt(blobs, index) {
  if (index === 0) return Buffer.alloc(0);
  const first = u8(blobs, index, '#Blob');
  let length, start;
  if ((first & 0x80) === 0) [length, start] = [first, index + 1];
  else if ((first & 0xc0) === 0x80) [length, start] = [((first & 0x3f) << 8) | u8(blobs, index + 1, '#Blob'), index + 2];
  else if ((first & 0xe0) === 0xc0) [length, start] = [((first & 0x1f) << 24) | (u8(blobs, index + 1, '#Blob') << 16) | (u8(blobs, index + 2, '#Blob') << 8) | u8(blobs, index + 3, '#Blob'), index + 4];
  else throw invalid('invalid blob length');
  at(blobs, start, length, '#Blob');
  return blobs.subarray(start, start + length);
}

/**
 * The identity and the plug-in facts of an assembly image. Throws InvalidAssembly for anything that is not a managed
 * assembly with an Assembly row, including truncated images.
 */
export function inspectAssembly(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (buffer.length < 0x40 || buffer.toString('latin1', 0, 2) !== 'MZ') throw invalid('missing MZ header');
  const pe = u32(buffer, 0x3c, 'DOS header');
  if (u32(buffer, pe, 'PE header') !== PE_SIGNATURE) throw invalid('missing PE signature');
  const coff = pe + 4;
  const sectionCount = u16(buffer, coff + 2, 'COFF header');
  const optionalSize = u16(buffer, coff + 16, 'COFF header');
  const optional = coff + 20;
  const magic = u16(buffer, optional, 'optional header');
  if (magic !== 0x10b && magic !== 0x20b) throw invalid('unknown optional header');
  const plus = magic === 0x20b; // PE32+ has 8-byte image bases and no BaseOfData
  const directories = optional + (plus ? 112 : 96);
  if (u32(buffer, optional + (plus ? 108 : 92), 'optional header') <= CLI_DIRECTORY) throw invalid('no CLI header');
  const cliRva = u32(buffer, directories + CLI_DIRECTORY * 8, 'data directories');
  if (cliRva === 0) throw invalid('no CLI header');
  const sections = Array.from({ length: sectionCount }, (_, i) => {
    const entry = optional + optionalSize + i * 40;
    const virtualSize = u32(buffer, entry + 8, 'section table'), rawSize = u32(buffer, entry + 16, 'section table');
    return { rva: u32(buffer, entry + 12, 'section table'), size: virtualSize === 0 ? rawSize : Math.min(virtualSize, rawSize), raw: u32(buffer, entry + 20, 'section table') };
  });
  const offsetOf = (rva, what) => {
    const section = sections.find((candidate) => rva >= candidate.rva && rva - candidate.rva < candidate.size);
    if (!section) throw invalid(`${what} RVA is outside the sections`);
    return rva - section.rva + section.raw;
  };
  const cli = offsetOf(cliRva, 'CLI header');
  const cliFlags = u32(buffer, cli + 16, 'CLI header');
  const meta = offsetOf(u32(buffer, cli + 8, 'CLI header'), 'metadata');
  const metaSize = u32(buffer, cli + 12, 'CLI header');
  const image = buffer.subarray(at(buffer, meta, metaSize, 'metadata'), meta + metaSize);
  const streams = streamsOf(image);
  const tableStream = streams.get('#~');
  if (!tableStream) throw invalid('no #~ stream');
  const tables = readTables(tableStream);
  const strings = streams.get('#Strings') ?? Buffer.alloc(0);
  const blobs = streams.get('#Blob') ?? Buffer.alloc(0);

  const typeRefs = tables[TYPE_REF] ?? [], typeDefs = tables[TYPE_DEF] ?? [];
  const row = (table, index, name) => {
    if (!(table[index - 1])) throw invalid(`${name} row ${index} is outside the table`);
    return table[index - 1];
  };
  const nested = new Map(); // inner TypeDef row -> enclosing TypeDef row
  for (const entry of tables[NESTED_CLASS] ?? []) nested.set(entry[0], entry[1]);
  const interfaces = new Map(); // TypeDef row -> the interfaces it names directly
  for (const entry of tables[INTERFACE_IMPL] ?? []) {
    const list = interfaces.get(entry[0]) ?? [];
    list.push(decodeCoded('TypeDefOrRef', entry[1]));
    interfaces.set(entry[0], list);
  }
  const typeRefName = (index) => {
    const [, name, namespace] = row(typeRefs, index, 'TypeRef');
    return [stringAt(strings, namespace), stringAt(strings, name)].filter(Boolean).join('.');
  };
  const typeDefName = (index, seen = new Set()) => {
    if (seen.has(index)) throw invalid('nested type cycle');
    seen.add(index);
    const [, name, namespace] = row(typeDefs, index, 'TypeDef');
    if (nested.has(index)) return `${typeDefName(nested.get(index), seen)}+${stringAt(strings, name)}`;
    return [stringAt(strings, namespace), stringAt(strings, name)].filter(Boolean).join('.');
  };
  const nameOf = (ref) => (ref?.table === TYPE_DEF ? typeDefName(ref.row) : ref?.table === TYPE_REF ? typeRefName(ref.row) : null);
  const baseOf = (index) => decodeCoded('TypeDefOrRef', row(typeDefs, index, 'TypeDef')[3]);
  // Direct interfaces and direct base only; a base defined in this assembly is followed, an external base is not (ceiling).
  const isPlugin = (index, seen = new Set()) => {
    if (seen.has(index)) return false;
    seen.add(index);
    if ((interfaces.get(index) ?? []).some((ref) => nameOf(ref) === PLUGIN_INTERFACE)) return true;
    const base = baseOf(index);
    return base?.table === TYPE_DEF && isPlugin(base.row, seen);
  };
  const isActivity = (index, seen = new Set()) => {
    if (seen.has(index)) return false;
    seen.add(index);
    const base = baseOf(index);
    if (nameOf(base) === ACTIVITY_BASE) return true; // a local CodeActivity is a TypeDef, an external one a TypeRef
    return base?.table === TYPE_DEF && isActivity(base.row, seen);
  };

  const assembly = tables[ASSEMBLY]?.[0];
  if (!assembly) throw invalid('no Assembly row');
  const [, major, minor, build, revision, , publicKeyIndex, nameIndex, cultureIndex] = assembly;
  const publicKey = blobAt(blobs, publicKeyIndex);
  const types = [];
  for (let index = 1; index <= typeDefs.length; index++) {
    const fullName = typeDefName(index);
    if (fullName !== '<Module>') types.push({ fullName, isPlugin: isPlugin(index), isWorkflowActivity: isActivity(index) });
  }
  return {
    name: stringAt(strings, nameIndex),
    version: [major, minor, build, revision].join('.'),
    major, minor,
    culture: stringAt(strings, cultureIndex) || 'neutral',
    // The token is the last 8 bytes of SHA-1 over the public key, in reverse order (ECMA-335 §6.2.1.3 strong-name signing).
    publicKeyToken: publicKey.length ? createHash('sha1').update(publicKey).digest().subarray(12).reverse().toString('hex') : null,
    strongNamed: publicKey.length > 0 && (cliFlags & STRONG_NAME_SIGNED) !== 0,
    types,
  };
}

// Certificate inspection reads only the PE WIN_CERTIFICATE / NuGet CMS signature. It never loads code, reaches a certificate
// authority, validates image signatures or establishes trust. Bounds follow the PE attribute certificate table and RFC5652.
// https://learn.microsoft.com/en-us/windows/win32/debug/pe-format#the-attribute-certificate-table-image-only
// https://www.rfc-editor.org/rfc/rfc5652#section-5
const CERTIFICATE_LIMIT = 16 * 1024 * 1024;

function derReader(buffer) {
  let remaining = 4096;
  const node = (offset, limit = buffer.length) => {
    if (--remaining < 0 || offset < 0 || offset + 2 > limit) throw invalid('invalid certificate DER bounds');
    const start = offset, tag = buffer[offset++];
    let size = buffer[offset++];
    if (size & 0x80) {
      const count = size & 0x7f;
      if (!count || count > 4 || offset + count > limit) throw invalid('invalid certificate DER length');
      size = 0;
      for (let n = 0; n < count; n++) size = size * 256 + buffer[offset++];
    }
    if (offset + size > limit) throw invalid('truncated certificate DER');
    return { tag, start, content: offset, end: offset + size };
  };
  const children = (parent) => {
    const result = [];
    for (let offset = parent.content; offset < parent.end;) {
      const child = node(offset, parent.end);
      result.push(child);
      offset = child.end;
    }
    return result;
  };
  const raw = (value) => buffer.subarray(value.start, value.end);
  const content = (value) => buffer.subarray(value.content, value.end);
  return { node, children, raw, content };
}

/** Extract the first CMS signer's certificate by issuer and serial number, never an unrelated certificate from its chain. */
function cmsCertificate(buffer) {
  if (!buffer.length || buffer.length > CERTIFICATE_LIMIT) throw invalid('certificate signature exceeds the inspection limit');
  const der = derReader(buffer), root = der.node(0);
  const [oid, wrapper] = der.children(root);
  if (root.tag !== 0x30 || oid?.tag !== 6 || der.content(oid).toString('hex') !== '2a864886f70d010702' || wrapper?.tag !== 0xa0) throw invalid('certificate is not CMS SignedData');
  const signedData = der.children(wrapper)[0];
  if (signedData?.tag !== 0x30) throw invalid('invalid CMS SignedData');
  const fields = der.children(signedData);
  const certificates = fields.slice(3).find((field) => field.tag === 0xa0);
  const signerSet = fields.at(-1);
  if (!certificates || signerSet?.tag !== 0x31) throw invalid('CMS signature has no signer certificates');
  const signers = der.children(signerSet);
  if (!signers.length) throw invalid('CMS signature has no signer');
  const sid = der.children(signers[0])[1];
  if (sid?.tag !== 0x30) throw invalid('unsupported CMS signer identifier');
  const [signerIssuer, signerSerial] = der.children(sid);
  if (!signerIssuer || signerSerial?.tag !== 2) throw invalid('invalid CMS signer identity');
  const serial = (value) => der.content(value).toString('hex').replace(/^(?:00)+/, '').toLowerCase();
  for (const candidate of der.children(certificates)) {
    if (candidate.tag !== 0x30) continue;
    const [tbs] = der.children(candidate);
    if (tbs?.tag !== 0x30) continue;
    const parts = der.children(tbs), index = parts[0]?.tag === 0xa0 ? 1 : 0;
    const certificateSerial = parts[index], issuer = parts[index + 2], subject = parts[index + 4];
    if (certificateSerial?.tag !== 2 || !issuer || !subject) continue;
    if (serial(certificateSerial) !== serial(signerSerial) || !der.raw(issuer).equals(der.raw(signerIssuer))) continue;
    let cert;
    try { cert = new X509Certificate(der.raw(candidate)); } catch { throw invalid('invalid signer X.509 certificate'); }
    return {
      subject: cert.subject, issuer: cert.issuer, hash: cert.fingerprint.replaceAll(':', ''),
      selfSigned: cert.subject === cert.issuer && cert.verify(cert.publicKey),
      certificate: cert.raw.toString('base64'), encodedSubject: der.raw(subject).toString('base64'), encodedIssuer: der.raw(issuer).toString('base64'),
    };
  }
  throw invalid('CMS signer certificate is missing');
}

function packageSignature(buffer) {
  // The ZIP central directory supplies sizes even when local headers use data descriptors. ZIP64/encryption are refused.
  let end = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset--) {
    if (u32(buffer, offset, 'ZIP end') === 0x06054b50 && offset + 22 + u16(buffer, offset + 20, 'ZIP comment') === buffer.length) { end = offset; break; }
  }
  if (end < 0) throw invalid('invalid NuGet package ZIP');
  const count = u16(buffer, end + 10, 'ZIP count');
  if (count === 0xffff || u16(buffer, end + 4, 'ZIP disk') || u16(buffer, end + 6, 'ZIP disk')) throw invalid('unsupported NuGet package ZIP');
  let offset = u32(buffer, end + 16, 'ZIP central directory');
  for (let index = 0; index < count; index++) {
    if (u32(buffer, offset, 'ZIP central entry') !== 0x02014b50) throw invalid('invalid ZIP central entry');
    const flags = u16(buffer, offset + 8, 'ZIP flags'), method = u16(buffer, offset + 10, 'ZIP compression');
    const compressed = u32(buffer, offset + 20, 'ZIP compressed size'), expanded = u32(buffer, offset + 24, 'ZIP expanded size');
    const nameLength = u16(buffer, offset + 28, 'ZIP name'), extraLength = u16(buffer, offset + 30, 'ZIP extra'), commentLength = u16(buffer, offset + 32, 'ZIP comment');
    at(buffer, offset + 46, nameLength + extraLength + commentLength, 'ZIP entry');
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (name === '.signature.p7s') {
      if (flags & 1 || ![0, 8].includes(method) || expanded > CERTIFICATE_LIMIT || compressed > CERTIFICATE_LIMIT) throw invalid('unsupported package signature ZIP entry');
      const local = u32(buffer, offset + 42, 'ZIP local offset');
      if (u32(buffer, local, 'ZIP local entry') !== 0x04034b50) throw invalid('invalid ZIP local signature entry');
      const start = local + 30 + u16(buffer, local + 26, 'ZIP local name') + u16(buffer, local + 28, 'ZIP local extra');
      const bytes = buffer.subarray(at(buffer, start, compressed, 'ZIP signature bytes'), start + compressed);
      let signature;
      try { signature = method === 8 ? inflateRawSync(bytes, { maxOutputLength: CERTIFICATE_LIMIT }) : bytes; } catch { throw invalid('invalid compressed package signature'); }
      if (signature.length !== expanded) throw invalid('package signature size mismatch');
      return signature;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

/** Signing certificate facts of a PE assembly or NuGet package. Null means no embedded signature; malformed data fails. */
export function inspectSigningCertificate(input, { package: isPackage = false } = {}) {
  const buffer = Buffer.from(input);
  if (!buffer.length || buffer.length > CERTIFICATE_LIMIT) throw invalid('certificate source exceeds the inspection limit');
  if (isPackage) {
    const signature = packageSignature(buffer);
    return signature ? cmsCertificate(signature) : null;
  }
  if (buffer.length < 64 || u16(buffer, 0, 'DOS header') !== 0x5a4d) throw invalid('missing MZ header');
  const pe = u32(buffer, 0x3c, 'DOS header');
  if (u32(buffer, pe, 'PE header') !== PE_SIGNATURE) throw invalid('missing PE signature');
  const optional = pe + 24, size = u16(buffer, pe + 20, 'COFF optional size'), magic = u16(buffer, optional, 'optional magic');
  if (![0x10b, 0x20b].includes(magic)) throw invalid('unknown optional header');
  const directory = optional + (magic === 0x20b ? 112 : 96);
  const entry = directory + 4 * 8;
  if (entry + 8 > optional + size || u32(buffer, directory - 4, 'PE directory count') <= 4) return null;
  const offset = u32(buffer, entry, 'certificate offset'), length = u32(buffer, entry + 4, 'certificate size');
  if (!offset && !length) return null;
  at(buffer, offset, length, 'certificate table');
  if (!offset || length < 8) throw invalid('invalid certificate table');
  for (let cursor = offset; cursor < offset + length;) {
    const count = u32(buffer, cursor, 'WIN_CERTIFICATE length');
    if (count < 8 || cursor + count > offset + length) throw invalid('invalid WIN_CERTIFICATE bounds');
    const revision = u16(buffer, cursor + 4, 'WIN_CERTIFICATE revision'), type = u16(buffer, cursor + 6, 'WIN_CERTIFICATE type');
    if (revision === 0x200 && type === 2) return cmsCertificate(buffer.subarray(cursor + 8, cursor + count));
    cursor += Math.ceil(count / 8) * 8;
  }
  throw invalid('no supported PKCS7 certificate entry');
}
