// Portal JPEG image thumbnails: the bounded baseline codec (portal-jpeg-codec.mjs), the documented thumbnail crop
// (portal-jpeg.mjs jpegThumbnail), the Exif orientation model and the portal image route end to end.
// Fixtures are invented pixels encoded by the codec under test; the Chromium oracle check lives in
// mirage/test-browser/portal-jpeg-decode.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { decodeJpeg, encodeJpeg, jpegFrame } from '../lib/portal-jpeg-codec.mjs';
import { jpegThumbnail } from '../lib/portal-jpeg.mjs';
import { pngThumbnail } from '../lib/portal-png.mjs';
import { PROGRESSIVE_PAIRS } from './fixtures/progressive-jpeg.mjs';
import { createSimulator } from '../server.mjs';
import { signInHeaders } from '../testing/session.mjs';
import { ownedFixture, ownedClose, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const BLUE = [20, 40, 220];
const RED = [230, 20, 20];

function image(width, height, channels, color) {
  const data = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) data.set(color(x, y).slice(0, channels), (y * width + x) * channels);
  return { width, height, channels, data };
}

// A smooth invented gradient: JPEG reproduces it closely at any sampling.
const smooth = (width, height, channels = 3) =>
  image(width, height, channels, (x, y) => [
    Math.round(60 + (140 * x) / width),
    Math.round(200 - (120 * y) / height),
    Math.round(90 + 60 * Math.sin((x + y) / 40)),
  ]);

// Red bands outside the centered square, blue inside: a center crop sees blue at every corner. The red starts a few
// pixels outside the square so JPEG chroma subsampling and ringing at the band edge do not reach the crop.
const banded = (width, height) => {
  const side = Math.min(width, height);
  const insetX = (width - side) / 2 - 4;
  const insetY = (height - side) / 2 - 4;
  return image(width, height, 3, (x, y) =>
    x < insetX || x >= width - insetX || y < insetY || y >= height - insetY ? RED : BLUE,
  );
};

function difference(a, b) {
  assert.equal(a.length, b.length);
  let max = 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const delta = Math.abs(a[i] - b[i]);
    max = Math.max(max, delta);
    sum += delta;
  }
  return { max, mean: sum / a.length };
}

const near = (actual, expected, tolerance, label) =>
  assert.ok(
    actual.every((value, i) => Math.abs(value - expected[i]) <= tolerance),
    `${label}: ${actual} is not within ${tolerance} of ${expected}`,
  );
const pixel = (decoded, x, y) => [
  ...decoded.data.subarray((y * decoded.width + x) * decoded.channels, (y * decoded.width + x + 1) * decoded.channels),
];

/** The marker segments of a JPEG header and its scan, as { marker, offset, end } (end of the length-counted part). */
function segments(bytes) {
  const found = [];
  for (let offset = 2; offset < bytes.length;) {
    const marker = bytes[offset + 1];
    if (marker === 0xd9) break;
    const end = offset + 2 + bytes.readUInt16BE(offset + 2);
    found.push({ marker, offset, end });
    if (marker === 0xda) break;
    offset = end;
  }
  return found;
}

/** Replaces the payload of the first segment with marker (or every one, when all) and fixes its length. */
function rewrite(bytes, marker, change, { all = false } = {}) {
  const parts = [];
  let last = 0;
  for (const segment of segments(bytes)
    .filter((s) => s.marker === marker)
    .slice(0, all ? undefined : 1)) {
    const payload = change(Buffer.from(bytes.subarray(segment.offset + 4, segment.end)));
    const header = Buffer.from([0xff, payload.marker ?? marker, 0, 0]);
    header.writeUInt16BE((payload.bytes ?? payload).length + 2, 2);
    parts.push(bytes.subarray(last, segment.offset), header, payload.bytes ?? payload);
    last = segment.end;
  }
  return Buffer.concat([...parts, bytes.subarray(last)]);
}

