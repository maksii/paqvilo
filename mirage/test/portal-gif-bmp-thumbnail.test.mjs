// Portal GIF and BMP image thumbnails (mirage/lib/portal-image-formats.mjs): the bounded first-frame GIF decoder and
// the Windows bitmap decoder, the documented center crop shared with PNG and JPEG, the JPEG thumbnail encoding and the
// portal image route end to end. Fixtures are invented pixels written by mirage/test/fixtures/gif-bmp-images.mjs;
// Chromium decodes the same fixtures in mirage/test-browser/portal-gif-bmp-decode.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decodeJpeg, encodeJpeg } from '../lib/portal-jpeg-codec.mjs';
import { PNG } from 'pngjs';
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
  expectedThumbnail,
  gif,
  gifExtension,
  indexAt,
  opaque,
  patternBmp,
  patternGif,
  patternRgba,
  pick,
  rgbaImage,
  rgbaOf,
} from './fixtures/gif-bmp-images.mjs';

const sizeOf = (jpeg) => {
  const decoded = decodeJpeg(jpeg);
  return [decoded.width, decoded.height];
};

// @test-kind compatibility: Microsoft Learn "Use image column data", section "Resize rules for thumbnail-sized images" (a side over 144 px crops on center to 144x144; otherwise square to the smaller side; examples 300x428 -> 144x144 and 91x130 -> 91x91); GIF and BMP sample the same source pixels as the PNG thumbnail
test('GIF and BMP thumbnails follow the documented crop rule and pick the PNG thumbnail pixels', () => {
  for (const [width, height, edge] of [
    [300, 428, 144],
    [91, 130, 91],
    [100, 300, 144],
    [143, 40, 40],
    [145, 12, 144],
  ]) {
    const expected = expectedThumbnail(patternRgba(width, height), width, height);
    for (const [label, thumbnail] of [
      ['GIF', gifThumbnail(patternGif(width, height))],
      ['BMP', bmpThumbnail(patternBmp(width, height))],
    ]) {
      assert.deepEqual(sizeOf(thumbnail), [edge, edge], `${label} ${width}x${height}`);
      assert.deepEqual(thumbnail, expected, `${label} ${width}x${height} samples the PNG thumbnail pixels`);
    }
  }
  for (const [width, height] of [
    [144, 144],
    [91, 91],
  ]) {
    const asGif = patternGif(width, height);
    const asBmp = patternBmp(width, height);
    assert.equal(gifThumbnail(asGif), asGif, `a ${width}x${height} GIF keeps its bytes, as PNG and JPEG do`);
    assert.equal(bmpThumbnail(asBmp), asBmp, `a ${width}x${height} BMP keeps its bytes, as PNG and JPEG do`);
  }
});

// @test-kind compatibility+unproven: Microsoft Learn "Types of columns" (image columns) says uploaded images are converted to .jpg and an animated GIF keeps its first frame; baseline JFIF at quality 90 like the JPEG thumbnail and transparent pixels composited on white are local choices without a hosted capture
test('GIF and BMP thumbnails are baseline JFIF JPEGs with transparency composited on white', () => {
  const transparentGif = patternGif(60, 90, { transparent: indexAt(30, 45) });
  for (const thumbnail of [gifThumbnail(transparentGif), bmpThumbnail(patternBmp(60, 90))]) {
    assert.deepEqual([...thumbnail.subarray(0, 4)], [0xff, 0xd8, 0xff, 0xe0]);
    assert.equal(thumbnail.toString('latin1', 6, 11), 'JFIF\0');
  }
  const hole = indexAt(30, 45);
  const withHole = rgbaImage(60, 90, (x, y) =>
    indexAt(x, y) === hole ? [0, 0, 0, 0] : opaque(PALETTE, indexAt(x, y)),
  );
  assert.deepEqual(gifThumbnail(transparentGif), expectedThumbnail(withHole, 60, 90));
  const clear = gif({ width: 40, height: 60, palette: [[10, 20, 30]], pixel: () => 0, transparent: 0 });
  const white = decodeJpeg(gifThumbnail(clear));
  assert.ok(
    white.data.every((value) => value >= 253),
    'a fully transparent frame is white',
  );
});

