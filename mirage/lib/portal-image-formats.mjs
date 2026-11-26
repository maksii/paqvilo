// Portal GIF and BMP image-column thumbnails: bounded decoders for the first GIF frame and for Windows bitmaps, the
// documented center crop and a JPEG encoding. Microsoft Learn "Types of columns" (image columns) says uploaded images
// are converted to .jpg and an animated GIF keeps only its first frame; transparent pixels are composited on white.
import { encodeJpeg } from './portal-jpeg-codec.mjs';

const THUMBNAIL_EDGE = 144;
const THUMBNAIL_QUALITY = 90;
// The same decode bounds as portal-png.mjs and portal-jpeg.mjs: larger images keep their original bytes.
const MAX_DIMENSION = 8192;
const MAX_PIXELS = 8 * 1024 * 1024;

const withinBounds = (width, height) =>
  Number.isInteger(width) &&
  Number.isInteger(height) &&
  width >= 1 &&
  height >= 1 &&
  Math.max(width, height) <= MAX_DIMENSION &&
  width * height <= MAX_PIXELS;

/**
 * Center-crops decoded RGBA pixels with the nearest-sample rule of pngThumbnail (portal-png.mjs) and jpegThumbnail
 * (portal-jpeg.mjs), so every format picks the same source pixels, then composites alpha on white for JPEG.
 */
function encodeThumbnail(rgba, width, height, edge) {
  const side = Math.min(width, height);
  const picks = (length) =>
    Array.from({ length: edge }, (_, i) => Math.floor((length - side) / 2 + ((i + 0.5) * side) / edge));
  const columns = picks(width);
  const data = new Uint8Array(edge * edge * 3);
  let at = 0;
  for (const row of picks(height))
    for (const column of columns) {
      const from = (row * width + column) * 4;
      const alpha = rgba[from + 3];
      for (let c = 0; c < 3; c++) data[at++] = Math.round((rgba[from + c] * alpha + 255 * (255 - alpha)) / 255);
    }
  return encodeJpeg({ width: edge, height: edge, channels: 3, data }, { quality: THUMBNAIL_QUALITY });
}

/** The documented thumbnail of an image read by `header` and `decode`; the original bytes when it cannot be made. */
function thumbnail(bytes, header, decode) {
  try {
    const info = header(bytes);
    if (!info) return bytes;
    const { width, height } = info;
    const edge = Math.max(width, height) > THUMBNAIL_EDGE ? THUMBNAIL_EDGE : Math.min(width, height);
    if (width === edge && height === edge) return bytes;
    const rgba = decode(bytes, info);
    return rgba ? encodeThumbnail(rgba, width, height, edge) : bytes;
  } catch {
    return bytes;
  }
}

// GIF87a/GIF89a (W3C GIF89a specification): logical screen, color tables, graphic control extension and LZW frames.

function gifScreen(bytes) {
  const signature = bytes.length >= 13 ? bytes.toString('latin1', 0, 6) : '';
  if (signature !== 'GIF87a' && signature !== 'GIF89a') return null;
  const width = bytes.readUInt16LE(6);
  const height = bytes.readUInt16LE(8);
  return withinBounds(width, height) ? { width, height } : null;
}

/** The offset after a sub-block chain that starts at `offset`; -1 when it runs past the end. */
function skipSubBlocks(bytes, offset) {
  while (offset < bytes.length) {
    const size = bytes[offset++];
    if (size === 0) return offset;
    offset += size;
  }
  return -1;
}

/** A color table of 2^(n+1) RGB entries at `offset`; null when it runs past the end. */
function colorTable(bytes, offset, flags) {
  const end = offset + 3 * (2 << (flags & 7));
  return end <= bytes.length ? bytes.subarray(offset, end) : null;
}

/** Reads least-significant-bit-first codes of a given width; -1 once the data runs out. */
function codeReader(data) {
  let buffer = 0;
  let bits = 0;
  let position = 0;
  return (size) => {
    for (; bits < size; bits += 8) {
      if (position >= data.length) return -1;
      buffer |= data[position++] << bits;
    }
    const code = buffer & ((1 << size) - 1);
    buffer >>>= size;
    bits -= size;
    return code;
  };
}

/** The GIF LZW string table (GIF89a appendix F): at most 4096 entries, so codes are at most 12 bits wide. */
class LzwTable {
  constructor(minimum) {
    this.minimum = minimum;
    this.clear = 1 << minimum;
    this.prefix = new Uint16Array(4096);
    this.suffix = new Uint8Array(4096);
    this.first = new Uint8Array(4096);
    this.lengths = new Uint16Array(4096).fill(1, 0, this.clear);
    for (let code = 0; code < this.clear; code++) this.suffix[code] = this.first[code] = code;
    this.reset();
  }

