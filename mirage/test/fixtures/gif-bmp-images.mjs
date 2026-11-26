// Invented GIF and BMP fixtures for the portal GIF/BMP thumbnail tests, and the expected thumbnail of known pixels.
// The writers follow the W3C GIF89a specification (LZW with variable-length codes, interlaced rows) and the Win32
// BITMAPINFOHEADER/BITMAPV4HEADER/BITMAPV5HEADER layouts; they never read real images.
import { PNG } from 'pngjs';
import { encodeJpeg } from '../../lib/portal-jpeg-codec.mjs';
import { pngThumbnail } from '../../lib/portal-png.mjs';

const le16 = (value) => [value & 255, (value >> 8) & 255];

/** GIF LZW codes for `indices`; `deferClear` keeps emitting 12-bit codes once the table is full instead of clearing. */
function lzw(indices, minimum, deferClear) {
  const clear = 1 << minimum;
  const out = [];
  let buffer = 0;
  let bits = 0;
  let size = minimum + 1;
  const emit = (code) => {
    buffer |= code << bits;
    bits += size;
    for (; bits >= 8; bits -= 8, buffer >>>= 8) out.push(buffer & 255);
  };
  let table = new Map();
  let next = clear + 2;
  emit(clear);
  let current = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const key = current * 4096 + indices[i];
    if (table.has(key)) {
      current = table.get(key);
      continue;
    }
    emit(current);
    if (next < 4096) {
      table.set(key, next++);
      if (next > 1 << size && size < 12) size++;
    } else if (!deferClear) {
      emit(clear);
      [table, next, size] = [new Map(), clear + 2, minimum + 1];
    }
    current = indices[i];
  }
  emit(current);
  emit(clear + 1);
  if (bits) out.push(buffer & 255);
  return out;
}

function subBlocks(data) {
  const out = [];
  for (let at = 0; at < data.length; at += 255) out.push(Math.min(255, data.length - at), ...data.slice(at, at + 255));
  return [...out, 0];
}

const interlaceOrder = (height) =>
  [
    [0, 8],
    [4, 8],
    [2, 4],
    [1, 2],
  ].flatMap(([start, step]) => Array.from({ length: Math.ceil(Math.max(0, height - start) / step) }, (_, i) => start + i * step));

function colorTable(palette) {
  const bits = Math.max(1, Math.ceil(Math.log2(palette.length)));
  const table = new Array(3 << bits).fill(0);
  palette.forEach((rgb, i) => table.splice(3 * i, 3, ...rgb));
  return { flags: 0x80 | (bits - 1), table, bits };
}

/**
 * A GIF whose first frame has `pixel(x, y)` palette indices in frame coordinates. Options: `frame` (left, top, width,
 * height on the logical screen), `interlace`, `transparent` (graphic control index), `local` (local instead of global
 * color table), `minimum` (LZW code size), `version` ('87a' or '89a'), `deferClear`, `extensions` (raw bytes before
 * the frame) and `second` (a later frame's palette index, which decoders of the first frame must ignore).
 */
export function gif({ width, height, palette, pixel, frame = {}, ...options }) {
  const { interlace = false, transparent = null, local = false, version = '89a', deferClear = false } = options;
  const box = { left: 0, top: 0, width, height, ...frame };
  const { flags, table, bits } = colorTable(palette);
  const minimum = options.minimum ?? Math.max(2, bits);
  const rows = interlace ? interlaceOrder(box.height) : Array.from({ length: box.height }, (_, y) => y);
  const indices = rows.flatMap((y) => Array.from({ length: box.width }, (_, x) => pixel(x, y)));
  const image = (left, top, w, h, data) => [
    0x2c,
    ...le16(left),
    ...le16(top),
    ...le16(w),
    ...le16(h),
    (local ? flags : 0) | (interlace ? 0x40 : 0),
    ...(local ? table : []),
    minimum,
    ...subBlocks(lzw(data, minimum, deferClear)),
  ];
  const bytes = [
    ...Buffer.from(`GIF${version}`, 'latin1'),
    ...le16(width),
    ...le16(height),
    local ? 0 : flags,
    0,
    0,
    ...(local ? [] : table),
    ...(options.extensions ?? []).flatMap((extension) => [...extension]),
    ...(transparent === null ? [] : [0x21, 0xf9, 4, 1, 0, 0, transparent, 0]),
    ...image(box.left, box.top, box.width, box.height, indices),
    ...(options.second === undefined ? [] : image(0, 0, width, height, new Array(width * height).fill(options.second))),
    0x3b,
  ];
  return Buffer.from(bytes);
}

