// Portal GIF and BMP image thumbnails (mirage/lib/portal-image-formats.mjs): the bounded first-frame GIF decoder and
// the Windows bitmap decoder, the center crop shared with PNG and JPEG, the GIF and BMP thumbnail encodings and the
// portal image route end to end. Fixtures are invented pixels written by mirage/test/fixtures/gif-bmp-images.mjs;
// Chromium decodes the same fixtures in mirage/test-browser/portal-gif-bmp-decode.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { encodeJpeg } from '../lib/portal-jpeg-codec.mjs';
import { PNG } from 'pngjs';
import { decodeBmpImage, decodeGifImage } from '../lib/portal-image-decoders.mjs';
import { bmpThumbnail, gifThumbnail } from '../lib/portal-image-formats.mjs';
import { createSimulator } from '../server.mjs';
import { signInHeaders } from '../testing/session.mjs';
import { ownedFixture, ownedClose, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import {
  BITMAPS,
  PALETTE,
  RLE4,
  RLE8,
  RUN_PALETTE,
  SIXTEEN,
  bitmapOf,
  bmp,
  expectedCrop,
  gif,
  gifExtension,
  halftonePixels,
  indexAt,
  opaque,
  patternBmp,
  patternGif,
  patternRgba,
  pick,
  rgbaImage,
  rgbaOf,
} from './fixtures/gif-bmp-images.mjs';

/** The pixels of a GIF or BMP thumbnail, read by the module's own bounded decoders. */
const pixelsOf = (bytes) => {
  const image = decodeGifImage(bytes) ?? decodeBmpImage(bytes);
  return image && { width: image.width, height: image.height, rgba: Uint8Array.from(image.rgba) };
};
const sizeOf = (bytes) => {
  const image = pixelsOf(bytes);
  return [image.width, image.height];
};
/** The GIF thumbnail of known pixels shows their halftone crop. */
const expectedGif = (rgba, width, height) => halftonePixels(expectedCrop(rgba, width, height));
/**
 * The BMP thumbnail shows the crop opaque: its alpha bytes are written, but a BITMAPINFOHEADER BI_RGB bitmap's fourth
 * byte is not alpha to a bitmap reader (this decoder, as Chromium), so the colors of transparent source pixels show.
 */
const expectedBmp = (rgba, width, height) => {
  const crop = expectedCrop(rgba, width, height);
  for (let at = 3; at < crop.rgba.length; at += 4) crop.rgba[at] = 255;
  return crop;
};
/** The expected BMP thumbnail pixels, with the actual colors under source pixels that were fully transparent. */
const expectedBitmap = (actual, rgba, width, height) => {
  const expected = expectedBmp(rgba, width, height);
  const visible = expectedCrop(rgba, width, height).rgba;
  for (let at = 0; at < visible.length; at += 4)
    if (!visible[at + 3]) expected.rgba.set(actual.rgba.subarray(at, at + 3), at);
  return expected;
};

// @test-kind observation: hosted session F2 thumbs runs a and b (200x120 GIF -> 120x120, 160x100 BMP -> 100x100, 300x428 and 91x130 PNG -> 144x144 and 91x91) and F1 files runs a and b (300x100 PNG -> 100x100): a centered square of the shorter side, at most 144 px; GIF and BMP sample the same source pixels as the PNG thumbnail
test('GIF and BMP thumbnails crop a square of the shorter side and pick the PNG thumbnail pixels', () => {
  for (const [width, height, edge] of [
    [300, 428, 144],
    [91, 130, 91],
    [100, 300, 100],
    [200, 120, 120],
    [160, 100, 100],
    [143, 40, 40],
    [145, 12, 12],
  ]) {
    const rgba = patternRgba(width, height);
    for (const [label, thumbnail, expected] of [
      ['GIF', gifThumbnail(patternGif(width, height)), expectedGif(rgba, width, height)],
      ['BMP', bmpThumbnail(patternBmp(width, height)), expectedBmp(rgba, width, height)],
    ]) {
      assert.deepEqual(sizeOf(thumbnail), [edge, edge], `${label} ${width}x${height}`);
      assert.deepEqual(pixelsOf(thumbnail), expected, `${label} ${width}x${height} samples the PNG thumbnail pixels`);
    }
  }
  for (const [width, height] of [
    [144, 144],
    [91, 91],
  ]) {
    const asGif = patternGif(width, height);
    const asBmp = patternBmp(width, height);
    // An image that already is its thumbnail is re-encoded too, as PNG and JPEG are, so no source metadata survives.
    for (const [label, source, thumbnail] of [
      ['GIF', asGif, gifThumbnail(asGif)],
      ['BMP', asBmp, bmpThumbnail(asBmp)],
    ]) {
      assert.notDeepEqual(thumbnail, source, `a ${width}x${height} ${label} is re-encoded`);
      assert.deepEqual(sizeOf(thumbnail), [width, height], `a ${width}x${height} ${label} keeps its size`);
    }
  }
});

// @test-kind observation: hosted session F2 thumbs runs a and b: the GIF thumbnail is a GIF89a with a 256-entry global table (the 6x7x6 halftone colors, red outer, then green, then blue, four black entries last), a graphic control extension with the transparency flag, one 8-bit LZW frame; the BMP thumbnail is a bottom-up 32-bit BI_RGB bitmap (54-byte header, BITMAPINFOHEADER, alpha 255 for opaque pixels). The transparent index value and the BMP pixels per meter did not survive the capture's text form and are local choices
test('GIF thumbnails are halftone GIF89a frames and BMP thumbnails are 32-bit bitmaps', () => {
  const gifBytes = gifThumbnail(patternGif(200, 120));
  assert.equal(gifBytes.toString('latin1', 0, 6), 'GIF89a');
  assert.deepEqual([gifBytes.readUInt16LE(6), gifBytes.readUInt16LE(8), gifBytes[10]], [120, 120, 0xf7]);
  const table = gifBytes.subarray(13, 13 + 768);
  assert.equal(table.subarray(0, 21).toString('hex'), '000000000033000066000099' + '0000cc0000ff002b00');
  assert.equal(table.subarray(42 * 3, 43 * 3).toString('hex'), '330000');
  assert.equal(table.subarray(251 * 3).toString('hex'), 'ffffff' + '000000'.repeat(4));
  assert.deepEqual([...gifBytes.subarray(13 + 768, 13 + 768 + 6)], [0x21, 0xf9, 4, 1, 0, 0]);
  assert.deepEqual([...gifBytes.subarray(13 + 776, 13 + 776 + 11)], [0x2c, 0, 0, 0, 0, 120, 0, 120, 0, 0, 8]);
  assert.equal(gifBytes.at(-1), 0x3b);

  const bmpBytes = bmpThumbnail(patternBmp(160, 100));
  assert.equal(bmpBytes.toString('latin1', 0, 2), 'BM');
  assert.deepEqual(
    [
      bmpBytes.readUInt32LE(2),
      bmpBytes.readUInt32LE(10),
      bmpBytes.readUInt32LE(14),
      bmpBytes.readInt32LE(18),
      bmpBytes.readInt32LE(22),
      bmpBytes.readUInt16LE(26),
      bmpBytes.readUInt16LE(28),
      bmpBytes.readUInt32LE(30),
      bmpBytes.readUInt32LE(34),
    ],
    [40054, 54, 40, 100, 100, 1, 32, 0, 0],
  );
  // Bottom-up rows: the first stored pixel is the bottom-left one, as B, G, R, A.
  const bottomLeft = expectedBmp(patternRgba(160, 100), 160, 100).rgba.subarray(99 * 100 * 4, 99 * 100 * 4 + 4);
  assert.deepEqual([...bmpBytes.subarray(54, 58)], [bottomLeft[2], bottomLeft[1], bottomLeft[0], 255]);

  // A transparent source pixel stays transparent in both formats.
  const hole = indexAt(30, 45);
  const withHole = rgbaImage(60, 90, (x, y) =>
    indexAt(x, y) === hole ? [0, 0, 0, 0] : opaque(PALETTE, indexAt(x, y)),
  );
  assert.deepEqual(pixelsOf(gifThumbnail(patternGif(60, 90, { transparent: hole }))), expectedGif(withHole, 60, 90));
  const clear = gif({ width: 40, height: 60, palette: [[10, 20, 30]], pixel: () => 0, transparent: 0 });
  assert.ok(
    pixelsOf(gifThumbnail(clear)).rgba.every((value) => value === 0),
    'a fully transparent frame stays transparent',
  );
});

// @test-kind compatibility: W3C GIF89a specification (logical screen, global and local color tables, graphic control transparency, interlaced rows in four passes, variable-length LZW codes up to 12 bits with clear and end codes, extension blocks); the first frame is the thumbnail source as Learn "Types of columns" says for animated GIFs
test('the GIF decoder reads interlaced, transparent, local-palette, offset and multi-frame streams', () => {
  const [width, height] = [37, 50];
  const expected = expectedGif(patternRgba(width, height), width, height);
  const variants = {
    plain: patternGif(width, height),
    interlaced: patternGif(width, height, { interlace: true }),
    localTable: patternGif(width, height, { local: true }),
    gif87a: patternGif(width, height, { version: '87a' }),
    extensions: patternGif(width, height, {
      extensions: [
        gifExtension(0xfe, Buffer.from('invented comment', 'utf8')),
        gifExtension(0xff, Buffer.from('NETSCAPE2.0\x03\x01\x00\x00', 'latin1')),
      ],
    }),
    animated: patternGif(width, height, { second: 3 }),
  };
  for (const [name, bytes] of Object.entries(variants)) assert.deepEqual(pixelsOf(gifThumbnail(bytes)), expected, name);
  const two = SIXTEEN.slice(0, 2);
  const twoColors = (x, y) => pick(x, y, 2);
  assert.deepEqual(
    pixelsOf(gifThumbnail(gif({ width, height, palette: two, pixel: twoColors, minimum: 8 }))),
    expectedGif(
      rgbaImage(width, height, (x, y) => opaque(two, twoColors(x, y))),
      width,
      height,
    ),
    'a two-colour frame with code size 8',
  );

  // Interlacing with fewer rows than a pass: every row still lands where it belongs.
  for (const rows of [1, 2, 3, 5, 9])
    assert.deepEqual(
      pixelsOf(gifThumbnail(patternGif(160, rows, { interlace: true }))),
      expectedGif(patternRgba(160, rows), 160, rows),
      `${rows} interlaced rows`,
    );

  // Noise fills the 4096-entry table: once with clear codes, once with the deferred clear of a full table.
  const noise = (x, y) => (Math.imul(x + 1, 2654435761) ^ Math.imul(y + 1, 40503)) >>> 24;
  const noisy = rgbaImage(300, 200, (x, y) => opaque(PALETTE, noise(x, y)));
  for (const deferClear of [false, true])
    assert.deepEqual(
      pixelsOf(gifThumbnail(gif({ width: 300, height: 200, palette: PALETTE, pixel: noise, deferClear }))),
      expectedGif(noisy, 300, 200),
      `deferClear ${deferClear}`,
    );

  // A frame inside the screen leaves the rest transparent; a frame past the screen edge is clipped to the screen.
  const inner = gif({
    width: 50,
    height: 70,
    palette: PALETTE,
    pixel: indexAt,
    frame: { left: 10, top: 20, width: 30, height: 60 },
  });
  const innerRgba = rgbaImage(50, 70, (x, y) =>
    x >= 10 && x < 40 && y >= 20 ? opaque(PALETTE, indexAt(x - 10, y - 20)) : [0, 0, 0, 0],
  );
  assert.deepEqual(pixelsOf(gifThumbnail(inner)), expectedGif(innerRgba, 50, 70), 'frame offset and clipping');

  // Indices past a 4-entry color table (code size 3 carries 0..7) leave the screen transparent.
  const small = [
    [200, 10, 10],
    [10, 200, 10],
    [10, 10, 200],
    [240, 240, 20],
  ];
  const past = gif({ width: 30, height: 20, palette: small, pixel: (x, y) => (x + y) & 7, minimum: 3 });
  const pastRgba = rgbaImage(30, 20, (x, y) => opaque(small, (x + y) & 7));
  assert.deepEqual(pixelsOf(gifThumbnail(past)), expectedGif(pastRgba, 30, 20), 'indices past the color table');
});

// @test-kind compatibility: Win32 BITMAPFILEHEADER, BITMAPINFOHEADER, BITMAPV4HEADER and BITMAPV5HEADER (biHeight sign for bottom-up and top-down rows, 4-byte row padding, 1/4/8-bit color tables with biClrUsed, BI_RGB 16-bit 5-5-5 and 32-bit defaults, BI_BITFIELDS and BI_ALPHABITFIELDS masks); the 8-bit scaling of narrow masks and the all-zero alpha rule match Chromium in mirage/test-browser/portal-gif-bmp-decode.test.mjs
test('the BMP decoder reads every bit depth, row order and bit-field layout', () => {
  const [width, height] = [23, 31];
  for (const [name, spec] of Object.entries(BITMAPS)) {
    const actual = pixelsOf(bmpThumbnail(bitmapOf(spec, width, height)));
    assert.deepEqual(actual, expectedBitmap(actual, rgbaOf(spec, width, height), width, height), name);
  }
});

/** The pixels the RLE fixtures above describe (rows counted from the bottom), black where nothing is drawn. */
function runRgba(width, height, runs) {
  const drawn = new Map(runs.flatMap(([row, x, indices]) => indices.map((index, i) => [`${x + i},${row}`, index])));
  return rgbaImage(width, height, (x, y) => {
    const index = drawn.get(`${x},${height - 1 - y}`);
    return index === undefined ? [0, 0, 0, 255] : [...RUN_PALETTE[index], 255];
  });
}

// @test-kind compatibility: Win32 "Bitmap Compression" (BI_RLE8 and BI_RLE4 encoded and absolute modes, word-aligned absolute runs, escapes 0 end of line, 1 end of bitmap, 2 delta); pixels the runs skip are opaque black as Chromium shows them (mirage/test-browser/portal-gif-bmp-decode.test.mjs)
test('the BMP decoder reads RLE8 and RLE4 runs, deltas and escapes', () => {
  const [width, height] = [12, 8];
  const rle8 = bmp({ width, height, depth: 8, compression: 1, palette: RUN_PALETTE, used: 10, rle: RLE8 });
  const rows8 = runRgba(width, height, [
    [0, 0, [1, 1, 1, 2, 3, 4]],
    [1, 2, [3, 3]],
    [3, 2, [4, 4, 4, 4, 4]],
  ]);
  assert.deepEqual(pixelsOf(bmpThumbnail(rle8)), expectedBmp(rows8, width, height), 'RLE8');
  const rle4 = bmp({ width, height, depth: 4, compression: 2, palette: RUN_PALETTE, used: 10, rle: RLE4 });
  const rows4 = runRgba(width, height, [
    [0, 0, [1, 2, 1, 2, 3, 4, 5, 6, 7]],
    [1, 0, [8, 9, 8, 9, 8, 9, 8]],
  ]);
  assert.deepEqual(pixelsOf(bmpThumbnail(rle4)), expectedBmp(rows4, width, height), 'RLE4');
  // Runs that end every row without an end-of-bitmap escape still describe the whole bitmap.
  const rows = Array.from({ length: height }, () => [2, 5, 0, 0]).flat();
  const endless = bmp({ width, height, depth: 8, compression: 1, palette: RUN_PALETTE, used: 10, rle: rows });
  const allRows = runRgba(
    width,
    height,
    Array.from({ length: height }, (_, row) => [row, 0, [5, 5]]),
  );
  assert.deepEqual(pixelsOf(bmpThumbnail(endless)), expectedBmp(allRows, width, height), 'RLE8 without an end escape');
});

const replaceAt = (bytes, at, values) => {
  const copy = Buffer.from(bytes);
  copy.set(values, at);
  return copy;
};
const writeAt = (bytes, method, value, at) => {
  const copy = Buffer.from(bytes);
  copy[method](value, at);
  return copy;
};

// @test-kind security: untrusted GIF and BMP bytes never throw out of the thumbnail, never decode past the 8192 px side and 8M pixel bounds or the 12-bit LZW table, and keep their original bytes when malformed, truncated, oversized or unsupported
test('malformed, truncated, oversized and unsupported GIF and BMP images keep their bytes without throwing', () => {
  const validGif = patternGif(40, 30);
  const frameAt = validGif.indexOf(0x2c, 13 + 768);
  // A local color table of two entries sits after the 10-byte image descriptor at offset 13.
  const localOnly = gif({ width: 40, height: 30, palette: SIXTEEN.slice(0, 2), pixel: () => 1, local: true });
  const gifCases = {
    signature: Buffer.concat([Buffer.from('GIF88a', 'latin1'), validGif.subarray(6)]),
    zeroWidth: writeAt(validGif, 'writeUInt16LE', 0, 6),
    tooWide: writeAt(writeAt(validGif, 'writeUInt16LE', 8193, 6), 'writeUInt16LE', 1, 8),
    tooManyPixels: writeAt(writeAt(validGif, 'writeUInt16LE', 4096, 6), 'writeUInt16LE', 4096, 8),
    noColorTable: Buffer.concat([localOnly.subarray(0, 22), Buffer.from([0]), localOnly.subarray(29)]),
    globalTablePastEnd: validGif.subarray(0, 200),
    trailerFirst: Buffer.concat([validGif.subarray(0, 13 + 768), Buffer.from([0x3b])]),
    unknownBlock: replaceAt(validGif, frameAt, [0x2d]),
    zeroFrame: writeAt(validGif, 'writeUInt16LE', 0, frameAt + 5),
    codeSizeOne: replaceAt(validGif, frameAt + 10, [1]),
    codeSizeNine: replaceAt(validGif, frameAt + 10, [9]),
    codeSizeTwelve: replaceAt(validGif, frameAt + 10, [12]),
    codeBeforeTable: replaceAt(validGif, frameAt + 12, [0xff, 0xff, 0xff, 0xff]),
    subBlockPastEnd: Buffer.concat([validGif.subarray(0, frameAt + 11), Buffer.from([200, 1, 2, 3])]),
    frameLongerThanData: writeAt(validGif, 'writeUInt16LE', 31, frameAt + 7),
    truncatedExtension: Buffer.concat([validGif.subarray(0, 13 + 768), Buffer.from([0x21, 0xf9, 4, 1])]),
    garbage: Buffer.concat([validGif.subarray(0, 6), Buffer.from('invented text, not a GIF', 'utf8')]),
    headerOnly: validGif.subarray(0, 12),
  };
  for (const [name, bytes] of Object.entries(gifCases)) assert.equal(gifThumbnail(bytes), bytes, `GIF ${name}`);

  const validBmp = patternBmp(40, 30);
  const indexed = bitmapOf(BITMAPS['8-bit bottom-up'], 40, 30);
  const fields = bitmapOf(BITMAPS['16-bit 5-6-5 BI_BITFIELDS top-down'], 40, 30);
  const runs = bmp({ width: 12, height: 8, depth: 8, compression: 1, palette: RUN_PALETTE, used: 10, rle: RLE8 });
  const bmpCases = {
    os2Core: writeAt(validBmp, 'writeUInt32LE', 12, 14),
    os2V2: writeAt(validBmp, 'writeUInt32LE', 64, 14),
    zeroWidth: writeAt(validBmp, 'writeInt32LE', 0, 18),
    negativeWidth: writeAt(validBmp, 'writeInt32LE', -40, 18),
    zeroHeight: writeAt(validBmp, 'writeInt32LE', 0, 22),
    minimumHeight: writeAt(validBmp, 'writeInt32LE', -0x80000000, 22),
    tooWide: writeAt(validBmp, 'writeInt32LE', 8193, 18),
    tooManyPixels: writeAt(writeAt(validBmp, 'writeInt32LE', 4096, 18), 'writeInt32LE', 4096, 22),
    twoBit: writeAt(validBmp, 'writeUInt16LE', 2, 28),
    jpegCompression: writeAt(validBmp, 'writeUInt32LE', 4, 30),
    pngCompression: writeAt(validBmp, 'writeUInt32LE', 5, 30),
    bitfieldsAt24Bits: writeAt(validBmp, 'writeUInt32LE', 3, 30),
    rleTopDown: writeAt(runs, 'writeInt32LE', -8, 22),
    rleWithoutEnd: runs.subarray(0, runs.length - 2),
    rleCutInAbsoluteRun: runs.subarray(0, runs.length - RLE8.length + 6),
    rleCutInDelta: Buffer.concat([runs.subarray(0, runs.length - RLE8.length), Buffer.from([0, 2, 1])]),
    splitMask: writeAt(fields, 'writeUInt32LE', 0xf00f, 54),
    wideMask16: writeAt(fields, 'writeUInt32LE', 0x1f0000, 62),
    pixelsPastEnd: validBmp.subarray(0, validBmp.length - 1),
    offsetPastEnd: writeAt(validBmp, 'writeUInt32LE', validBmp.length, 10),
    paletteCut: indexed.subarray(0, 54 + 600),
    headerPastEnd: writeAt(validBmp.subarray(0, 60), 'writeUInt32LE', 124, 14),
    garbage: Buffer.concat([Buffer.from('BM', 'latin1'), Buffer.from('invented text, not a bitmap at all', 'utf8')]),
  };
  for (const [name, bytes] of Object.entries(bmpCases)) assert.equal(bmpThumbnail(bytes), bytes, `BMP ${name}`);

  for (const [label, valid, thumbnail] of [
    ['GIF', patternGif(160, 90, { interlace: true }), gifThumbnail],
    ['BMP', bitmapOf(BITMAPS['4-bit bottom-up'], 160, 90), bmpThumbnail],
  ])
    for (let cut = 0; cut < valid.length - 1; cut += 97) {
      const truncated = valid.subarray(0, cut);
      assert.equal(thumbnail(truncated), truncated, `${label} truncated at ${cut}`);
    }

  // Deterministic mutation fuzzing: a result is the original bytes or a decodable square thumbnail of at most 144 px,
  // and nothing throws.
  let seed = 0x6d2b79f5;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0x100000000;
  };
  const seeds = [
    [gifThumbnail, patternGif(48, 20, { interlace: true, transparent: 5 })],
    [gifThumbnail, gif({ width: 30, height: 50, palette: SIXTEEN, pixel: (x, y) => pick(x, y, 16), local: true })],
    [bmpThumbnail, bitmapOf(BITMAPS['4-bit bottom-up'], 30, 12)],
    [bmpThumbnail, bitmapOf(BITMAPS['32-bit V5 BI_BITFIELDS with an alpha mask'], 12, 30)],
    [bmpThumbnail, runs],
  ];
  for (let round = 0; round < 400; round++) {
    const [thumbnail, valid] = seeds[round % seeds.length];
    const mutated = Buffer.from(valid);
    for (let n = 1 + Math.floor(random() * 4); n > 0; n--)
      mutated[Math.floor(random() * mutated.length)] = Math.floor(random() * 256);
    const result = thumbnail(mutated);
    const image = result === mutated ? null : pixelsOf(result);
    assert.ok(result === mutated || (image && image.width === image.height && image.width <= 144), `round ${round}`);
  }
});