/** Joins every segment with marker into one segment carrying all their tables, placed where the first one was. */
function mergeSegments(bytes, marker) {
  const matching = segments(bytes).filter((s) => s.marker === marker);
  const payload = Buffer.concat(matching.map((s) => bytes.subarray(s.offset + 4, s.end)));
  const header = Buffer.from([0xff, marker, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 2);
  const parts = [bytes.subarray(0, matching[0].offset), header, payload];
  for (let i = 0; i < matching.length; i++)
    parts.push(bytes.subarray(matching[i].end, matching[i + 1]?.offset ?? bytes.length));
  return Buffer.concat(parts);
}

function insertAfterSoi(bytes, ...inserted) {
  return Buffer.concat([bytes.subarray(0, 2), ...inserted, bytes.subarray(2)]);
}

function app(marker, payload) {
  const header = Buffer.from([0xff, marker, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

// A minimal Exif APP1 whose IFD0 holds one Orientation entry (tag 0x0112, SHORT, count 1).
function exifOrientation(value, { bigEndian = false } = {}) {
  const tiff = Buffer.alloc(26);
  const short = (v, at) => (bigEndian ? tiff.writeUInt16BE(v, at) : tiff.writeUInt16LE(v, at));
  const long = (v, at) => (bigEndian ? tiff.writeUInt32BE(v, at) : tiff.writeUInt32LE(v, at));
  tiff.write(bigEndian ? 'MM' : 'II', 0, 'ascii');
  short(42, 2);
  long(8, 4);
  short(1, 8);
  short(0x0112, 10);
  short(3, 12);
  long(1, 14);
  short(value, 18);
  return app(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]));
}

const ADOBE_RGB = app(0xee, Buffer.from([0x41, 0x64, 0x6f, 0x62, 0x65, 0, 100, 0, 0, 0, 0, 0]));
const xmp = app(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0invented-fixture', 'utf8'));
const comment = app(0xfe, Buffer.from('invented comment', 'utf8'));

// @test-kind observation: hosted sessions F2 thumbs (runs a and b: 400x200 and 400x300 JPEG -> 144x144, 300x428 PNG -> 144x144, 91x130 PNG -> 91x91, 200x120 GIF -> 120x120, 160x100 BMP -> 100x100) and F1 files (runs a and b: 300x100 PNG -> 100x100): a square of the shorter side, at most 144 px
test('JPEG thumbnails are a centered square of the shorter side, at most 144 px', () => {
  for (const [width, height, edge] of [
    [300, 428, 144],
    [91, 130, 91],
    [100, 300, 100],
    [200, 120, 120],
    [143, 40, 40],
  ]) {
    const bytes = encodeJpeg(banded(width, height));
    const thumbnail = decodeJpeg(jpegThumbnail(bytes));
    assert.deepEqual([thumbnail.width, thumbnail.height], [edge, edge], `${width}x${height}`);
    for (const [x, y] of [
      [0, 0],
      [edge - 1, 0],
      [0, edge - 1],
      [edge - 1, edge - 1],
      [edge >> 1, edge >> 1],
    ])
      near(pixel(thumbnail, x, y), BLUE, 24, `${width}x${height} at ${x},${y}`);
  }
  // A 144x144 image is re-encoded too, so an Exif segment (GPS position, camera) never reaches its thumbnail.
  const square = encodeJpeg(smooth(144, 144));
  const exif = Buffer.from('45786966000049492a0008000000000000000000', 'hex');
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0, exif.length + 2]), exif]);
  const tagged = Buffer.concat([square.subarray(0, 2), app1, square.subarray(2)]);
  const squareThumbnail = jpegThumbnail(tagged);
  assert.notDeepEqual(squareThumbnail, tagged, 'a 144x144 image is re-encoded');
  assert.ok(!squareThumbnail.includes(Buffer.from('Exif')), 'the thumbnail carries no Exif');
  const decoded = decodeJpeg(squareThumbnail);
  assert.deepEqual([decoded.width, decoded.height], [144, 144]);
});

