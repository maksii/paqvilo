// In-memory solution package transport and persisted asset layers. Nothing extracts files, executes scripts, loads assemblies,
// or changes selected source directories. Import/export and projection callers supply the transaction and component semantics.
import { createHash } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

export class SolutionArchiveError extends Error {
  constructor(message, code = 'InvalidArchive') {
    super(message);
    this.name = 'SolutionArchiveError';
    this.code = code;
  }
}

export const SOLUTION_ASSET_LIMITS = Object.freeze({
  archiveBytes: 128 * 1024 * 1024,
  entryBytes: 128 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
  entries: 10000,
  layers: 256,
});
// The scan reader's archive ceiling. Uploads and imports keep SOLUTION_ASSET_LIMITS.archiveBytes; an explicit
// archiveBytes option may raise it up to this value, and every other limit stays at its shared value.
export const SCAN_ARCHIVE_BYTES = 256 * 1024 * 1024;
const LIMIT_CEILINGS = Object.freeze({ ...SOLUTION_ASSET_LIMITS, archiveBytes: SCAN_ARCHIVE_BYTES });
const fail = (message, code) => {
  throw new SolutionArchiveError(message, code);
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const identity = (value) =>
  String(value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
const compare = (left, right) => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};
const limitsOf = (options = {}) =>
  Object.fromEntries(
    Object.entries(SOLUTION_ASSET_LIMITS).map(([name, shared]) => {
      const value = options[name] ?? shared;
      if (!Number.isSafeInteger(value) || value < 1 || value > LIMIT_CEILINGS[name])
        fail(`Invalid solution archive limit ${name}.`, 'ArchiveLimit');
      return [name, value];
    }),
  );
const bounds = (buffer, offset, count, limit = buffer.length) => {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(count) ||
    offset < 0 ||
    count < 0 ||
    offset + count > limit ||
    limit > buffer.length
  )
    fail('Truncated solution archive.');
  return offset;
};
const uint16 = (bytes, offset) => bytes.readUInt16LE(bounds(bytes, offset, 2));
const uint32 = (bytes, offset) => bytes.readUInt32LE(bounds(bytes, offset, 4));
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
const crc32 = (bytes) => {
  let crc = 0xffffffff;
  for (const value of bytes) crc = crcTable[(crc ^ value) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

/**
 * Normalize ZIP separators only; reject ambiguous/traversing names even though this module never writes paths.
 * `cosmetic: false` keeps the control-character, absolute, length and traversal checks and drops the rest: a colon,
 * a segment ending in a dot or space, a `.` or empty segment.
 */
export function solutionAssetName(input, { cosmetic = true } = {}) {
  // eslint-disable-next-line no-control-regex -- This parser intentionally recognizes control bytes in untrusted text.
  if (typeof input !== 'string' || !input || /[\x00-\x1f\x7f]/.test(input) || (cosmetic && input.includes(':')))
    fail('Invalid solution asset path.', 'EntryPath');
  const name = input.replaceAll('\\', '/');
  if (name.startsWith('/') || name.length > 4096) fail('Invalid solution asset path.', 'EntryPath');
  const segments = name.replace(/\/$/, '').split('/');
  if (segments.some((part) => part === '..' || (cosmetic && (!part || part === '.' || /[. ]$/.test(part)))))
    fail('Invalid solution asset path.', 'EntryPath');
  return name;
}
const nameKey = (name) => name.normalize('NFC').toLowerCase();
// Re-encoding the lossy decoding reproduces the bytes only when they are valid UTF-8.
const isUtf8 = (bytes) => Buffer.from(bytes.toString('utf8')).equals(bytes);
function checkedEntries(input, limits) {
  if (!Array.isArray(input) || input.length > limits.entries)
    fail('Solution archive has too many entries.', 'ArchiveLimit');
  const seen = new Set();
  let total = 0;
  return input.map((entry) => {
    const name = solutionAssetName(entry?.name),
      key = nameKey(name);
    if (seen.has(key)) fail('Duplicate solution asset path.', 'EntryPath');
    seen.add(key);
    if (!Buffer.isBuffer(entry.data) && !(entry.data instanceof Uint8Array))
      fail('Solution asset content must be bytes.');
    const data = Buffer.from(entry.data);
    total += data.length;
    if (data.length > limits.entryBytes || total > limits.totalBytes)
      fail('Solution assets exceed the uncompressed size limit.', 'ArchiveLimit');
    return { name, data };
  });
}

function directoryEntryInfo(bytes, cursor, end) {
  bounds(bytes, cursor, 46, end);
  if (uint32(bytes, cursor) !== 0x02014b50) fail('Invalid solution ZIP directory entry.');
  const flags = uint16(bytes, cursor + 8),
    method = uint16(bytes, cursor + 10),
    crc = uint32(bytes, cursor + 16);
  const packed = uint32(bytes, cursor + 20),
    unpacked = uint32(bytes, cursor + 24),
    nameLength = uint16(bytes, cursor + 28);
  const extraLength = uint16(bytes, cursor + 30),
    commentLength = uint16(bytes, cursor + 32),
    disk = uint16(bytes, cursor + 34),
    local = uint32(bytes, cursor + 42);
  bounds(bytes, cursor + 46, nameLength + extraLength + commentLength, end);
  return { flags, method, crc, packed, unpacked, nameLength, extraLength, commentLength, disk, local };
}

// The header field this reader does not support, or null. The walk refuses it for every kept entry, and for an unkept entry
// only on the member, so a caller that reads only kept names never meets it.
function directoryEntryRefusal(info) {
  if (info.flags & 0x41) return 'Encrypted solution archives are unsupported.';
  if (![0, 8].includes(info.method)) return 'Unsupported solution ZIP compression method.';
  if (info.packed === 0xffffffff || info.unpacked === 0xffffffff || info.local === 0xffffffff || info.disk)
    return 'ZIP64 or split solution entries are unsupported.';
  return null;
}

function directoryEntryTotal(info, limits, total) {
  const next = total + info.unpacked;
  if (info.unpacked > limits.entryBytes || next > limits.totalBytes)
    fail('Solution assets exceed the uncompressed size limit.', 'ArchiveLimit');
  return next;
}

// Exact names are unique in every archive. A name the caller keeps also folds case: two documents for one logical file
// are ambiguous, while two names the caller skips are never read.
function claimName(names, name, strict) {
  if (names.exact.has(name)) fail('Duplicate solution asset path.', 'EntryPath');
  names.exact.add(name);
  if (!strict) return;
  const key = nameKey(name);
  if (names.folded.has(key)) fail('Duplicate solution asset path.', 'EntryPath');
  names.folded.add(key);
}

function directoryEntryName(bytes, cursor, info, names, strictNames) {
  const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + info.nameLength),
    raw = nameBytes.toString('utf8').replaceAll('\\', '/');
  if (raw.startsWith('/') || raw.split('/').includes('..') || /^[a-z]:/i.test(raw))
    fail('Solution ZIP contains a traversal path.', 'EntryPath');
  const strict = strictNames(raw);
  if (strict && !isUtf8(nameBytes)) fail('Unsupported solution asset filename encoding.', 'EntryPath');
  const name = solutionAssetName(raw, { cosmetic: strict });
  claimName(names, name, strict);
  const mode = uint32(bytes, cursor + 38) >>> 16;
  if ((mode & 0xf000) === 0xa000) fail('Solution archives cannot contain symbolic links.', 'EntryPath');
  return { name, strict };
}

function localEntryRange(bytes, info, name, start) {
  bounds(bytes, info.local, 30, start);
  if (
    uint32(bytes, info.local) !== 0x04034b50 ||
    uint16(bytes, info.local + 6) !== info.flags ||
    uint16(bytes, info.local + 8) !== info.method
  )
    fail('Solution ZIP local header disagrees with its directory.');
  const localNameLength = uint16(bytes, info.local + 26),
    localExtraLength = uint16(bytes, info.local + 28);
  bounds(bytes, info.local + 30, localNameLength + localExtraLength, start);
  const localName = bytes.subarray(info.local + 30, info.local + 30 + localNameLength).toString('utf8');
  if (localName.replaceAll('\\', '/') !== name) fail('Solution ZIP local filename disagrees with its directory.');
  if (
    !(info.flags & 8) &&
    (uint32(bytes, info.local + 14) !== info.crc ||
      uint32(bytes, info.local + 18) !== info.packed ||
      uint32(bytes, info.local + 22) !== info.unpacked)
  )
    fail('Solution ZIP local sizes disagree with its directory.');
  const body = info.local + 30 + localNameLength + localExtraLength;
  bounds(bytes, body, info.packed, start);
  return { body, rangeEnd: body + info.packed };
}

/**
 * Inflates one member of a validated directory and checks its declared size. The CRC is checked unless `verifyCrc` is
 * false: then only the declared size is checked. The scan reader passes false for XML documents.
 */
export function inflateSolutionZipMember(
  bytes,
  member,
  { maxBytes = SOLUTION_ASSET_LIMITS.entryBytes, verifyCrc = true } = {},
) {
  const { info, body } = member;
  const compressed = bytes.subarray(body, body + info.packed);
  let data;
  try {
    data =
      info.method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, {
            maxOutputLength: Math.max(1, Math.min(maxBytes, info.unpacked)),
          });
  } catch {
    fail('Invalid or oversized compressed solution asset.');
  }
  if (data.length !== info.unpacked || (verifyCrc && crc32(data) !== info.crc))
    fail('Solution asset size or CRC does not match its directory.');
  return data;
}