const IDS = {
  site: '88888888-8888-4888-8888-888888888801',
  record: '88888888-8888-4888-8888-888888888802',
  visitor: '88888888-8888-4888-8888-888888888803',
};

/** A local portal with one table whose primary image column stores full images, readable and writable by its owner. */
async function portalWithImages(t) {
  const sourceDir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'portal-gif-bmp-thumbnail-'));
  ownedFixture(t).remove(() => fs.rm(sourceDir, { recursive: true, force: true }));
  const settings = { 'Webapi/x_badge/enabled': '"true"', 'Webapi/x_badge/fields': 'x_title,x_picture' };
  const sources = [
    ['website.yml', `adx_websiteid: ${IDS.site}\nadx_name: Invented badges`],
    ['Home.webpage.yml', 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true'],
    [
      'sitesetting.yml',
      Object.entries(settings)
        .map(
          ([name, value], i) =>
            `- adx_sitesettingid: 88888888-8888-4888-8888-88888888881${i}\n  adx_name: ${name}\n  adx_value: ${value}`,
        )
        .join('\n'),
    ],
  ];
  await Promise.all(sources.map(([file, text]) => fs.writeFile(path.join(sourceDir, file), text)));
  const picture = { dataverseType: 'image', isPrimary: true, canStoreFullImage: true };
  const app = ownedClose(
    t,
    await createSimulator({
      sourceDir,
      stateFile: path.join(sourceDir, 'state.json'),
      watch: false,
      initial: {
        version: 1,
        settings: { permissionMode: 'enforce' },
        simulator: { mode: 'local', pageMode: 'local', live: { origin: null }, endpoints: [] },
        tables: {
          contact: [{ contactid: IDS.visitor, fullname: 'Invented Badge Owner' }],
          x_badge: [{ x_badgeid: IDS.record, x_title: 'Badge', x_holder: IDS.visitor }],
        },
        mappings: {
          contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname', fields: {} },
          x_badge: {
            entitySet: 'x_badges',
            idColumn: 'x_badgeid',
            nameColumn: 'x_title',
            fields: { x_title: { dataverseType: 'nvarchar' }, x_picture: picture },
          },
        },
        permissions: [
          {
            id: 'holder',
            entity: 'x_badge',
            scope: 'contact',
            field: 'x_holder',
            roles: ['Member'],
            operations: ['read', 'update'],
          },
        ],
      },
    }),
  );
  const { cookie } = signInHeaders(app, IDS.visitor, { roles: ['Member'] });
  const tokenPage = await (await fetch(`${app.url}/_layout/tokenhtml`, { headers: { cookie } })).text();
  const verification = /value="([^"]+)"/.exec(tokenPage)[1];
  const send = async (method, route, { body, headers = {} } = {}) => {
    const sent = { cookie, 'x-requested-with': 'XMLHttpRequest', ...headers };
    if (method !== 'GET') sent.__RequestVerificationToken = verification;
    const response = await fetch(`${app.url}/_api/${route}`, { method, body, headers: sent });
    return { response, bytes: Buffer.from(await response.arrayBuffer()) };
  };
  const organizationRead = async (options = {}) => {
    const answer = await app.store.recordPipeline.fileContentInternal({
      ...options,
      principal: {
        userId: IDS.visitor,
        evidence: 'invented organization read of the badge picture',
        grants: [{ entity: 'x_badge', operations: ['read'] }],
      },
      operation: 'download',
      entity: 'x_badge',
      id: IDS.record,
      column: 'x_picture',
    });
    return options.portalImage ? answer : Buffer.from(answer.body.$content, 'base64');
  };
  return { send, organizationRead };
}