// @test-kind compatibility: Microsoft Learn "Use image column data", resize rules for thumbnail-sized images; PNG and JPEG thumbnails must sample the same source pixels
test('PNG and JPEG thumbnails of the same pixels sample the same centered square', () => {
  for (const [width, height] of [
    [300, 428],
    [91, 130],
  ]) {
    const jpeg = encodeJpeg(smooth(width, height), { quality: 98, sampling: { h: 1, v: 1 } });
    const source = decodeJpeg(jpeg);
    const png = new PNG({ width, height });
    for (let i = 0; i < width * height; i++) png.data.set([...source.data.subarray(i * 3, i * 3 + 3), 255], i * 4);
    const fromPng = PNG.sync.read(pngThumbnail(PNG.sync.write(png)));
    const fromJpeg = decodeJpeg(jpegThumbnail(jpeg));
    assert.deepEqual([fromJpeg.width, fromJpeg.height], [fromPng.width, fromPng.height]);
    const rgb = new Uint8Array(fromPng.width * fromPng.height * 3);
    for (let i = 0; i < rgb.length / 3; i++) rgb.set(fromPng.data.subarray(i * 4, i * 4 + 3), i * 3);
    const { max, mean } = difference(fromJpeg.data, rgb);
    assert.ok(max <= 24 && mean <= 2, `thumbnail re-encoding error max ${max}, mean ${mean}`);
  }
});

// @test-kind observation: the hosted JPEG thumbnail headers (session F1 files runs a and b, image:thumbnail, compared byte for byte; session F2 thumbs runs a and b list the same markers) are JFIF 1.1 at 96 dpi, the IJG quality 75 tables, SOF0 4:2:0 and four DHT segments; the grayscale thumbnail is a local choice without a capture
test('JPEG thumbnails carry the hosted JFIF header, quality 75 tables, 4:2:0 baseline frame and Huffman tables', () => {
  const color = jpegThumbnail(encodeJpeg(smooth(300, 200)));
  const all = segments(color);
  const bytesOf = (s) => color.subarray(s.offset, s.end).toString('hex');
  assert.deepEqual(
    all.map((s) => s.marker),
    [0xe0, 0xdb, 0xdb, 0xc0, 0xc4, 0xc4, 0xc4, 0xc4, 0xda],
  );
  assert.equal(bytesOf(all[8]), 'ffda000c03010002110311003f00');
  assert.equal(bytesOf(all[0]), 'ffe000104a46494600010101006000600000');
  // IJG quality 75: the Annex K luminance entries 16, 11, 12, 14 become 8, 6, 6, 7; chrominance 17, 18 become 9, 9.
  assert.equal(bytesOf(all[1]).slice(0, 18), 'ffdb00430008060607');
  assert.equal(bytesOf(all[2]).slice(0, 18), 'ffdb0043010909090c');
  assert.equal(bytesOf(all[3]), 'ffc00011080090009003012200021101031101');
  assert.deepEqual(
    all.slice(4, 8).map((s) => bytesOf(s).slice(0, 12)),
    ['ffc4001f0000', 'ffc400b51000', 'ffc4001f0100', 'ffc400b51100'],
  );

  const gray = jpegThumbnail(encodeJpeg(smooth(200, 300, 1)));
  const grayFrame = decodeJpeg(gray);
  assert.deepEqual([grayFrame.width, grayFrame.height, grayFrame.channels], [144, 144, 1]);
});

// @test-kind compatibility: ITU-T T.81 baseline sequential Huffman coding with the JFIF YCbCr model; Chromium decodes the same streams in mirage/test-browser/portal-jpeg-decode.test.mjs
test('the codec round-trips grayscale and 4:4:4, 4:2:2, 4:4:0 and 4:2:0 colour within JPEG error', () => {
  for (const [channels, sampling, limit] of [
    [1, { h: 1, v: 1 }, 6],
    [3, { h: 1, v: 1 }, 12],
    [3, { h: 2, v: 1 }, 16],
    [3, { h: 1, v: 2 }, 16],
    [3, { h: 2, v: 2 }, 16],
  ]) {
    const source = smooth(77, 53, channels);
    const decoded = decodeJpeg(encodeJpeg(source, { sampling }));
    assert.deepEqual([decoded.width, decoded.height, decoded.channels], [77, 53, channels]);
    const { max, mean } = difference(decoded.data, source.data);
    assert.ok(max <= limit && mean <= 2, `${channels} ${JSON.stringify(sampling)}: max ${max}, mean ${mean}`);
    assert.deepEqual(jpegFrame(encodeJpeg(source, { sampling })), { width: 77, height: 53, channels });
  }
});