function appendInflatedEntry(bytes, member, limits, entries) {
  const data = inflateSolutionZipMember(bytes, member, { maxBytes: limits.entryBytes });
  if (!member.name.endsWith('/')) entries.push({ name: member.name, data });
  else if (data.length) fail('A solution directory entry contains file data.');
}

function findDirectoryEnd(bytes) {
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (uint32(bytes, offset) === 0x06054b50 && offset + 22 + uint16(bytes, offset + 20) === bytes.length) {
      end = offset;
      break;
    }
  }
  return end;
}

function hasOverlappingRange(ranges, local, rangeEnd) {
  return ranges.some(([left, right]) => local < right && rangeEnd > left);
}

function archiveBuffer(input, limits) {
  if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) fail('Solution archive must be bytes.');
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length > limits.archiveBytes) fail('Solution archive exceeds the compressed size limit.', 'ArchiveLimit');
  return bytes;
}

// The end record's entry count, central directory offset and size, checked against the limits before any entry is read.
function directoryLayout(bytes, limits) {
  const end = findDirectoryEnd(bytes);
  if (end < 0) fail('Solution ZIP end directory is missing.');
  const count = uint16(bytes, end + 10),
    size = uint32(bytes, end + 12),
    start = uint32(bytes, end + 16);
  if (uint16(bytes, end + 4) || uint16(bytes, end + 6) || uint16(bytes, end + 8) !== count)
    fail('Multi-disk solution archives are unsupported.', 'UnsupportedArchive');
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff)
    fail('ZIP64 solution archives are unsupported.', 'UnsupportedArchive');
  if (count > limits.entries) fail('Solution archive has too many entries.', 'ArchiveLimit');
  bounds(bytes, start, size, end);
  if (start + size !== end) fail('The solution ZIP directory size is invalid.');
  return { end, start, count };
}