/** A GIF extension block with the given label and payload in sub-blocks (for example 0xfe, a comment). */
export const gifExtension = (label, payload) => Buffer.from([0x21, label, ...subBlocks([...payload])]);

/**
 * A Windows bitmap. `pixel(x, y)` gives the stored value in display coordinates: a palette index up to 8 bits, an
 * [r, g, b] triple at 24 bits, or the packed integer at 16 and 32 bits. `header` is the info header size (40, 52, 56,
 * 108 or 124), `masks` the bit fields (after a 40-byte header, else inside it), `rle` replaces the pixel rows.
 */
export function bmp({ width, height, depth, header = 40, compression = 0, masks = null, palette = [], ...options }) {
  const { topDown = false, pixel, rle = null, used = 0 } = options;
  const info = Buffer.alloc(header);
  info.writeUInt32LE(header, 0);
  info.writeInt32LE(width, 4);
  info.writeInt32LE(topDown ? -height : height, 8);
  info.writeUInt16LE(1, 12);
  info.writeUInt16LE(depth, 14);
  info.writeUInt32LE(compression, 16);
  info.writeUInt32LE(used, 32);
  if (header > 40) masks?.forEach((mask, i) => info.writeUInt32LE(mask >>> 0, 40 + 4 * i));
  // V4 and V5 headers name sRGB ('sRGB'), so a browser applies no calibration.
  if (header >= 108) info.writeUInt32LE(0x73524742, 56);
  const trailing = Buffer.from(header === 40 && masks ? masks.flatMap((mask) => [...le16(mask & 0xffff), ...le16(mask >>> 16)]) : []);
  const table = Buffer.from(palette.flatMap(([r, g, b]) => [b, g, r, 0]));
  let data = rle ? Buffer.from(rle) : null;
  if (!data) {
    const stride = Math.floor((depth * width + 31) / 32) * 4;
    data = Buffer.alloc(stride * height);
    for (let row = 0; row < height; row++) {
      const y = topDown ? row : height - 1 - row;
      for (let x = 0; x < width; x++) {
        const value = pixel(x, y);
        const at = row * stride + Math.floor((x * depth) / 8);
        if (depth <= 8) data[at] |= value << (8 - depth - ((x * depth) % 8));
        else if (depth === 16) data.writeUInt16LE(value, at);
        else if (depth === 24) data.set([value[2], value[1], value[0]], at);
        else data.writeUInt32LE(value >>> 0, at);
      }
    }
  }
  const offset = 14 + header + trailing.length + table.length;
  const file = Buffer.alloc(14);
  file.write('BM', 0, 'latin1');
  file.writeUInt32LE(offset + data.length, 2);
  file.writeUInt32LE(offset, 10);
  return Buffer.concat([file, info, trailing, table, data]);
}

/** RGBA pixels of `width` x `height` from `color(x, y)` returning [r, g, b, a]. */
export function rgbaImage(width, height, color) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(color(x, y), (y * width + x) * 4);
  return data;
}

/**
 * The expected portal thumbnail of known RGBA pixels: the PNG thumbnail's center crop of the same pixels, alpha
 * composited on white, encoded as baseline JFIF at quality 90.
 */
