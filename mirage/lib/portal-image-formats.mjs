// Portal GIF and BMP image-column thumbnails: the bounded decoders of portal-image-decoders.mjs, the center crop shared
// with PNG and JPEG, and encoders that keep the source format. Hosted session F2 (thumbs runs a and b)
// served a 200x120 GIF as a 120x120 GIF89a and a 160x100 24-bit BMP as a 100x100 32-bit BMP; the GIF used the 6x7x6
// halftone color table (red outer, then green, then blue, four black entries after the 252 colors) with a graphic
// control extension that declares a transparent index, and the bitmap was bottom-up BI_RGB with the alpha byte set and
// 0x0Exx pixels per meter (the low byte did not survive the capture; 3779, the PNG thumbnail's 96 dpi, is used).

import { decodeBmpImage, decodeGifImage } from './portal-image-decoders.mjs';

const THUMBNAIL_EDGE = 144;

/**
 * Center-crops decoded RGBA pixels to edge x edge with the nearest-sample rule of pngThumbnail (portal-png.mjs) and
 * jpegThumbnail (portal-jpeg.mjs), so every format picks the same source pixels.
 */
function cropRgba(rgba, width, height, edge) {
  const side = Math.min(width, height);
  const picks = (length) =>
    Array.from({ length: edge }, (_, i) => Math.floor((length - side) / 2 + ((i + 0.5) * side) / edge));
  const columns = picks(width);
  const out = new Uint8Array(edge * edge * 4);
  let at = 0;
  for (const row of picks(height))
    for (const column of columns) {
      out.set(rgba.subarray((row * width + column) * 4, (row * width + column) * 4 + 4), at);
      at += 4;
    }
  return out;
}

// The halftone table levels: six for red and blue, seven for green; index = red * 42 + green * 6 + blue.
const SIX = [0x00, 0x33, 0x66, 0x99, 0xcc, 0xff];
const SEVEN = [0x00, 0x2b, 0x55, 0x80, 0xaa, 0xd5, 0xff];
const HALFTONE = (() => {
  const table = new Uint8Array(256 * 3);
  let at = 0;
  for (const red of SIX) for (const green of SEVEN) for (const blue of SIX) table.set([red, green, blue], at++ * 3);
  return table;
})();
// The capture shows the transparency flag set and an index of 128 or more (the byte did not survive the capture's text
// form); the last, unused black entry is Mirage's choice.
const TRANSPARENT_INDEX = 255;

/** The nearest halftone entry of each pixel; a pixel under half opacity takes the transparent index. */
function halftoneIndices(rgba) {
  const indices = new Uint8Array(rgba.length / 4);
  for (let i = 0; i < indices.length; i++) {
    const at = i * 4;
    indices[i] =
      rgba[at + 3] < 128
        ? TRANSPARENT_INDEX
        : Math.round(rgba[at] / 51) * 42 + Math.round((rgba[at + 1] * 6) / 255) * 6 + Math.round(rgba[at + 2] / 51);
  }
  return indices;
}

/** GIF LZW (GIF89a appendix F) of 8-bit indices: a clear code first and whenever the 4096-entry table fills. */
function lzw(indices) {
  const clear = 256;
  const out = [];
  let buffer = 0;
  let bits = 0;
  const emit = (code, size) => {
    buffer |= code << bits;
    bits += size;
    while (bits >= 8) {
      out.push(buffer & 0xff);
      buffer >>>= 8;
      bits -= 8;
    }
  };
  let table = new Map();
  let next = clear + 2;
  let size = 9;
  emit(clear, size);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const key = (prefix << 8) | indices[i];
    const known = table.get(key);
    if (known !== undefined) {
      prefix = known;
      continue;
    }
    emit(prefix, size);
    if (next < 4096) {
      table.set(key, next++);
      if (next > 1 << size && size < 12) size++;
    } else {
      emit(clear, size);
      table = new Map();
      next = clear + 2;
      size = 9;
    }
    prefix = indices[i];
  }
  emit(prefix, size);
  emit(clear + 1, size);
  if (bits) out.push(buffer & 0xff);
  return Buffer.from(out);
}