// @test-kind compatibility: ITU-T T.81 B.2.4.4 restart intervals (DRI, RST0..RST7 modulo 8) and B.2.4 table segments that may carry several tables, 16-bit DQT in SOF1
test('restart markers, shared table segments and 16-bit quantization tables decode to the same pixels', () => {
  const source = smooth(120, 90);
  const plain = encodeJpeg(source);
  const expected = decodeJpeg(plain).data;
  const restarted = encodeJpeg(source, { restartInterval: 2 });
  for (let n = 0; n < 8; n++) assert.ok(restarted.includes(Buffer.from([0xff, 0xd0 + n])), `RST${n}`);
  assert.deepEqual(decodeJpeg(restarted).data, expected);

  const merged = mergeSegments(mergeSegments(plain, 0xc4), 0xdb);
  assert.equal(segments(merged).filter((s) => s.marker === 0xc4).length, 1);
  assert.deepEqual(decodeJpeg(merged).data, expected);

  const wide = rewrite(
    rewrite(
      plain,
      0xdb,
      (payload) => Buffer.from([0x10 | payload[0], ...[...payload.subarray(1)].flatMap((value) => [0, value])]),
      { all: true },
    ),
    0xc0,
    (payload) => ({ marker: 0xc1, bytes: payload }),
  );
  assert.deepEqual(decodeJpeg(wide).data, expected);

  const missing = Buffer.from(restarted);
  for (let at = missing.indexOf(Buffer.from([0xff, 0xd3])); at !== -1; at = missing.indexOf(Buffer.from([0xff, 0xd3])))
    missing[at + 1] = 0x00;
  assert.equal(decodeJpeg(missing), null, 'a missing restart marker is a malformed stream');
});

// @test-kind compatibility: ITU-T T.81 Annex G progressive Huffman decoding (DC and AC spectral selection, successive approximation refinement, end-of-band runs, restart intervals): a progressive stream carries the same quantized coefficients as its baseline twin, so both decode to the same samples
test('progressive JPEGs decode to the same samples as their baseline twins', () => {
  for (const [name, pair] of Object.entries(PROGRESSIVE_PAIRS)) {
    const progressive = Buffer.from(pair.progressive, 'base64');
    assert.ok(
      segments(progressive).some((s) => s.marker === 0xc2),
      `${name} is progressive`,
    );
    const decoded = decodeJpeg(progressive);
    assert.ok(decoded, name);
    assert.deepEqual(decoded.data, decodeJpeg(Buffer.from(pair.baseline, 'base64')).data, name);
    assert.deepEqual(jpegFrame(progressive), {
      width: decoded.width,
      height: decoded.height,
      channels: decoded.channels,
    });
  }
});

// @test-kind observation: hosted session F2 thumbs runs a and b (jpeg-progressive-400x300.jpg): a progressive JPEG's thumbnail is a baseline SOF0 JPEG; size=full keeps the progressive upload
test('a progressive JPEG gives a baseline thumbnail of its pixels', () => {
  const { progressive, baseline } = PROGRESSIVE_PAIRS.color;
  const thumbnail = jpegThumbnail(Buffer.from(progressive, 'base64'));
  assert.deepEqual(
    segments(thumbnail).map((s) => s.marker),
    [0xe0, 0xdb, 0xdb, 0xc0, 0xc4, 0xc4, 0xc4, 0xc4, 0xda],
  );
  const decoded = decodeJpeg(thumbnail);
  assert.deepEqual([decoded.width, decoded.height], [24, 24]);
  assert.deepEqual(thumbnail, jpegThumbnail(Buffer.from(baseline, 'base64')));
});

