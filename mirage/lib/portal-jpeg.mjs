import { decodeJpeg, encodeJpeg, jpegFrame } from './portal-jpeg-codec.mjs';

// CIPA Exif uses an APP1 segment identified by "Exif\0\0" before the JPEG scan.
const EXIF = Buffer.from('457869660000', 'hex');

function jpegSegment(bytes, start) {
  if (bytes[start] !== 0xff) return null;
  let offset = start + 1;
  while (bytes[offset] === 0xff) offset++;
  const marker = bytes[offset++];
  if (marker === 0xd9 || marker === 0x01) return { marker, end: offset };
  if (offset + 2 > bytes.length || marker < 0xc0 || (marker >= 0xd0 && marker <= 0xd8)) return null;
  const length = bytes.readUInt16BE(offset);
  const end = offset + length;
  if (length < 2 || end > bytes.length) return null;
  return { marker, start: offset + 2, end };
}

/** Remove Exif APP1 from JPEG headers without changing encoded pixels or other application segments. */
export function stripJpegExif(bytes) {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) return bytes;
  let cleaned = null;
  let written = 0;
  let keepFrom = 0;
  for (let offset = 2; offset < bytes.length;) {
    const segment = jpegSegment(bytes, offset);
    if (!segment) return bytes;
    if (segment.marker === 0xda || segment.marker === 0xd9) {
      if (!cleaned) return bytes;
      return cleaned.subarray(0, written + bytes.copy(cleaned, written, keepFrom));
    }
    if (
      segment.marker === 0xe1 &&
      segment.end - segment.start >= EXIF.length &&
      bytes.subarray(segment.start, segment.start + EXIF.length).equals(EXIF)
    ) {
      cleaned ??= Buffer.allocUnsafe(bytes.length);
      written += bytes.copy(cleaned, written, keepFrom, offset);
      keepFrom = segment.end;
    }
    offset = segment.end;
  }
  return bytes;
}

const THUMBNAIL_EDGE = 144;
const THUMBNAIL_QUALITY = 90;
// The same decode bounds as portal-png.mjs: larger frames keep their original bytes.
const DECODE_LIMITS = Object.freeze({ maxPixels: 8 * 1024 * 1024, maxDimension: 8192 });
const ADOBE = 0xee;
const SOI_AND_JFIF = 20;

const isExif = (bytes, segment) =>
  segment.marker === 0xe1 &&
  segment.end - segment.start >= EXIF.length &&
  bytes.subarray(segment.start, segment.start + EXIF.length).equals(EXIF);

/** The header segments before the first scan; null when the framing is malformed. */
function headerSegments(bytes) {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) return null;
  const segments = [];
  for (let offset = 2; offset < bytes.length;) {
    const segment = jpegSegment(bytes, offset);
    if (!segment) return null;
    if (segment.marker === 0xda || segment.marker === 0xd9) return segments;
    segments.push({ ...segment, offset });
    offset = segment.end;
  }
  return null;
}

// TIFF (Exif 2.3) IFD0 Orientation, tag 0x0112 SHORT: 1 is upright, 2..8 mirror and rotate.
function tiffOrientation(tiff) {
  const order = tiff.length >= 8 ? tiff.toString('latin1', 0, 2) : '';
  if (order !== 'II' && order !== 'MM') return 1;
  const little = order === 'II';
  const short = (at) => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const ifd = little ? tiff.readUInt32LE(4) : tiff.readUInt32BE(4);
  if (short(2) !== 42 || ifd + 2 > tiff.length) return 1;
  const end = Math.min(tiff.length, ifd + 2 + 12 * short(ifd));
  let entry = ifd + 2;
  while (entry + 12 <= end && short(entry) !== 0x0112) entry += 12;
  const value = entry + 12 <= end && short(entry + 2) === 3 ? short(entry + 8) : 1;
  return value >= 1 && value <= 8 ? value : 1;
}

/** The Exif orientation of a JPEG (1..8); 1 without a readable Exif APP1. */
function jpegOrientation(bytes) {
  const exif = headerSegments(bytes)?.find((segment) => isExif(bytes, segment));
  return exif ? tiffOrientation(bytes.subarray(exif.start + EXIF.length, exif.end)) : 1;
}