  reset() {
    this.size = this.minimum + 1;
    this.next = this.clear + 2;
  }

  /** Adds `previous` followed by the first index of `code`; a full table adds nothing (a deferred clear). */
  add(previous, code) {
    if (this.next >= 4096) return;
    const entry = this.next++;
    this.prefix[entry] = previous;
    this.suffix[entry] = this.first[code === entry ? previous : code];
    this.first[entry] = this.first[previous];
    this.lengths[entry] = this.lengths[previous] + 1;
    if (this.next === 1 << this.size && this.size < 12) this.size++;
  }

  /** Writes the indices of `code` at `written`, clipped to `out`; returns the new count. */
  write(code, out, written) {
    let link = code;
    for (let i = this.lengths[code] - 1; i >= 0; i--) {
      if (written + i < out.length) out[written + i] = this.suffix[link];
      link = this.prefix[link];
    }
    return Math.min(out.length, written + this.lengths[code]);
  }
}

/** The palette indices of a frame from its LZW data; null when the codes are malformed or end too soon. */
function lzwIndices(data, minimum, count) {
  const read = codeReader(data);
  const table = new LzwTable(minimum);
  const out = new Uint8Array(count);
  let previous = -1;
  let written = 0;
  while (written < count) {
    const code = read(table.size);
    if (code === table.clear) {
      table.reset();
      previous = -1;
      continue;
    }
    if (code < 0 || code === table.clear + 1) break;
    if (previous === -1 ? code >= table.clear : code > table.next) return null;
    if (previous !== -1) table.add(previous, code);
    written = table.write(code, out, written);
    previous = code;
  }
  return written === count ? out : null;
}

/** The decode-order row of each frame row: four interlace passes (rows 0, 4, 2 and 1 mod 8) or top to bottom. */
function frameRows(height, interlaced) {
  if (!interlaced) return Array.from({ length: height }, (_, y) => y);
  const rows = [];
  for (const [start, step] of [
    [0, 8],
    [4, 8],
    [2, 4],
    [1, 2],
  ])
    for (let y = start; y < height; y += step) rows.push(y);
  return rows;
}

/** The global color table, the last graphic control transparency and the offset of the first image descriptor. */
function gifPrelude(bytes) {
  const palette = bytes[10] & 0x80 ? colorTable(bytes, 13, bytes[10]) : null;
  if (bytes[10] & 0x80 && !palette) return null;
  let offset = 13 + (palette?.length ?? 0);
  let transparent = -1;
  while (bytes[offset] === 0x21) {
    if (bytes[offset + 1] === 0xf9 && bytes[offset + 2] >= 4 && offset + 6 < bytes.length)
      transparent = bytes[offset + 3] & 1 ? bytes[offset + 6] : -1;
    offset = skipSubBlocks(bytes, offset + 2);
    if (offset < 0) return null;
  }
  return bytes[offset] === 0x2c && offset + 11 <= bytes.length ? { palette, transparent, offset } : null;
}

/** The first image descriptor, its color table and its LZW indices; null when malformed or past the bounds. */
function gifFrame(bytes, { palette, offset }) {
  const frame = {
    left: bytes.readUInt16LE(offset + 1),
    top: bytes.readUInt16LE(offset + 3),
    width: bytes.readUInt16LE(offset + 5),
    height: bytes.readUInt16LE(offset + 7),
    interlaced: bytes[offset + 9] & 0x40,
    palette,
  };
  const flags = bytes[offset + 9];
  let at = offset + 10;
  if (!frame.width || !frame.height || frame.width * frame.height > MAX_PIXELS) return null;
  if (flags & 0x80) {
    frame.palette = colorTable(bytes, at, flags);
    at += frame.palette?.length ?? 0;
  }
  const minimum = bytes[at++];
  if (!frame.palette || !(minimum >= 2 && minimum <= 8) || skipSubBlocks(bytes, at) < 0) return null;
  const chunks = [];
  for (; bytes[at]; at += bytes[at] + 1) chunks.push(bytes.subarray(at + 1, at + 1 + bytes[at]));
  frame.indices = lzwIndices(Buffer.concat(chunks), minimum, frame.width * frame.height);
  return frame.indices ? frame : null;
}