// @test-kind security: untrusted progressive streams never throw, never run more than 64 scans and keep their original bytes when malformed or truncated
test('malformed, truncated and over-long progressive JPEGs keep their bytes without throwing', () => {
  const valid = Buffer.from(PROGRESSIVE_PAIRS.restart.progressive, 'base64');
  // Every scan header with the offset where its entropy-coded data ends (the next marker other than a stuffed zero or RSTn).
  const scans = [];
  for (let at = valid.indexOf(Buffer.from([0xff, 0xda])); at !== -1;) {
    const end = at + 2 + valid.readUInt16BE(at + 2);
    let next = end;
    while (!(valid[next] === 0xff && valid[next + 1] !== 0 && (valid[next + 1] < 0xd0 || valid[next + 1] > 0xd7)))
      next++;
    scans.push({ offset: at, end, dataEnd: next });
    const following = valid.indexOf(Buffer.from([0xff, 0xda]), next);
    at = following;
  }
  assert.ok(scans.length > 2 && scans.length < 64, `${scans.length} scans`);
  const lastScan = scans.at(-1).offset;
  // The first DC scan repeated before the last scan until the stream holds `total` scans.
  const withScans = (total) =>
    Buffer.concat([
      valid.subarray(0, lastScan),
      ...Array.from({ length: total - scans.length }, () => valid.subarray(scans[0].offset, scans[0].dataEnd)),
      valid.subarray(lastScan),
    ]);
  assert.ok(decodeJpeg(withScans(64)), '64 scans decode');
  const repeated = withScans(65);
  const spectralOf = (offset) => offset + 4 + 1 + 2 * valid[offset + 4];
  const withByte = (at, value) => {
    const copy = Buffer.from(valid);
    copy[at] = value;
    return copy;
  };
  const acScan = scans.find((s) => valid[spectralOf(s.offset)] > 0).offset;
  const cases = {
    tooManyScans: repeated,
    spectralPastEnd: withByte(spectralOf(acScan) + 1, 64),
    interleavedAcScan: withByte(spectralOf(scans[0].offset), 1),
    approximationGap: withByte(spectralOf(acScan) + 2, 0x31),
  };
  for (const [name, bytes] of Object.entries(cases)) {
    assert.equal(decodeJpeg(bytes), null, name);
    assert.equal(jpegThumbnail(bytes), bytes, name);
  }
  for (let cut = 200; cut < valid.length - 2; cut += 37) {
    const truncated = valid.subarray(0, cut);
    assert.equal(decodeJpeg(truncated), null, `truncated at ${cut}`);
    assert.equal(jpegThumbnail(truncated), truncated);
  }
  let seed = 0x1b873593;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0x100000000;
  };
  for (let round = 0; round < 300; round++) {
    const mutated = Buffer.from(valid);
    for (let n = 1 + Math.floor(random() * 4); n > 0; n--)
      mutated[Math.floor(random() * mutated.length)] = Math.floor(random() * 256);
    const decoded = decodeJpeg(mutated);
    if (decoded) assert.equal(decoded.data.length, decoded.width * decoded.height * decoded.channels);
    assert.ok(Buffer.isBuffer(jpegThumbnail(mutated)));
  }
});

// @test-kind compatibility: Adobe APP14 transform flag (0 = RGB samples, 1 = YCbCr) as libjpeg interprets it for three components
test('Adobe APP14 transform 0 reads the three components as RGB', () => {
  const solid = encodeJpeg(
    image(16, 16, 3, () => RED),
    { sampling: { h: 1, v: 1 } },
  );
  near(pixel(decodeJpeg(solid), 8, 8), RED, 3, 'YCbCr');
  const rgb = decodeJpeg(insertAfterSoi(solid, ADOBE_RGB));
  assert.equal(rgb.channels, 3);
  const [r, g, b] = RED;
  const ycbcr = [
    0.299 * r + 0.587 * g + 0.114 * b,
    128 - 0.168736 * r - 0.331264 * g + 0.5 * b,
    128 + 0.5 * r - 0.418688 * g - 0.081312 * b,
  ].map(Math.round);
  near(pixel(rgb, 8, 8), ycbcr, 3, 'APP14 transform 0');
});

