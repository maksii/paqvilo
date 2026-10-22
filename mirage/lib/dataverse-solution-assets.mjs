// In-memory solution package transport and persisted asset layers. Nothing extracts files, executes scripts, loads assemblies,
// or changes selected source directories. Import/export and projection callers supply the transaction and component semantics.
import { createHash } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";

export class SolutionArchiveError extends Error {
  constructor(message, code = "InvalidArchive") {
    super(message);
    this.name = "SolutionArchiveError";
    this.code = code;
  }
}

export const SOLUTION_ASSET_LIMITS = Object.freeze({ archiveBytes: 128 * 1024 * 1024, entryBytes: 128 * 1024 * 1024, totalBytes: 256 * 1024 * 1024, entries: 10000, layers: 256 });
const fail = (message, code) => { throw new SolutionArchiveError(message, code); };
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const identity = (value) => String(value ?? "").replace(/[{}]/g, "").toLowerCase();
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const limitsOf = (options = {}) => Object.fromEntries(Object.entries(SOLUTION_ASSET_LIMITS).map(([name, ceiling]) => {
  const value = options[name] ?? ceiling;
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) fail(`Invalid solution archive limit ${name}.`, "ArchiveLimit");
  return [name, value];
}));
const bounds = (buffer, offset, count, limit = buffer.length) => {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(count) || offset < 0 || count < 0 || offset + count > limit || limit > buffer.length) fail("Truncated solution archive.");
  return offset;
};
const uint16 = (bytes, offset) => bytes.readUInt16LE(bounds(bytes, offset, 2));
const uint32 = (bytes, offset) => bytes.readUInt32LE(bounds(bytes, offset, 4));
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
export const crc32 = (bytes) => {
  let crc = 0xffffffff;
  for (const value of bytes) crc = crcTable[(crc ^ value) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

/** Normalize ZIP separators only; reject ambiguous/traversing names even though this module never writes paths. */
export function solutionAssetName(input) {
  if (typeof input !== "string" || !input || /[\x00-\x1f\x7f:]/.test(input)) fail("Invalid solution asset path.", "EntryPath");
  const name = input.replaceAll("\\", "/");
  if (name.startsWith("/") || name.length > 4096) fail("Invalid solution asset path.", "EntryPath");
  const segments = name.replace(/\/$/, "").split("/");
  if (segments.some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part))) fail("Invalid solution asset path.", "EntryPath");
  return name;
}
const nameKey = (name) => name.normalize("NFC").toLowerCase();
const decodeName = (bytes) => {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { fail("Unsupported solution asset filename encoding.", "EntryPath"); }
};
function checkedEntries(input, limits) {
  if (!Array.isArray(input) || input.length > limits.entries) fail("Solution archive has too many entries.", "ArchiveLimit");
  const seen = new Set();
  let total = 0;
  return input.map((entry) => {
    const name = solutionAssetName(entry?.name), key = nameKey(name);
    if (seen.has(key)) fail("Duplicate solution asset path.", "EntryPath");
    seen.add(key);
    if (!Buffer.isBuffer(entry.data) && !(entry.data instanceof Uint8Array)) fail("Solution asset content must be bytes.");
    const data = Buffer.from(entry.data);
    total += data.length;
    if (data.length > limits.entryBytes || total > limits.totalBytes) fail("Solution assets exceed the uncompressed size limit.", "ArchiveLimit");
    return { name, data };
  });
}

/**
 * Stored/deflated single-disk ZIP, including data descriptors. Symlinks, encryption and ZIP64 fail explicitly.
 * `include(name)` selects the files to return: every directory and local header is still validated, but only selected
 * entries are inflated and CRC-checked.
 */