/** The first frame drawn on a transparent logical screen; null when the stream is malformed or truncated. */
function decodeGif(bytes, { width, height }) {
  const prelude = gifPrelude(bytes);
  const frame = prelude && gifFrame(bytes, prelude);
  if (!frame) return null;
  const { left, top, palette, indices } = frame;
  const rgba = new Uint8Array(width * height * 4);
  const rows = frameRows(frame.height, frame.interlaced);
  for (let row = 0; row < frame.height; row++) {
    const y = top + rows[row];
    for (let x = 0; x < frame.width && left + x < width && y < height; x++) {
      const index = indices[row * frame.width + x];
      // The transparent index, and an index past the color table, leave the screen transparent.
      if (index === prelude.transparent || 3 * index >= palette.length) continue;
      const at = (y * width + left + x) * 4;
      rgba.set(palette.subarray(3 * index, 3 * index + 3), at);
      rgba[at + 3] = 255;
    }
  }
  return rgba;
}

// Windows bitmaps: BITMAPINFOHEADER and its V2..V5 extensions, BI_RGB, BI_RLE8, BI_RLE4, BI_BITFIELDS and
// BI_ALPHABITFIELDS. OS/2 cores, embedded JPEG/PNG and other compressions keep their original bytes.
const INFO_HEADERS = new Set([40, 52, 56, 108, 124]);
const DEPTHS = {
  0: [1, 4, 8, 16, 24, 32],
  1: [8],
  2: [4],
  3: [16, 32],
  6: [16, 32],
};