// @test-kind security: untrusted image bytes never throw out of the codec or the thumbnail, never decode past the documented bounds, and keep their original bytes when unsupported or malformed
test('unsupported, malformed, truncated and oversized JPEGs keep their bytes without throwing', () => {
  const valid = encodeJpeg(smooth(300, 220), { restartInterval: 4 });
  const sof = segments(valid).find((s) => s.marker === 0xc0).offset;
  const withSof = (change) => {
    const copy = Buffer.from(valid);
    change(copy, sof + 4);
    return copy;
  };
  const cases = {
    progressive: withSof((b, at) => (b[at - 3] = 0xc2)),
    lossless: withSof((b, at) => (b[at - 3] = 0xc3)),
    arithmetic: withSof((b, at) => (b[at - 3] = 0xc9)),
    twelveBit: withSof((b, at) => (b[at] = 12)),
    tooWide: withSof((b, at) => b.writeUInt16BE(8193, at + 3)),
    tooManyPixels: withSof((b, at) => {
      b.writeUInt16BE(2049, at + 1);
      b.writeUInt16BE(4096, at + 3);
    }),
    zeroHeight: withSof((b, at) => b.writeUInt16BE(0, at + 1)),
    cmyk: rewrite(valid, 0xc0, (p) =>
      Buffer.concat([p.subarray(0, 5), Buffer.from([4]), p.subarray(6), Buffer.from([4, 0x11, 1])]),
    ),
    allOnesHuffmanCode: rewrite(valid, 0xc4, (p) => Buffer.from([p[0], 2, ...Array(15).fill(0), 0, 1])),
    tooManyHuffmanSymbols: rewrite(valid, 0xc4, (p) =>
      Buffer.from([p[0], ...Array(14).fill(0), 2, 255, ...Array(257).fill(1)]),
    ),
    undefinedTable: rewrite(valid, 0xda, (p) => Buffer.from([...p.subarray(0, 2), 0x33, ...p.subarray(3)])),
    lengthPastEnd: Buffer.concat([valid.subarray(0, 2), Buffer.from([0xff, 0xe2, 0xff, 0xff, 1, 2, 3])]),
    garbage: Buffer.concat([valid.subarray(0, 2), Buffer.from('not a jpeg at all, only invented text', 'utf8')]),
    signatureOnly: valid.subarray(0, 3),
  };
  for (const [name, bytes] of Object.entries(cases)) {
    assert.equal(decodeJpeg(bytes), null, name);
    assert.equal(jpegThumbnail(bytes), bytes, name);
  }
  for (let cut = 400; cut < valid.length - 2; cut += 997) {
    const truncated = valid.subarray(0, cut);
    assert.equal(decodeJpeg(truncated), null, `truncated at ${cut}`);
    assert.equal(jpegThumbnail(truncated), truncated);
  }
  assert.equal(decodeJpeg(valid, { maxPixels: 300 * 220 - 1 }), null, 'caller limits apply');

  // Deterministic mutation fuzzing: every result is null or a frame of the declared size.
  let seed = 0x2545f491;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0x100000000;
  };
  const small = encodeJpeg(smooth(40, 24), { restartInterval: 1 });
  for (let round = 0; round < 400; round++) {
    const mutated = Buffer.from(small);
    for (let n = 1 + Math.floor(random() * 4); n > 0; n--)
      mutated[Math.floor(random() * mutated.length)] = Math.floor(random() * 256);
    const decoded = decodeJpeg(mutated);
    if (decoded) assert.equal(decoded.data.length, decoded.width * decoded.height * decoded.channels);
    assert.ok(Buffer.isBuffer(jpegThumbnail(mutated)));
    assert.ok(
      Buffer.isBuffer(jpegThumbnail(Buffer.concat([mutated.subarray(0, 2), exifOrientation(6), mutated.subarray(2)]))),
    );
  }
});