// Source pixel of each output pixel: sourceX = x0 + xX * x + xY * y, sourceY = y0 + yX * x + yY * y.
const ORIENTATIONS = {
  2: (w) => [w - 1, -1, 0, 0, 0, 1],
  3: (w, h) => [w - 1, -1, 0, h - 1, 0, -1],
  4: (w, h) => [0, 1, 0, h - 1, 0, -1],
  5: () => [0, 0, 1, 0, 1, 0],
  6: (w, h) => [0, 0, 1, h - 1, -1, 0],
  7: (w, h) => [w - 1, 0, -1, h - 1, -1, 0],
  8: (w) => [w - 1, 0, -1, 0, 1, 0],
};

/** Applies an Exif orientation to decoded samples, so the result displays upright without the Exif tag. */
function orient(image, orientation) {
  const transform = ORIENTATIONS[orientation];
  if (!transform) return image;
  const { width, height, channels, data } = image;
  const swap = orientation >= 5;
  const [outWidth, outHeight] = swap ? [height, width] : [width, height];
  const [x0, xX, xY, y0, yX, yY] = transform(width, height);
  const out = new Uint8Array(data.length);
  for (let y = 0, at = 0; y < outHeight; y++)
    for (let x = 0; x < outWidth; x++, at += channels) {
      const from = ((y0 + yX * x + yY * y) * width + x0 + xX * x + xY * y) * channels;
      for (let c = 0; c < channels; c++) out[at + c] = data[from + c];
    }
  const sampling = swap && image.sampling ? { h: image.sampling.v, v: image.sampling.h } : image.sampling;
  return { ...image, width: outWidth, height: outHeight, data: out, sampling };
}

/**
 * Re-encodes a JPEG whose Exif orientation is 2..8 with upright pixels, so removing its Exif keeps what a browser
 * shows. The source quantization tables and chroma sampling are reused, and other APPn and comment segments are kept
 * (not APP0, Exif or Adobe APP14). Other images, and any the codec cannot decode within bounds, keep their bytes.
 */
export function orientJpeg(bytes) {
  const orientation = jpegOrientation(bytes);
  if (orientation === 1) return bytes;
  const image = decodeJpeg(bytes, DECODE_LIMITS);
  if (!image) return bytes;
  try {
    const encoded = encodeJpeg(orient(image, orientation), {
      quantTables: image.quantTables,
      sampling: image.sampling ?? { h: 2, v: 2 },
    });
    const kept = headerSegments(bytes)
      .filter(
        (s) => (s.marker > 0xe0 && s.marker <= 0xef && s.marker !== ADOBE && !isExif(bytes, s)) || s.marker === 0xfe,
      )
      .map((s) => bytes.subarray(s.offset, s.end));
    return Buffer.concat([encoded.subarray(0, SOI_AND_JFIF), ...kept, encoded.subarray(SOI_AND_JFIF)]);
  } catch {
    return bytes;
  }
}

// Nearest-sample center crop, the same sampling as pngThumbnail in portal-png.mjs.
function centerCrop({ width, height, channels, data }, edge) {
  const side = Math.min(width, height);
  const insetX = (width - side) / 2;
  const insetY = (height - side) / 2;
  const out = new Uint8Array(edge * edge * channels);
  for (let y = 0; y < edge; y++) {
    const sourceY = Math.floor(insetY + ((y + 0.5) * side) / edge);
    for (let x = 0; x < edge; x++) {
      const start = (sourceY * width + Math.floor(insetX + ((x + 0.5) * side) / edge)) * channels;
      out.set(data.subarray(start, start + channels), (y * edge + x) * channels);
    }
  }
  return { width: edge, height: edge, channels, data: out };
}

/**
 * Center-crops JPEG pixels for portal reads with the documented thumbnail rule: a side over 144 px gives 144x144,
 * otherwise a square of the shorter side; a 144x144 image keeps its bytes. The thumbnail is a baseline JFIF JPEG
 * (quality 90, 4:2:0, or one component for grayscale) shown upright for an Exif orientation. Unsupported processes,
 * malformed streams and frames past the decode bounds keep their original bytes.
 */
export function jpegThumbnail(bytes) {
  const frame = jpegFrame(bytes, DECODE_LIMITS);
  if (!frame) return bytes;
  const { width, height } = frame;
  const edge = Math.max(width, height) > THUMBNAIL_EDGE ? THUMBNAIL_EDGE : Math.min(width, height);
  if (width === edge && height === edge) return bytes;
  const image = decodeJpeg(bytes, DECODE_LIMITS);
  if (!image) return bytes;
  try {
    return encodeJpeg(orient(centerCrop(image, edge), jpegOrientation(bytes)), { quality: THUMBNAIL_QUALITY });
  } catch {
    return bytes;
  }
}