export function expectedThumbnail(rgba, width, height) {
  const png = new PNG({ width, height });
  png.data.set(rgba);
  const crop = PNG.sync.read(pngThumbnail(PNG.sync.write(png)));
  const rgb = new Uint8Array(crop.width * crop.height * 3);
  for (let i = 0; i < crop.width * crop.height; i++) {
    const alpha = crop.data[i * 4 + 3];
    for (let c = 0; c < 3; c++)
      rgb[i * 3 + c] = Math.round((crop.data[i * 4 + c] * alpha + 255 * (255 - alpha)) / 255);
  }
  return encodeJpeg({ width: crop.width, height: crop.height, channels: 3, data: rgb }, { quality: 90 });
}

export const opaque = (palette, index) => (index < palette.length ? [...palette[index], 255] : [0, 0, 0, 0]);
// 256 invented colours and a pattern that uses all of them, so a wrong index, row or crop changes the thumbnail.
export const PALETTE = Array.from({ length: 256 }, (_, i) => [i, (i * 37) & 255, (i * 101 + 17) & 255]);
export const indexAt = (x, y) => (x * 7 + y * 13 + ((x * y) >> 3)) & 255;
export const patternGif = (width, height, options = {}) =>
  gif({ width, height, palette: PALETTE, pixel: indexAt, ...options });
export const patternRgba = (width, height) => rgbaImage(width, height, (x, y) => opaque(PALETTE, indexAt(x, y)));
export const rgbAt = (x, y) => PALETTE[indexAt(x, y)];
export const patternBmp = (width, height, options = {}) => bmp({ width, height, depth: 24, pixel: rgbAt, ...options });

