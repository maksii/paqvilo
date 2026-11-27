import { crc32 } from 'node:zlib';
import { PNG } from 'pngjs';

const SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const THUMBNAIL_EDGE = 144;
const MAX_DECODE_PIXELS = 8 * 1024 * 1024;
const MAX_DECODE_DIMENSION = 8192;

const isPng = (bytes) => bytes.subarray(0, SIGNATURE.length).equals(SIGNATURE);

// Validate the chunk framing independently of the decoder. In particular, a second header must not change its limits.
function walkChunks(bytes, visit) {
  if (!isPng(bytes)) return false;
  for (let offset = SIGNATURE.length; offset <= bytes.length - 12;) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return false;
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if ((type === 'IHDR') !== (offset === SIGNATURE.length) || (type === 'IHDR' && length !== 13)) return false;
    if (type === 'IEND') return length === 0;
    visit?.(type, offset, end);
    offset = end;
  }
  return false;
}

// The ancillary chunks of a hosted thumbnail (session F2, thumbs runs a and b): sRGB perceptual, gAMA 1/2.2 (45455) and
// pHYs 3779 x 3779 pixels per meter (96 dpi; the captured chunk CRC fixes the value), between IHDR and IDAT.
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};
const PHYS = Buffer.alloc(9);
PHYS.writeUInt32BE(3779, 0);
PHYS.writeUInt32BE(3779, 4);
PHYS[8] = 1;
const GAMA = Buffer.alloc(4);
GAMA.writeUInt32BE(45455);
const ANCILLARY = Buffer.concat([chunk('sRGB', Buffer.from([0])), chunk('gAMA', GAMA), chunk('pHYs', PHYS)]);
const IHDR_END = SIGNATURE.length + 25;

/**
 * Center-crops PNG pixels for portal reads to a square of the shorter side, at most 144 px (hosted session F2: 300x428
 * -> 144x144, 91x130 -> 91x91; session F1: 300x100 -> 100x100), encoded as 8-bit RGBA with the hosted ancillary chunks.
 * Legacy malformed or unusually large images retain their original bytes.
 */
export function pngThumbnail(bytes) {
  if (bytes.length < 33 || !isPng(bytes) || bytes.toString('ascii', 12, 16) !== 'IHDR') return bytes;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  // The installed PNG codec bounds decompression for non-interlaced streams only.
  if (
    !width ||
    !height ||
    Math.max(width, height) > MAX_DECODE_DIMENSION ||
    width * height > MAX_DECODE_PIXELS ||
    bytes[28] !== 0
  )
    return bytes;
  const side = Math.min(width, height);
  const edge = Math.min(THUMBNAIL_EDGE, side);
  // A PNG that already is its thumbnail is re-encoded too, so no thumbnail carries eXIf or other ancillary metadata.
  if (!walkChunks(bytes)) return bytes;

  try {
    const source = PNG.sync.read(bytes);
    const target = new PNG({ width: edge, height: edge });
    const insetX = (width - side) / 2;
    const insetY = (height - side) / 2;
    for (let y = 0; y < edge; y++) {
      const sourceY = Math.floor(insetY + ((y + 0.5) * side) / edge);
      for (let x = 0; x < edge; x++) {
        const sourceX = Math.floor(insetX + ((x + 0.5) * side) / edge);
        const start = (sourceY * width + sourceX) * 4;
        source.data.copy(target.data, (y * edge + x) * 4, start, start + 4);
      }
    }
    const encoded = PNG.sync.write(target, { colorType: 6 });
    return Buffer.concat([encoded.subarray(0, IHDR_END), ANCILLARY, encoded.subarray(IHDR_END)]);
  } catch {
    return bytes;
  }
}