// @test-kind observation: hosted sessions F2 thumbs and F1 files (runs a and b): size=full answers the upload byte for byte, the default read and the record projection are the thumbnail in the source format (GIF stays GIF, BMP stays BMP), a thumbnail read ignores Range (F1), the 91x130 image gives 91x91
test('the portal GIF and BMP image routes serve whole thumbnails in their format while full and organization reads keep the stored bytes', async (t) => {
  const { send, organizationRead } = await portalWithImages(t);
  const column = `x_badges(${IDS.record})/x_picture`;
  for (const [label, mime, original, small, expectedPixels] of [
    ['fixture.gif', 'image/gif', patternGif(300, 428, { interlace: true }), patternGif(91, 130), expectedGif],
    ['fixture.bmp', 'image/bmp', patternBmp(300, 428), patternBmp(91, 130), expectedBmp],
  ]) {
    const upload = (bytes) =>
      send('PATCH', column, {
        body: bytes,
        headers: { 'content-type': 'application/octet-stream', 'x-ms-file-name': label },
      });
    assert.equal((await upload(original)).response.status, 204, label);

    const full = await send('GET', `${column}/$value?size=full`);
    // The portal sends no mimetype header (hosted session F2 thumbs runs a and b); the name comes inline.
    assert.deepEqual(
      [full.response.status, full.response.headers.get('mimetype'), full.response.headers.get('content-disposition')],
      [200, null, `inline; filename=${label}`],
      label,
    );
    assert.deepEqual(full.bytes, original, `${label}: the full image is the stored bytes`);

    const whole = await send('GET', `${column}/$value`);
    assert.equal(whole.response.headers.get('content-type'), 'application/octet-stream', label);
    assert.deepEqual(
      pixelsOf(whole.bytes),
      expectedPixels(patternRgba(300, 428), 300, 428),
      `${label}: the default read is the thumbnail`,
    );
    assert.equal(sniff(whole.bytes), mime, `${label}: the thumbnail keeps the source format`);
    const ranged = await send('GET', `${column}/$value`, { headers: { Range: 'bytes=0-99' } });
    assert.equal(ranged.response.status, 200, `${label}: a thumbnail read ignores Range`);
    assert.equal(ranged.response.headers.get('content-range'), null);
    assert.deepEqual(ranged.bytes, whole.bytes, `${label}: the whole thumbnail`);
    const record = JSON.parse((await send('GET', `x_badges(${IDS.record})?$select=x_picture`)).bytes);
    assert.deepEqual(
      Buffer.from(record.x_picture, 'base64'),
      whole.bytes,
      `${label}: the record field is the thumbnail`,
    );
    assert.deepEqual(await organizationRead(), original, `${label}: organization reads are unchanged`);

    assert.equal((await upload(small)).response.status, 204);
    assert.deepEqual(sizeOf((await send('GET', `${column}/$value`)).bytes), [91, 91], `${label} 91x130`);
  }
});