// @test-kind unproven: the thumbnail shows the Exif orientation (1..8, either byte order, read past other APP1 and comment segments) upright, as a browser shows the upload, and carries none of the source's segments; hosted uploads keep their Exif (session F2 thumbs), the hosted thumbnail of every orientation was not captured
test('a JPEG thumbnail is the upright crop for every Exif orientation', () => {
  // Quadrants larger than the thumbnail's 16x16 chroma blocks, so no corner shares a block with another color.
  const quadrants = image(80, 48, 3, (x, y) => {
    if (y < 24) return x < 40 ? [230, 20, 20] : [20, 200, 20];
    return x < 40 ? [20, 20, 230] : [230, 230, 30];
  });
  const [topLeft, topRight, bottomLeft, bottomRight] = [
    [230, 20, 20],
    [20, 200, 20],
    [20, 20, 230],
    [230, 230, 30],
  ];
  const plain = encodeJpeg(quadrants, { sampling: { h: 1, v: 1 } });
  // Expected corners after display: top-left, top-right, bottom-left, bottom-right of the upright image; the centered
  // 48x48 crop keeps a corner in each quadrant.
  const corners = {
    1: [topLeft, topRight, bottomLeft, bottomRight],
    2: [topRight, topLeft, bottomRight, bottomLeft],
    3: [bottomRight, bottomLeft, topRight, topLeft],
    4: [bottomLeft, bottomRight, topLeft, topRight],
    5: [topLeft, bottomLeft, topRight, bottomRight],
    6: [bottomLeft, topLeft, bottomRight, topRight],
    7: [bottomRight, topRight, bottomLeft, topLeft],
    8: [topRight, bottomRight, topLeft, bottomLeft],
  };
  for (const [orientation, expected] of Object.entries(corners)) {
    const tagged = insertAfterSoi(
      plain,
      exifOrientation(Number(orientation), { bigEndian: orientation === '6' }),
      xmp,
      comment,
    );
    const thumbnail = jpegThumbnail(tagged);
    assert.ok(!thumbnail.includes(Buffer.from('Exif\0\0', 'binary')), 'the thumbnail carries no Exif');
    assert.ok(!thumbnail.includes(xmp) && !thumbnail.includes(comment), 'the thumbnail carries no XMP or comment');
    const decoded = decodeJpeg(thumbnail);
    assert.deepEqual([decoded.width, decoded.height], [48, 48]);
    const [w, h] = [decoded.width - 2, decoded.height - 2];
    [
      [1, 1],
      [w, 1],
      [1, h],
      [w, h],
    ].forEach(([x, y], i) => near(pixel(decoded, x, y), expected[i], 30, `orientation ${orientation} corner ${i}`));
  }
  const upright = decodeJpeg(jpegThumbnail(insertAfterSoi(encodeJpeg(banded(300, 428)), exifOrientation(6))));
  assert.deepEqual([upright.width, upright.height], [144, 144]);
});

const SITE = '77777777-7777-4777-8777-777777777771';
const ITEM = '77777777-7777-4777-8777-777777777772';
const CONTACT = '77777777-7777-4777-8777-777777777774';

async function simulator(t) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'portal-jpeg-thumbnail-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const files = {
    'website.yml': `adx_websiteid: ${SITE}\nadx_name: Example`,
    'Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true',
    // The table's Web API settings: enabled, with its name and image columns.
    'sitesetting.yml': [
      '- adx_sitesettingid: 77777777-7777-4777-8777-777777777780',
      '  adx_name: Webapi/x_item/enabled',
      '  adx_value: "true"',
      '- adx_sitesettingid: 77777777-7777-4777-8777-777777777781',
      '  adx_name: Webapi/x_item/fields',
      '  adx_value: "x_name,x_image"',
    ].join('\n'),
  };
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body);
  const initial = {
    version: 1,
    mappings: {
      x_item: {
        entitySet: 'x_items',
        idColumn: 'x_itemid',
        nameColumn: 'x_name',
        fields: {
          x_name: { dataverseType: 'nvarchar' },
          x_image: { dataverseType: 'image', isPrimary: true, canStoreFullImage: true },
        },
      },
      contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname', fields: {} },
    },
    tables: {
      x_item: [{ x_itemid: ITEM, x_name: 'Mine', x_owner: CONTACT }],
      contact: [{ contactid: CONTACT, fullname: 'Invented Visitor' }],
    },
    permissions: [
      {
        id: 'own',
        entity: 'x_item',
        scope: 'contact',
        field: 'x_owner',
        roles: ['Member'],
        operations: ['read', 'update'],
      },
    ],
    settings: { permissionMode: 'enforce' },
    simulator: { mode: 'local', pageMode: 'local', live: { origin: null }, endpoints: [] },
  };
  const app = ownedClose(
    t,
    await createSimulator({ sourceDir: dir, stateFile: path.join(dir, 'state.json'), initial, watch: false }),
  );
  const { cookie } = signInHeaders(app, CONTACT, { roles: ['Member'] });
  const token = /value="([^"]+)"/.exec(
    await (await fetch(`${app.url}/_layout/tokenhtml`, { headers: { cookie } })).text(),
  )[1];
  const call = (method, route, body, headers = {}) =>
    fetch(`${app.url}/_api/${route}`, {
      method,
      body,
      headers: {
        cookie,
        'x-requested-with': 'XMLHttpRequest',
        ...(method === 'GET' ? {} : { __RequestVerificationToken: token }),
        ...headers,
      },
    });
  return { app, call };
}