// Strict readers refuse a bad local header. Deferred readers keep it on the member, so only that payload fails when read.
function localRange(bytes, info, name, start, deferred) {
  bounds(bytes, info.local, 30, start);
  if (!deferred) return localEntryRange(bytes, info, name, start);
  try {
    return localEntryRange(bytes, info, name, start);
  } catch (error) {
    return { error };
  }
}

// Two central entries never share a local header, and no validated payload range overlaps another.
function claimLocalRange(claims, info, range) {
  const overlaps = !range.error && hasOverlappingRange(claims.ranges, info.local, range.rangeEnd);
  if (claims.offsets.has(info.local) || overlaps) fail('Overlapping solution ZIP entries.');
  claims.offsets.add(info.local);
  if (!range.error) claims.ranges.push([info.local, range.rangeEnd]);
}

function refusalError(refusal) {
  return refusal ? new SolutionArchiveError(refusal, 'UnsupportedArchive') : undefined;
}

// A refused entry the caller does not read (strictNames) keeps its refusal on the member and is not sized. Its local header
// is still checked for an offset outside the archive, unless the offset is the ZIP64 marker, which names no header.
function walkDirectory(bytes, { end, start, count }, limits, options) {
  const members = [],
    names = { exact: new Set(), folded: new Set() },
    claims = { offsets: new Set(), ranges: [] },
    deferred = options.deferLocalHeaders === true,
    strictNames = options.strictNames ?? (() => true);
  let cursor = start,
    total = 0;
  for (let index = 0; index < count; index++) {
    const info = directoryEntryInfo(bytes, cursor, end),
      { name, strict } = directoryEntryName(bytes, cursor, info, names, strictNames),
      refusal = directoryEntryRefusal(info);
    if (refusal && strict) fail(refusal, 'UnsupportedArchive');
    if (!refusal) total = directoryEntryTotal(info, limits, total);
    const local =
      refusal && info.local === 0xffffffff ? null : localRange(bytes, info, name, start, deferred || refusal !== null);
    if (local) claimLocalRange(claims, info, local);
    cursor += 46 + info.nameLength + info.extraLength + info.commentLength;
    // Inventory callers account every validated member, including directories and excluded payloads.
    options.onEntry?.(name);
    members.push({ name, info, body: local?.body, error: refusalError(refusal) ?? local?.error });
  }
  if (cursor !== end) fail('Trailing or missing solution ZIP directory entries.');
  return members;
}