export function readSolutionAssetEntries(input, options = {}) {
  const limits = limitsOf(options), include = options.include ?? (() => true);
  if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) fail("Solution archive must be bytes.");
  const bytes = Buffer.from(input);
  if (bytes.length > limits.archiveBytes) fail("Solution archive exceeds the compressed size limit.", "ArchiveLimit");
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (uint32(bytes, offset) === 0x06054b50 && offset + 22 + uint16(bytes, offset + 20) === bytes.length) { end = offset; break; }
  }
  if (end < 0) fail("The solution archive has no ZIP directory.");
  const count = uint16(bytes, end + 10), size = uint32(bytes, end + 12), start = uint32(bytes, end + 16);
  if (uint16(bytes, end + 4) || uint16(bytes, end + 6) || uint16(bytes, end + 8) !== count) fail("Multi-disk solution archives are unsupported.", "UnsupportedArchive");
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) fail("ZIP64 solution archives are unsupported.", "UnsupportedArchive");
  if (count > limits.entries) fail("Solution archive has too many entries.", "ArchiveLimit");
  bounds(bytes, start, size, end);
  if (start + size !== end) fail("The solution ZIP directory size is invalid.");
  const entries = [], names = new Set(), ranges = [];
  let cursor = start, total = 0;
  for (let index = 0; index < count; index++) {
    bounds(bytes, cursor, 46, end);
    if (uint32(bytes, cursor) !== 0x02014b50) fail("Invalid solution ZIP directory entry.");
    const flags = uint16(bytes, cursor + 8), method = uint16(bytes, cursor + 10), crc = uint32(bytes, cursor + 16);
    const packed = uint32(bytes, cursor + 20), unpacked = uint32(bytes, cursor + 24), nameLength = uint16(bytes, cursor + 28);
    const extraLength = uint16(bytes, cursor + 30), commentLength = uint16(bytes, cursor + 32), local = uint32(bytes, cursor + 42);
    if (flags & 0x41) fail("Encrypted solution archives are unsupported.", "UnsupportedArchive");
    if (![0, 8].includes(method)) fail("Unsupported solution ZIP compression method.", "UnsupportedArchive");
    if (packed === 0xffffffff || unpacked === 0xffffffff || local === 0xffffffff || uint16(bytes, cursor + 34)) fail("ZIP64 or split solution entries are unsupported.", "UnsupportedArchive");
    if (unpacked > limits.entryBytes || (total += unpacked) > limits.totalBytes) fail("Solution assets exceed the uncompressed size limit.", "ArchiveLimit");
    bounds(bytes, cursor + 46, nameLength + extraLength + commentLength, end);
    const name = solutionAssetName(decodeName(bytes.subarray(cursor + 46, cursor + 46 + nameLength))), key = nameKey(name);
    if (names.has(key)) fail("Duplicate solution asset path.", "EntryPath");
    names.add(key);
    const mode = uint32(bytes, cursor + 38) >>> 16;
    if ((mode & 0xf000) === 0xa000) fail("Solution archives cannot contain symbolic links.", "EntryPath");
    bounds(bytes, local, 30, start);
    if (uint32(bytes, local) !== 0x04034b50 || uint16(bytes, local + 6) !== flags || uint16(bytes, local + 8) !== method) fail("Solution ZIP local header disagrees with its directory.");
    const localNameLength = uint16(bytes, local + 26), localExtraLength = uint16(bytes, local + 28);
    bounds(bytes, local + 30, localNameLength + localExtraLength, start);
    if (solutionAssetName(decodeName(bytes.subarray(local + 30, local + 30 + localNameLength))) !== name) fail("Solution ZIP local filename disagrees with its directory.");
    if (!(flags & 8) && (uint32(bytes, local + 14) !== crc || uint32(bytes, local + 18) !== packed || uint32(bytes, local + 22) !== unpacked)) fail("Solution ZIP local sizes disagree with its directory.");
    const body = local + 30 + localNameLength + localExtraLength;
    bounds(bytes, body, packed, start);
    const rangeEnd = body + packed;
    if (ranges.some(([left, right]) => local < right && rangeEnd > left)) fail("Overlapping solution ZIP entries.");
    ranges.push([local, rangeEnd]);
    cursor += 46 + nameLength + extraLength + commentLength;
    if (!name.endsWith("/") && !include(name)) continue;
    const compressed = bytes.subarray(body, rangeEnd);
    let data;
    try { data = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: Math.max(1, Math.min(limits.entryBytes, unpacked)) }); }
    catch { fail("Invalid or oversized compressed solution asset."); }
    if (data.length !== unpacked || crc32(data) !== crc) fail("Solution asset size or CRC does not match its directory.");
    if (!name.endsWith("/")) entries.push({ name, data });
    else if (data.length) fail("A solution directory entry contains file data.");
  }
  if (cursor !== end) fail("Trailing or missing solution ZIP directory entries.");
  return entries;
}

/** Deterministic ZIP writer. Opaque bytes are preserved even when the ZIP compression representation changes. */
export function writeSolutionAssetEntries(input, options = {}) {
  const limits = limitsOf(options), entries = checkedEntries(input, limits), localParts = [], centralParts = [];
  let offset = 0;
  for (const { name, data } of entries) {
    if (name.endsWith("/")) fail("The solution ZIP writer accepts files only.", "EntryPath");
    const encodedName = Buffer.from(name, "utf8");
    const candidate = deflateRawSync(data), compressed = candidate.length < data.length ? candidate : data;
    const method = compressed === data ? 0 : 8, crc = crc32(data), local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(method, 8); local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(encodedName.length, 26);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(method, 10); central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(encodedName.length, 28); central.writeUInt32LE(offset, 42);
    localParts.push(local, encodedName, compressed); centralParts.push(central, encodedName);
    offset += local.length + encodedName.length + compressed.length;
    if (offset > limits.archiveBytes) fail("Solution archive exceeds the compressed size limit.", "ArchiveLimit");
  }
  const central = Buffer.concat(centralParts), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  if (offset + central.length + end.length > limits.archiveBytes) fail("Solution archive exceeds the compressed size limit.", "ArchiveLimit");
  return Buffer.concat([...localParts, central, end]);
}