/** A single-frame GIF89a of edge x edge RGBA pixels on the halftone table. */
function encodeGif(rgba, edge) {
  const data = lzw(halftoneIndices(rgba));
  const blocks = [];
  for (let at = 0; at < data.length; at += 255) {
    const chunk = data.subarray(at, at + 255);
    blocks.push(Buffer.from([chunk.length]), chunk);
  }
  const header = Buffer.alloc(13);
  header.write('GIF89a', 0, 'latin1');
  header.writeUInt16LE(edge, 6);
  header.writeUInt16LE(edge, 8);
  // Global color table of 256 entries, color resolution 8 bits.
  header[10] = 0xf7;
  const control = Buffer.from([0x21, 0xf9, 4, 1, 0, 0, TRANSPARENT_INDEX, 0]);
  const descriptor = Buffer.alloc(10);
  descriptor[0] = 0x2c;
  descriptor.writeUInt16LE(edge, 5);
  descriptor.writeUInt16LE(edge, 7);
  return Buffer.concat([
    header,
    Buffer.from(HALFTONE),
    control,
    descriptor,
    Buffer.from([8]),
    ...blocks,
    Buffer.from([0, 0x3b]),
  ]);
}

/** A bottom-up 32-bit BI_RGB bitmap (BITMAPINFOHEADER, 96 dpi as 3779 pixels per meter) of edge x edge RGBA pixels. */
function encodeBmp(rgba, edge) {
  const header = Buffer.alloc(54);
  const size = 54 + edge * edge * 4;
  header.write('BM', 0, 'latin1');
  header.writeUInt32LE(size, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(edge, 18);
  header.writeInt32LE(edge, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(32, 28);
  header.writeInt32LE(3779, 38);
  header.writeInt32LE(3779, 42);
  const pixels = Buffer.alloc(edge * edge * 4);
  for (let y = 0; y < edge; y++)
    for (let x = 0; x < edge; x++) {
      const from = (y * edge + x) * 4;
      const to = ((edge - 1 - y) * edge + x) * 4;
      pixels[to] = rgba[from + 2];
      pixels[to + 1] = rgba[from + 1];
      pixels[to + 2] = rgba[from];
      pixels[to + 3] = rgba[from + 3];
    }
  return Buffer.concat([header, pixels]);
}

/**
 * The thumbnail of an image read by `decodeImage`, encoded by `encode`: a square of the shorter side, at most
 * 144 px (hosted session F2: 200x120 -> 120x120, 160x100 -> 100x100); the original bytes when it cannot be made.
 */
function thumbnail(bytes, decodeImage, encode) {
  try {
    const image = decodeImage(bytes);
    if (!image) return bytes;
    const { width, height, rgba } = image;
    // An image that already is its thumbnail is re-encoded too, so no thumbnail carries the source's metadata.
    const edge = Math.min(THUMBNAIL_EDGE, width, height);
    return encode(cropRgba(rgba, width, height, edge), edge);
  } catch {
    return bytes;
  }
}

/**
 * The portal thumbnail of a GIF: the first frame on its logical screen, center-cropped to a square of the shorter side
 * (at most 144 px) and encoded as a GIF89a on the halftone color table, also when it already is that square. A
 * malformed, truncated or oversized stream keeps its original bytes.
 */
export function gifThumbnail(bytes) {
  return thumbnail(bytes, decodeGifImage, encodeGif);
}

/** The portal thumbnail of a Windows bitmap, by the same crop as gifThumbnail, encoded as a 32-bit bitmap. */
export function bmpThumbnail(bytes) {
  return thumbnail(bytes, decodeBmpImage, encodeBmp);
}
