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