/**
 * Validates a stored/deflated single-disk ZIP directory without inflating a payload. Symlinks, encryption, ZIP64,
 * duplicate or overlapping local headers, offsets outside the archive and declared sizes above the budget fail first.
 * `deferLocalHeaders` keeps a local-header content mismatch on its member (`member.error`). `onEntry(name)` sees each
 * validated member, including directories and payloads the caller excludes. `strictNames(name)` says which entries get the
 * cosmetic name rules and the case-folded duplicate check; by default every entry gets them.
 */
export function validateSolutionZipDirectory(input, options = {}) {
  const limits = limitsOf(options);
  const bytes = archiveBuffer(input, limits);
  const layout = directoryLayout(bytes, limits);
  return { bytes, limits, members: walkDirectory(bytes, layout, limits, options) };
}

/**
 * Stored/deflated single-disk ZIP, including data descriptors. `include(name)` selects the files to return: every directory
 * and local header is validated first, and only selected entries are inflated and CRC-checked.
 */
export function readSolutionAssetEntries(input, options = {}) {
  const { bytes, limits, members } = validateSolutionZipDirectory(input, options);
  const include = options.include ?? (() => true);
  const entries = [];
  for (const member of members) {
    if (!member.name.endsWith('/') && !include(member.name)) continue;
    appendInflatedEntry(bytes, member, limits, entries);
  }
  return entries;
}

/** Deterministic ZIP writer. Opaque bytes are preserved even when the ZIP compression representation changes. */
export function writeSolutionAssetEntries(input, options = {}) {
  const limits = limitsOf(options),
    entries = checkedEntries(input, limits),
    localParts = [],
    centralParts = [];
  let offset = 0;
  for (const { name, data } of entries) {
    if (name.endsWith('/')) fail('The solution ZIP writer accepts files only.', 'EntryPath');
    const encodedName = Buffer.from(name, 'utf8');
    const candidate = deflateRawSync(data),
      compressed = candidate.length < data.length ? candidate : data;
    const method = compressed === data ? 0 : 8,
      crc = crc32(data),
      local = Buffer.alloc(30),
      central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(encodedName.length, 26);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(encodedName.length, 28);
    central.writeUInt32LE(offset, 42);
    localParts.push(local, encodedName, compressed);
    centralParts.push(central, encodedName);
    offset += local.length + encodedName.length + compressed.length;
    if (offset > limits.archiveBytes) fail('Solution archive exceeds the compressed size limit.', 'ArchiveLimit');
  }
  const central = Buffer.concat(centralParts),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  if (offset + central.length + end.length > limits.archiveBytes)
    fail('Solution archive exceeds the compressed size limit.', 'ArchiveLimit');
  return Buffer.concat([...localParts, central, end]);
}

