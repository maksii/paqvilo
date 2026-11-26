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

/** Drops a PNG's eXIf chunk while keeping the encoded image and other chunks byte-for-byte. */
export function stripPngExif(bytes) {
  const kept = [];
  let last = 0;
  const valid = walkChunks(bytes, (type, offset, end) => {
    if (type === 'eXIf') {
      kept.push(bytes.subarray(last, offset));
      last = end;
    }
  });
  return valid && last ? Buffer.concat([...kept, bytes.subarray(last)]) : bytes;
}

/** Center-crops PNG pixels for portal reads. Legacy malformed or unusually large images retain their original bytes. */
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
  const edge = Math.max(width, height) > THUMBNAIL_EDGE ? THUMBNAIL_EDGE : side;
  if ((width === edge && height === edge) || !walkChunks(bytes)) return bytes;

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
    return PNG.sync.write(target);
  } catch {
    return bytes;
  }
}