// Bitmap cases: the stored value of each pixel and the RGBA the decoder must produce from it.
export const SIXTEEN = Array.from({ length: 16 }, (_, i) => [(i * 16 + 7) & 255, (i * 53) & 255, (255 - i * 9) & 255]);
const five = (v) => Math.round((v * 255) / 31);
const six = (v) => Math.round((v * 255) / 63);
export const pick = (x, y, n) => (x * 5 + y * 3 + ((x ^ y) & 1)) % n;
export const BITMAPS = {
  '1-bit bottom-up': { depth: 1, palette: [PALETTE[40], PALETTE[200]], index: (x, y) => pick(x, y, 2) },
  '1-bit top-down': { depth: 1, palette: [PALETTE[3], PALETTE[99]], index: (x, y) => pick(x, y, 2), topDown: true },
  '4-bit bottom-up': { depth: 4, palette: SIXTEEN, index: (x, y) => pick(x, y, 16) },
  '4-bit top-down with 11 colors used': {
    depth: 4,
    palette: SIXTEEN.slice(0, 11),
    used: 11,
    index: (x, y) => pick(x, y, 11),
    topDown: true,
  },
  '8-bit bottom-up': { depth: 8, palette: PALETTE, index: indexAt },
  '8-bit top-down': { depth: 8, palette: PALETTE, index: indexAt, topDown: true },
  '8-bit with indices past a 4-color table': { depth: 8, palette: SIXTEEN.slice(0, 4), used: 4, index: (x, y) => pick(x, y, 8) },
  '16-bit 5-5-5 BI_RGB': {
    depth: 16,
    value: (x, y) => (pick(x, y, 32) << 10) | ((y & 31) << 5) | (x & 31),
    rgba: (x, y) => [five(pick(x, y, 32)), five(y & 31), five(x & 31), 255],
  },
  '16-bit 5-6-5 BI_BITFIELDS top-down': {
    depth: 16,
    compression: 3,
    masks: [0xf800, 0x07e0, 0x001f],
    topDown: true,
    value: (x, y) => (pick(x, y, 32) << 11) | (((x + y) & 63) << 5) | (y & 31),
    rgba: (x, y) => [five(pick(x, y, 32)), six((x + y) & 63), five(y & 31), 255],
  },
  '24-bit top-down': { depth: 24, value: rgbAt, rgba: (x, y) => [...rgbAt(x, y), 255], topDown: true },
  '32-bit BI_RGB with an unused fourth byte': {
    depth: 32,
    value: (x, y) => (rgbAt(x, y)[0] << 16) | (rgbAt(x, y)[1] << 8) | rgbAt(x, y)[2],
    rgba: (x, y) => [...rgbAt(x, y), 255],
  },
  '32-bit BI_RGB after a 40-byte header ignores its fourth byte': {
    depth: 32,
    value: (x, y) => (((x * 11) & 255) << 24) | (rgbAt(x, y)[0] << 16) | (rgbAt(x, y)[1] << 8) | rgbAt(x, y)[2],
    rgba: (x, y) => [...rgbAt(x, y), 255],
  },
  '32-bit V5 BI_RGB with an alpha mask and all-zero alpha samples': {
    depth: 32,
    header: 124,
    masks: [0xff0000, 0xff00, 0xff, 0xff000000],
    value: (x, y) => (rgbAt(x, y)[0] << 16) | (rgbAt(x, y)[1] << 8) | rgbAt(x, y)[2],
    rgba: () => [0, 0, 0, 0],
  },
  '32-bit V5 BI_RGB with an alpha mask and alpha samples': {
    depth: 32,
    header: 124,
    masks: [0xff0000, 0xff00, 0xff, 0xff000000],
    value: (x, y) => ((x % 3 ? 255 : 0) << 24) | (rgbAt(x, y)[0] << 16) | (rgbAt(x, y)[1] << 8) | rgbAt(x, y)[2],
    rgba: (x, y) => [...rgbAt(x, y), x % 3 ? 255 : 0],
  },
  '32-bit V5 BI_BITFIELDS with an alpha mask': {
    depth: 32,
    header: 124,
    compression: 3,
    masks: [0x0000ff00, 0x00ff0000, 0xff000000, 0x000000ff],
    value: (x, y) => (rgbAt(x, y)[2] << 24) | (rgbAt(x, y)[1] << 16) | (rgbAt(x, y)[0] << 8) | ((y * 9 + 40) & 255),
    rgba: (x, y) => [...rgbAt(x, y), (y * 9 + 40) & 255],
  },
  '32-bit BI_ALPHABITFIELDS after a 40-byte header': {
    depth: 32,
    compression: 6,
    masks: [0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000],
    value: (x, y) => ((x & 1 ? 255 : 128) << 24) | (rgbAt(x, y)[0] << 16) | (rgbAt(x, y)[1] << 8) | rgbAt(x, y)[2],
    rgba: (x, y) => [...rgbAt(x, y), x & 1 ? 255 : 128],
  },
  '32-bit V4 BI_BITFIELDS with a zero alpha mask': {
    depth: 32,
    header: 108,
    compression: 3,
    masks: [0x3ff00000, 0x000ffc00, 0x000003ff, 0],
    value: (x, y) => (pick(x, y, 1024) << 20) | (((x * 31) & 1023) << 10) | ((y * 17) & 1023),
    rgba: (x, y) => [pick(x, y, 1024) >> 2, ((x * 31) & 1023) >> 2, ((y * 17) & 1023) >> 2, 255],
  },
};

export const bitmapOf = ({ index, palette, value, ...options }, width, height) =>
  bmp({ width, height, palette: palette ?? [], pixel: index ?? value, ...options });
export const rgbaOf = ({ index, palette, rgba }, width, height) =>
  rgbaImage(width, height, index ? (x, y) => [...(palette[index(x, y)] ?? [0, 0, 0]), 255] : rgba);

// RLE8: an encoded run, an absolute run with padding, a delta, end of line and end of bitmap, from the bottom row.
export const RLE8 = [3, 1, 0, 3, 2, 3, 4, 0, 0, 0, 0, 2, 2, 0, 2, 3, 0, 0, 0, 2, 2, 1, 5, 4, 0, 1];
// RLE4: an encoded run alternating two nibbles, an absolute run of five nibbles, end of line and end of bitmap.
export const RLE4 = [4, 0x12, 0, 5, 0x34, 0x56, 0x70, 0, 0, 0, 7, 0x89, 0, 1];
export const RUN_PALETTE = SIXTEEN.slice(0, 10);