function bmpHeader(bytes) {
  if (bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return null;
  const headerSize = bytes.readUInt32LE(14);
  if (!INFO_HEADERS.has(headerSize) || 14 + headerSize > bytes.length) return null;
  const width = bytes.readInt32LE(18);
  const signedHeight = bytes.readInt32LE(22);
  const height = Math.abs(signedHeight);
  const depth = bytes.readUInt16LE(28);
  const compression = bytes.readUInt32LE(30);
  if (!withinBounds(width, height) || !DEPTHS[compression]?.includes(depth)) return null;
  // Run-length bitmaps are bottom-up only.
  if (signedHeight < 0 && (compression === 1 || compression === 2)) return null;
  return { width, height, topDown: signedHeight < 0, headerSize, depth, compression };
}

/** Maps a contiguous bit mask to 8 bits the way Chromium does: the top 8 bits, scaled by round(v * 255 / max). */
function channel(mask, depth) {
  if (!mask) return null;
  const shift = 31 - Math.clz32(mask & -mask);
  const bits = 32 - Math.clz32(mask) - shift;
  if (mask >>> shift !== 2 ** bits - 1 || (depth === 16 && mask > 0xffff)) throw new RangeError('Invalid bit mask.');
  const drop = Math.max(0, bits - 8);
  const max = 2 ** (bits - drop) - 1;
  const table = Uint8Array.from({ length: max + 1 }, (_, value) => Math.round((value * 255) / max));
  return (pixel) => table[(pixel & mask) >>> (shift + drop)];
}

function bitMasks(bytes, { headerSize, depth, compression }) {
  if (compression === 3 || compression === 6) {
    const alpha = compression === 6 || headerSize >= 56 ? bytes.readUInt32LE(66) : 0;
    return [bytes.readUInt32LE(54), bytes.readUInt32LE(58), bytes.readUInt32LE(62), alpha];
  }
  if (depth === 16) return [0x7c00, 0x03e0, 0x001f, 0];
  // 32-bit BI_RGB ignores the fourth byte unless a V3+ header gives an alpha mask (as Chromium decodes it).
  return [0xff0000, 0xff00, 0xff, headerSize >= 56 ? bytes.readUInt32LE(66) : 0];
}

/** Direct-color rows (16, 24 and 32 bits). An alpha mask is applied as it stands, as Chromium does. */
function directPixels(bytes, info, rgba, rowStart) {
  const { width, height, depth } = info;
  const channels = depth === 24 ? null : bitMasks(bytes, info).map((mask) => channel(mask >>> 0, depth));
  const [red, green, blue, alpha] = channels ?? [];
  for (let y = 0; y < height; y++) {
    let at = rowStart(y);
    for (let x = 0, out = y * width * 4; x < width; x++, out += 4) {
      if (depth === 24) {
        rgba[out] = bytes[at + 2];
        rgba[out + 1] = bytes[at + 1];
        rgba[out + 2] = bytes[at];
        rgba[out + 3] = 255;
        at += 3;
        continue;
      }
      const pixel = depth === 16 ? bytes.readUInt16LE(at) : bytes.readUInt32LE(at);
      at += depth / 8;
      rgba[out] = red?.(pixel) ?? 0;
      rgba[out + 1] = green?.(pixel) ?? 0;
      rgba[out + 2] = blue?.(pixel) ?? 0;
      rgba[out + 3] = alpha ? alpha(pixel) : 255;
    }
  }
}

/** The decoded bitmap as RGBA; null when the header, color table or pixel data is malformed or truncated. */
function decodeBmp(bytes, info) {
  const { width, height, topDown, headerSize, depth, compression } = info;
  const dataOffset = bytes.readUInt32LE(10);
  const rgba = new Uint8Array(width * height * 4);
  // Uncompressed rows are padded to 4 bytes.
  const stride = Math.floor((depth * width + 31) / 32) * 4;
  if (compression !== 1 && compression !== 2 && dataOffset + stride * height > bytes.length) return null;
  if (depth > 8) {
    directPixels(bytes, info, rgba, (y) => dataOffset + stride * (topDown ? y : height - 1 - y));
    return rgba;
  }
  // Palettized bitmaps are BI_RGB or run-length coded, so the color table follows the header.
  const paletteStart = 14 + headerSize;
  const used = bytes.readUInt32LE(46);
  const entries = Math.min(used || 2 ** depth, 2 ** depth);
  if (paletteStart + 4 * entries > bytes.length) return null;
  // An index past the color table is black.
  const paint = (x, row, index) => {
    if (x >= width || row >= height) return;
    const at = ((topDown ? row : height - 1 - row) * width + x) * 4;
    if (index < entries) {
      const entry = paletteStart + 4 * index;
      rgba[at] = bytes[entry + 2];
      rgba[at + 1] = bytes[entry + 1];
      rgba[at + 2] = bytes[entry];
    } else rgba.fill(0, at, at + 3);
    rgba[at + 3] = 255;
  };
  if (compression === 0) {
    const perByte = 8 / depth;
    for (let row = 0; row < height; row++)
      for (let x = 0; x < width; x++) {
        const byte = bytes[dataOffset + row * stride + Math.floor(x / perByte)];
        paint(x, row, (byte >> (8 - depth * ((x % perByte) + 1))) & (2 ** depth - 1));
      }
    return rgba;
  }
  // Pixels the runs skip (deltas, early ends of line or bitmap) are opaque black, as Chromium shows them.
  for (let at = 3; at < rgba.length; at += 4) rgba[at] = 255;
  return runLengthPixels(bytes, dataOffset, info, paint) ? rgba : null;
}

/** The palette index of pixel `i` of a run: a whole byte for RLE8, alternating high and low nibbles for RLE4. */
function runIndex(byte, i, depth) {
  if (depth === 8) return byte;
  return i & 1 ? byte & 15 : byte >> 4;
}

/** Escape 0 ends the line, 2 moves by a delta and 3..255 is an absolute run padded to a word; false when truncated. */
function runEscape(bytes, cursor, value, { depth }, paint) {
  if (value === 0) {
    cursor.x = 0;
    cursor.row++;
    return true;
  }
  if (value === 2) {
    if (cursor.at + 2 > bytes.length) return false;
    cursor.x += bytes[cursor.at];
    cursor.row += bytes[cursor.at + 1];
    cursor.at += 2;
    return true;
  }
  const length = depth === 8 ? value : Math.ceil(value / 2);
  if (cursor.at + length > bytes.length) return false;
  for (let i = 0; i < value; i++)
    paint(cursor.x++, cursor.row, runIndex(bytes[cursor.at + (depth === 8 ? i : i >> 1)], i, depth));
  cursor.at += length + (length & 1);
  return true;
}

/** BI_RLE8 and BI_RLE4 runs from the bottom row; false when the data is truncated. */
function runLengthPixels(bytes, offset, info, paint) {
  const cursor = { at: offset, x: 0, row: 0 };
  while (cursor.row < info.height) {
    if (cursor.at + 2 > bytes.length) return false;
    const count = bytes[cursor.at];
    const value = bytes[cursor.at + 1];
    cursor.at += 2;
    if (count) for (let i = 0; i < count; i++) paint(cursor.x++, cursor.row, runIndex(value, i, info.depth));
    else if (value === 1) return true;
    else if (!runEscape(bytes, cursor, value, info, paint)) return false;
  }
  return true;
}

/**
 * The portal thumbnail of a GIF: the first frame on its logical screen, center-cropped by the documented rule (a side
 * over 144 px gives 144x144, otherwise a square of the shorter side) and encoded as baseline JFIF at quality 90.
 * An image that already is its thumbnail, a malformed, truncated or oversized stream keeps its original bytes.
 */
export function gifThumbnail(bytes) {
  return thumbnail(bytes, gifScreen, decodeGif);
}

/** The portal thumbnail of a Windows bitmap, by the same rule and encoding as gifThumbnail. */
export function bmpThumbnail(bytes) {
  return thumbnail(bytes, bmpHeader, decodeBmp);
}