const assetState = (state) => state.dataverse?.solutionAssets ?? { version: 1, sequence: 0, layers: [] };
function checkedState(state) {
  const assets = assetState(state);
  if (
    assets.version !== 1 ||
    !Number.isSafeInteger(assets.sequence) ||
    assets.sequence < 0 ||
    !Array.isArray(assets.layers)
  )
    fail('Unsupported persisted solution asset state.', 'AssetState');
  return assets;
}
const ownerId = (value) => {
  const id = identity(value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))
    fail('A solution asset layer needs a solution id.', 'AssetState');
  return id;
};

/** Append an immutable transport layer inside the caller's import transaction. Component projections are separate. */
export function appendSolutionAssetLayer(state, solutionId, input, metadata = {}, options = {}) {
  const limits = limitsOf(options),
    owner = ownerId(solutionId),
    assets = checkedState(state);
  if (assets.layers.length >= limits.layers) fail('Too many persisted solution asset layers.', 'ArchiveLimit');
  const sequence = assets.sequence + 1;
  const entries = checkedEntries(input, limits)
    .filter((entry) => !entry.name.endsWith('/'))
    .sort((left, right) => compare(left.name, right.name))
    .map(({ name, data }) => ({ name, bytes: data.length, sha256: hash(data), content: data.toString('base64') }));
  const storedBytes = [...assets.layers.flatMap((layer) => layer.entries), ...entries].reduce(
    (sum, entry) => sum + entry.bytes,
    0,
  );
  if (!Number.isSafeInteger(storedBytes) || storedBytes > limits.totalBytes)
    fail('Persisted solution assets exceed the uncompressed size limit.', 'ArchiveLimit');
  const layer = {
    id: hash(Buffer.from(JSON.stringify([owner, sequence, entries.map((entry) => [entry.name, entry.sha256])]))),
    ownerSolutionId: owner,
    sourceSolutionId: owner,
    sequence,
    uniqueName: String(metadata.uniqueName ?? ''),
    solutionVersion: String(metadata.version ?? ''),
    managed: metadata.managed === true,
    entries,
  };
  // No state change occurs until all names, sizes and content have passed validation.
  state.dataverse ??= {};
  state.dataverse.solutionAssets = { version: 1, sequence, layers: [...assets.layers, layer] };
  return layer.id;
}

/** JSON-safe layer snapshots; sourceSolutionId survives patch roll-up as provenance, while ownership can move. */
export function solutionAssetLayers(state, { solutionIds } = {}) {
  const owners = solutionIds ? new Set(solutionIds.map(ownerId)) : null;
  return structuredClone(
    checkedState(state)
      .layers.filter((layer) => !owners || owners.has(layer.ownerSolutionId))
      .sort((left, right) => left.sequence - right.sequence),
  );
}

/** Reassign the selected patch layers to a roll-up solution without flattening their XML documents or losing asset identity. */
export function reassignSolutionAssetLayers(state, sourceIds, targetId) {
  const target = ownerId(targetId),
    sources = new Set(sourceIds.map(ownerId)),
    assets = checkedState(state);
  state.dataverse ??= {};
  state.dataverse.solutionAssets = {
    ...assets,
    layers: assets.layers.map((layer) =>
      sources.has(layer.ownerSolutionId) ? { ...layer, ownerSolutionId: target } : layer,
    ),
  };
}

export function removeSolutionAssetLayers(state, solutionIds) {
  const owners = new Set(solutionIds.map(ownerId)),
    assets = checkedState(state);
  state.dataverse ??= {};
  state.dataverse.solutionAssets = {
    ...assets,
    layers: assets.layers.filter((layer) => !owners.has(layer.ownerSolutionId)),
  };
}

/** Byte-level file overlay for one owner. XML component merge must happen in the semantic projection/export adapter. */
export function latestSolutionAssetEntries(state, solutionId) {
  const files = new Map();
  for (const layer of solutionAssetLayers(state, { solutionIds: [solutionId] }))
    for (const entry of layer.entries) {
      const name = solutionAssetName(entry.name),
        data = Buffer.from(entry.content, 'base64');
      if (data.length !== entry.bytes || hash(data) !== entry.sha256)
        fail('Persisted solution asset integrity failed.', 'AssetState');
      files.set(nameKey(name), { name, data });
    }
  return [...files.values()].sort((left, right) => compare(left.name, right.name));
}