// @test-kind observation: hosted sessions F2 thumbs and F1 files (runs a and b): size=full answers the upload byte for byte with its Exif, a thumbnail read ignores Range, the thumbnail and record projection are the upright Exif-free 144x144 crop (91x91 for 91x130)
test('the portal JPEG image route serves whole upright thumbnails while full and organization reads keep the stored bytes', async (t) => {
  const { app, call } = await simulator(t);
  const route = `x_items(${ITEM})/x_image`;
  const name = { 'content-type': 'application/octet-stream', 'x-ms-file-name': 'fixture.jpg' };
  const original = encodeJpeg(banded(300, 428));
  assert.equal((await call('PATCH', route, original, name)).status, 204);

  const full = await call('GET', `${route}/$value?size=full`);
  // The portal sends no mimetype header (hosted sessions F1 files and F2 thumbs, runs a and b).
  assert.deepEqual(
    [full.status, full.headers.get('mimetype'), full.headers.get('content-disposition')],
    [200, null, 'inline; filename=fixture.jpg'],
  );
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), original, 'an upright JPEG is stored unchanged');

  const result = await call('GET', `${route}/$value`, undefined, { Range: 'bytes=0-15' });
  assert.equal(result.status, 200, 'a thumbnail read ignores Range');
  assert.equal(result.headers.get('content-range'), null);
  const thumbnailBytes = Buffer.from(await result.arrayBuffer());
  const whole = await call('GET', `${route}/$value`);
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), thumbnailBytes, 'ranged and whole reads agree');
  const thumbnail = decodeJpeg(thumbnailBytes);
  assert.deepEqual([thumbnail.width, thumbnail.height], [144, 144]);
  near(pixel(thumbnail, 0, 0), BLUE, 24, 'top-left');
  near(pixel(thumbnail, 143, 143), BLUE, 24, 'bottom-right');
  const projected = await (await call('GET', `x_items(${ITEM})?$select=x_image`)).json();
  assert.deepEqual(Buffer.from(projected.x_image, 'base64'), thumbnailBytes);

  const file = app.store.recordPipeline.fileContentInternal;
  const internal = {
    principal: {
      userId: CONTACT,
      evidence: 'invented organization file seam fixture',
      grants: [{ entity: 'x_item', operations: ['read', 'update'] }],
    },
    entity: 'x_item',
    id: ITEM,
    column: 'x_image',
  };
  const organization = await file({ ...internal, operation: 'download' });
  assert.deepEqual(Buffer.from(organization.body.$content, 'base64'), original, 'organization reads are unchanged');

  assert.equal((await call('PATCH', route, encodeJpeg(smooth(91, 130)), name)).status, 204);
  const small = decodeJpeg(Buffer.from(await (await call('GET', `${route}/$value`)).arrayBuffer()));
  assert.deepEqual([small.width, small.height], [91, 91]);

  // Orientation 6 on a 400x200 frame shows 200x400: the thumbnail is the upright crop without Exif, size=full the upload.
  const rotated = insertAfterSoi(encodeJpeg(banded(400, 200)), exifOrientation(6));
  assert.equal((await call('PATCH', route, rotated, name)).status, 204);
  const stored = Buffer.from(await (await call('GET', `${route}/$value?size=full`)).arrayBuffer());
  assert.deepEqual(stored, rotated, 'size=full keeps the Exif upload');
  const rotatedThumbnail = Buffer.from(await (await call('GET', `${route}/$value`)).arrayBuffer());
  assert.ok(!rotatedThumbnail.includes(Buffer.from('Exif\0\0', 'binary')), 'the thumbnail carries no Exif');
  assert.deepEqual(rotatedThumbnail, jpegThumbnail(rotated));
});