const assetState = (state) => state.dataverse?.solutionAssets ?? { version: 1, sequence: 0, layers: [] };
function checkedState(state) {
  const assets = assetState(state);
  if (assets.version !== 1 || !Number.isSafeInteger(assets.sequence) || assets.sequence < 0 || !Array.isArray(assets.layers)) fail("Unsupported persisted solution asset state.", "AssetState");
  return assets;
}
const ownerId = (value) => {
  const id = identity(value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) fail("A solution asset layer needs a solution id.", "AssetState");
  return id;
};

/** Append an immutable transport layer inside the caller's import transaction. Component projections are separate. */
export function appendSolutionAssetLayer(state, solutionId, input, metadata = {}, options = {}) {
  const limits = limitsOf(options), owner = ownerId(solutionId), assets = checkedState(state);
  if (assets.layers.length >= limits.layers) fail("Too many persisted solution asset layers.", "ArchiveLimit");
  const sequence = assets.sequence + 1;
  const entries = checkedEntries(input, limits).filter((entry) => !entry.name.endsWith("/")).sort((left, right) => compare(left.name, right.name)).map(({ name, data }) => ({ name, bytes: data.length, sha256: hash(data), content: data.toString("base64") }));
  const storedBytes = [...assets.layers.flatMap((layer) => layer.entries), ...entries].reduce((sum, entry) => sum + entry.bytes, 0);
  if (!Number.isSafeInteger(storedBytes) || storedBytes > limits.totalBytes) fail("Persisted solution assets exceed the uncompressed size limit.", "ArchiveLimit");
  const layer = { id: hash(Buffer.from(JSON.stringify([owner, sequence, entries.map((entry) => [entry.name, entry.sha256])]))), ownerSolutionId: owner, sourceSolutionId: owner, sequence,
    uniqueName: String(metadata.uniqueName ?? ""), solutionVersion: String(metadata.version ?? ""), managed: metadata.managed === true, entries };
  // No state change occurs until all names, sizes and content have passed validation.
  (state.dataverse ??= {}).solutionAssets = { version: 1, sequence, layers: [...assets.layers, layer] };
  return layer.id;
}

/** JSON-safe layer snapshots; sourceSolutionId survives patch roll-up as provenance, while ownership can move. */
export function solutionAssetLayers(state, { solutionIds } = {}) {
  const owners = solutionIds ? new Set(solutionIds.map(ownerId)) : null;
  return structuredClone(checkedState(state).layers.filter((layer) => !owners || owners.has(layer.ownerSolutionId)).sort((left, right) => left.sequence - right.sequence));
}

/** Reassign the selected patch layers to a roll-up solution without flattening their XML documents or losing asset identity. */
export function reassignSolutionAssetLayers(state, sourceIds, targetId) {
  const target = ownerId(targetId), sources = new Set(sourceIds.map(ownerId)), assets = checkedState(state);
  (state.dataverse ??= {}).solutionAssets = { ...assets, layers: assets.layers.map((layer) => sources.has(layer.ownerSolutionId) ? { ...layer, ownerSolutionId: target } : layer) };
}

export function removeSolutionAssetLayers(state, solutionIds) {
  const owners = new Set(solutionIds.map(ownerId)), assets = checkedState(state);
  (state.dataverse ??= {}).solutionAssets = { ...assets, layers: assets.layers.filter((layer) => !owners.has(layer.ownerSolutionId)) };
}

/** Byte-level file overlay for one owner. XML component merge must happen in the semantic projection/export adapter. */
export function latestSolutionAssetEntries(state, solutionId) {
  const files = new Map();
  for (const layer of solutionAssetLayers(state, { solutionIds: [solutionId] })) for (const entry of layer.entries) {
    const name = solutionAssetName(entry.name), data = Buffer.from(entry.content, "base64");
    if (data.length !== entry.bytes || hash(data) !== entry.sha256) fail("Persisted solution asset integrity failed.", "AssetState");
    files.set(nameKey(name), { name, data });
  }
  return [...files.values()].sort((left, right) => compare(left.name, right.name));
}