// @test-kind compatibility: W3C GIF89a specification (logical screen, global and local color tables, graphic control transparency, interlaced rows in four passes, variable-length LZW codes up to 12 bits with clear and end codes, extension blocks); the first frame is the thumbnail source as Learn "Types of columns" says for animated GIFs
test('the GIF decoder reads interlaced, transparent, local-palette, offset and multi-frame streams', () => {
  const [width, height] = [37, 50];
  const expected = expectedThumbnail(patternRgba(width, height), width, height);
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
  for (const [name, bytes] of Object.entries(variants)) assert.deepEqual(gifThumbnail(bytes), expected, name);
  const two = SIXTEEN.slice(0, 2);
  const twoColors = (x, y) => pick(x, y, 2);
  assert.deepEqual(
    gifThumbnail(gif({ width, height, palette: two, pixel: twoColors, minimum: 8 })),
    expectedThumbnail(
      rgbaImage(width, height, (x, y) => opaque(two, twoColors(x, y))),
      width,
      height,
    ),
    'a two-colour frame with code size 8',
  );

  // Interlacing with fewer rows than a pass: every row still lands where it belongs.
  for (const rows of [1, 2, 3, 5, 9])
    assert.deepEqual(
      gifThumbnail(patternGif(160, rows, { interlace: true })),
      expectedThumbnail(patternRgba(160, rows), 160, rows),
      `${rows} interlaced rows`,
    );

  // Noise fills the 4096-entry table: once with clear codes, once with the deferred clear of a full table.
  const noise = (x, y) => (Math.imul(x + 1, 2654435761) ^ Math.imul(y + 1, 40503)) >>> 24;
  const noisy = rgbaImage(300, 200, (x, y) => opaque(PALETTE, noise(x, y)));
  for (const deferClear of [false, true])
    assert.deepEqual(
      gifThumbnail(gif({ width: 300, height: 200, palette: PALETTE, pixel: noise, deferClear })),
      expectedThumbnail(noisy, 300, 200),
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
  assert.deepEqual(gifThumbnail(inner), expectedThumbnail(innerRgba, 50, 70), 'frame offset and clipping');

  // Indices past a 4-entry color table (code size 3 carries 0..7) leave the screen transparent.
  const small = [
    [200, 10, 10],
    [10, 200, 10],
    [10, 10, 200],
    [240, 240, 20],
  ];
  const past = gif({ width: 30, height: 20, palette: small, pixel: (x, y) => (x + y) & 7, minimum: 3 });
  const pastRgba = rgbaImage(30, 20, (x, y) => opaque(small, (x + y) & 7));
  assert.deepEqual(gifThumbnail(past), expectedThumbnail(pastRgba, 30, 20), 'indices past the color table');
});

// @test-kind compatibility: Win32 BITMAPFILEHEADER, BITMAPINFOHEADER, BITMAPV4HEADER and BITMAPV5HEADER (biHeight sign for bottom-up and top-down rows, 4-byte row padding, 1/4/8-bit color tables with biClrUsed, BI_RGB 16-bit 5-5-5 and 32-bit defaults, BI_BITFIELDS and BI_ALPHABITFIELDS masks); the 8-bit scaling of narrow masks and the all-zero alpha rule match Chromium in mirage/test-browser/portal-gif-bmp-decode.test.mjs
test('the BMP decoder reads every bit depth, row order and bit-field layout', () => {
  const [width, height] = [23, 31];
  for (const [name, spec] of Object.entries(BITMAPS))
    assert.deepEqual(
      bmpThumbnail(bitmapOf(spec, width, height)),
      expectedThumbnail(rgbaOf(spec, width, height), width, height),
      name,
    );
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
  assert.deepEqual(bmpThumbnail(rle8), expectedThumbnail(rows8, width, height), 'RLE8');
  const rle4 = bmp({ width, height, depth: 4, compression: 2, palette: RUN_PALETTE, used: 10, rle: RLE4 });
  const rows4 = runRgba(width, height, [
    [0, 0, [1, 2, 1, 2, 3, 4, 5, 6, 7]],
    [1, 0, [8, 9, 8, 9, 8, 9, 8]],
  ]);
  assert.deepEqual(bmpThumbnail(rle4), expectedThumbnail(rows4, width, height), 'RLE4');
  // Runs that end every row without an end-of-bitmap escape still describe the whole bitmap.
  const rows = Array.from({ length: height }, () => [2, 5, 0, 0]).flat();
  const endless = bmp({ width, height, depth: 8, compression: 1, palette: RUN_PALETTE, used: 10, rle: rows });
  const allRows = runRgba(
    width,
    height,
    Array.from({ length: height }, (_, row) => [row, 0, [5, 5]]),
  );
  assert.deepEqual(bmpThumbnail(endless), expectedThumbnail(allRows, width, height), 'RLE8 without an end escape');
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

  // Deterministic mutation fuzzing: a result is the original bytes or a JPEG thumbnail, and nothing throws.
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
    assert.ok(result === mutated || decodeJpeg(result), `round ${round}`);
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

// @test-kind compatibility+unproven: geometry follows Microsoft Learn "Use image column data" resize rules and "Types of columns" (.jpg conversion, first GIF frame); the JPEG encoding, quality and white background are local choices without a hosted capture
test('the portal GIF and BMP image routes serve documented thumbnails while full and organization reads keep the stored bytes', async (t) => {
  const { send, organizationRead } = await portalWithImages(t);
  const column = `x_badges(${IDS.record})/x_picture`;
  for (const [label, mime, original, small] of [
    ['fixture.gif', 'image/gif', patternGif(300, 428, { interlace: true }), patternGif(91, 130)],
    ['fixture.bmp', 'image/bmp', patternBmp(300, 428), patternBmp(91, 130)],
  ]) {
    const upload = (bytes) =>
      send('PATCH', column, {
        body: bytes,
        headers: { 'content-type': 'application/octet-stream', 'x-ms-file-name': label },
      });
    assert.equal((await upload(original)).response.status, 204, label);

    const full = await send('GET', `${column}/$value?size=full`);
    assert.deepEqual([full.response.status, full.response.headers.get('mimetype')], [200, mime], label);
    assert.deepEqual(full.bytes, original, `${label}: the full image is the stored bytes`);

    const expected = expectedThumbnail(patternRgba(300, 428), 300, 428);
    const whole = await send('GET', `${column}/$value`);
    assert.deepEqual(whole.bytes, expected, `${label}: the default read is the thumbnail`);
    const head = await send('GET', `${column}/$value`, { headers: { Range: 'bytes=0-99' } });
    const tail = await send('GET', `${column}/$value`, { headers: { Range: `bytes=100-${expected.length + 50}` } });
    assert.equal(head.response.status, 206);
    assert.equal(head.response.headers.get('content-range'), `bytes 0-99/${expected.length}`);
    assert.equal(tail.response.headers.get('content-range'), `bytes 100-${expected.length - 1}/${expected.length}`);
    assert.deepEqual(Buffer.concat([head.bytes, tail.bytes]), expected, `${label}: ranged reads agree`);
    const record = JSON.parse((await send('GET', `x_badges(${IDS.record})?$select=x_picture`)).bytes);
    assert.deepEqual(Buffer.from(record.x_picture, 'base64'), expected, `${label}: the record field is the thumbnail`);
    assert.deepEqual(await organizationRead(), original, `${label}: organization reads are unchanged`);

    assert.equal((await upload(small)).response.status, 204);
    assert.deepEqual(sizeOf((await send('GET', `${column}/$value`)).bytes), [91, 91], `${label} 91x130`);
  }
});

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

// @test-kind contract: every thumbnail read names the type of the bytes it serves (mimetype header and the file seam's $content-type): the format a thumbnail was re-encoded to, the stored type when the stored bytes are served; whether native PNG thumbnails are also converted to JPEG awaits a hosted capture
test('full, ranged and seam thumbnail reads name the type of the bytes served, re-encoded or kept', async (t) => {
  const { send, organizationRead } = await portalWithImages(t);
  const column = `x_badges(${IDS.record})/x_picture`;
  for (const [label, bytes, stored, served, kept] of [
    ['large.gif', patternGif(300, 428), 'image/gif', 'image/jpeg', false],
    ['large.bmp', patternBmp(300, 428), 'image/bmp', 'image/jpeg', false],
    ['large.jpg', patternJpeg(300, 428), 'image/jpeg', 'image/jpeg', false],
    ['large.png', patternPng(300, 428), 'image/png', 'image/png', false],
    // Already its own thumbnail: the stored bytes and type are served.
    ['square.gif', patternGif(144, 144), 'image/gif', 'image/gif', true],
    ['square.bmp', patternBmp(100, 100), 'image/bmp', 'image/bmp', true],
    // A bitmap the decoder cannot read keeps its bytes and type.
    ['broken.bmp', patternBmp(300, 428).subarray(0, 60), 'image/bmp', 'image/bmp', true],
  ]) {
    const upload = await send('PATCH', column, {
      body: bytes,
      headers: { 'content-type': 'application/octet-stream', 'x-ms-file-name': label },
    });
    assert.equal(upload.response.status, 204, label);
    const whole = await send('GET', `${column}/$value`);
    assert.equal(whole.response.status, 200, label);
    assert.equal(whole.response.headers.get('mimetype'), served, `${label}: whole thumbnail`);
    assert.equal(whole.bytes.equals(bytes), kept, `${label}: ${kept ? 'stored' : 're-encoded'} bytes`);
    const ranged = await send('GET', `${column}/$value`, { headers: { Range: 'bytes=0-9' } });
    assert.equal(ranged.response.status, 206, label);
    assert.equal(ranged.response.headers.get('mimetype'), served, `${label}: ranged thumbnail`);
    assert.deepEqual(ranged.bytes, whole.bytes.subarray(0, 10), `${label}: the range is of the served bytes`);
    const full = await send('GET', `${column}/$value?size=full`);
    assert.equal(full.response.headers.get('mimetype'), stored, `${label}: a full read names the stored type`);
    const fullRange = await send('GET', `${column}/$value?size=full`, { headers: { Range: 'bytes=0-9' } });
    assert.equal(fullRange.response.headers.get('mimetype'), stored, `${label}: a full ranged read`);
    const seam = await organizationRead({ portalImage: true });
    assert.equal(seam.body['$content-type'], served, `${label}: the file seam's thumbnail type`);
    assert.equal(seam.file.mimeType, served, `${label}: the file seam's file type`);
  }
});