// The type of thumbnail bytes by their signature.
const sniff = (bytes) => {
  if (bytes.toString('latin1', 0, 3) === 'GIF') return 'image/gif';
  if (bytes.toString('latin1', 0, 2) === 'BM') return 'image/bmp';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  return null;
};

// The bytes of a pattern image as PNG and as JPEG, the formats the GIF and BMP fixtures do not write.
const patternPng = (width, height) => {
  const png = new PNG({ width, height });
  png.data.set(patternRgba(width, height));
  return PNG.sync.write(png);
};
const patternJpeg = (width, height) => {
  const rgba = patternRgba(width, height);
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) rgb.set(rgba.subarray(i * 4, i * 4 + 3), i * 3);
  return encodeJpeg({ width, height, channels: 3, data: rgb }, { quality: 90 });
};

// @test-kind observation: hosted session F2 thumbs runs a and b: every format keeps its own type in the thumbnail (JPEG, PNG, GIF and BMP), the file seam's $content-type names the stored type whether it re-encodes or serves the stored bytes, and the portal sends no mimetype header (a full read names the file in x-ms-file-name); a thumbnail read ignores Range (F1 files runs a and b) while size=full honours it
test('whole, ranged and seam thumbnail reads name the stored type, re-encoded or kept', async (t) => {
  const { send, organizationRead } = await portalWithImages(t);
  const column = `x_badges(${IDS.record})/x_picture`;
  for (const [label, bytes, stored, kept] of [
    ['large.gif', patternGif(300, 428), 'image/gif', false],
    ['large.bmp', patternBmp(300, 428), 'image/bmp', false],
    ['large.jpg', patternJpeg(300, 428), 'image/jpeg', false],
    ['large.png', patternPng(300, 428), 'image/png', false],
    // Already its own thumbnail: re-encoded too, in its own format.
    ['square.gif', patternGif(144, 144), 'image/gif', false],
    ['square.bmp', patternBmp(100, 100), 'image/bmp', false],
    // A bitmap the decoder cannot read keeps its bytes and type.
    ['broken.bmp', patternBmp(300, 428).subarray(0, 60), 'image/bmp', true],
  ]) {
    const upload = await send('PATCH', column, {
      body: bytes,
      headers: { 'content-type': 'application/octet-stream', 'x-ms-file-name': label },
    });
    assert.equal(upload.response.status, 204, label);
    const whole = await send('GET', `${column}/$value`);
    assert.equal(whole.response.status, 200, label);
    // The portal names no type on a thumbnail (hosted session F2 thumbs: no mimetype, no disposition).
    assert.deepEqual(
      [whole.response.headers.get('mimetype'), whole.response.headers.get('content-disposition')],
      [null, null],
      `${label}: whole thumbnail`,
    );
    assert.equal(whole.bytes.equals(bytes), kept, `${label}: ${kept ? 'stored' : 're-encoded'} bytes`);
    if (!kept) assert.equal(sniff(whole.bytes), stored, `${label}: the re-encoded thumbnail keeps the format`);
    const ranged = await send('GET', `${column}/$value`, { headers: { Range: 'bytes=0-9' } });
    assert.equal(ranged.response.status, 200, label);
    assert.deepEqual(ranged.bytes, whole.bytes, `${label}: Range is ignored`);
    const full = await send('GET', `${column}/$value?size=full`);
    assert.equal(full.response.headers.get('x-ms-file-name'), label, `${label}: a full read names the file`);
    const fullRange = await send('GET', `${column}/$value?size=full`, { headers: { Range: 'bytes=0-9' } });
    assert.deepEqual([fullRange.response.status, fullRange.bytes], [206, bytes.subarray(0, 10)], label);
    const seam = await organizationRead({ portalImage: true });
    assert.equal(seam.body['$content-type'], stored, `${label}: the file seam's thumbnail type`);
    assert.equal(seam.file.mimeType, stored, `${label}: the file seam's file type`);
  }
});
