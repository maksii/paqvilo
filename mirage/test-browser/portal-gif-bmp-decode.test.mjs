// @test-kind compatibility: GIF89a and Windows bitmap decoding as an independent decoder (Chromium's) reads them; the portal GIF and BMP thumbnails must equal the documented crop of Chromium's pixels on invented fixtures
// Chromium decodes each fixture written by mirage/test/fixtures/gif-bmp-images.mjs; the thumbnail of its pixels (the
// PNG thumbnail's crop, alpha on white, quality 90 JPEG) must match what mirage/lib/portal-image-formats.mjs returns.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { decodeJpeg } from '../lib/portal-jpeg-codec.mjs';
import { bmpThumbnail, gifThumbnail } from '../lib/portal-image-formats.mjs';
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
  indexAt,
  patternGif,
  pick,
} from '../test/fixtures/gif-bmp-images.mjs';

let browser, page;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  page = await browser.newPage();
  await page.setContent('<!doctype html><title>decode</title>');
});
after(() => browser?.close());

/** Chromium's RGBA pixels of an image, without color management or premultiplied alpha. */
async function chromiumPixels(bytes, type) {
  const { width, height, rgba } = await page.evaluate(
    async ({ base64, type }) => {
      const blob = new Blob([Uint8Array.from(atob(base64), (c) => c.codePointAt(0))], { type });
      const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      return {
        width: bitmap.width,
        height: bitmap.height,
        rgba: [...context.getImageData(0, 0, bitmap.width, bitmap.height).data],
      };
    },
    { base64: Buffer.from(bytes).toString('base64'), type },
  );
  return { width, height, rgba: Uint8Array.from(rgba) };
}

/**
 * Our thumbnail equals the thumbnail of Chromium's pixels. A 2D canvas stores premultiplied alpha, so partially
 * transparent pixels may come back a level off; those fixtures compare the decoded thumbnails within `tolerance`.
 */
async function agrees(thumbnail, bytes, type, label, tolerance = 0) {
  const { width, height, rgba } = await chromiumPixels(bytes, type);
  const theirs = expectedThumbnail(rgba, width, height);
  const ours = thumbnail(bytes);
  assert.notEqual(ours, bytes, `${label}: a thumbnail is made`);
  if (!tolerance) return assert.deepEqual(ours, theirs, label);
  const [a, b] = [decodeJpeg(ours), decodeJpeg(theirs)];
  assert.deepEqual([a.width, a.height], [b.width, b.height], label);
  const worst = a.data.reduce((max, value, i) => Math.max(max, Math.abs(value - b.data[i])), 0);
  assert.ok(worst <= tolerance, `${label}: max difference ${worst}`);
}

test('Chromium decodes the GIF fixtures to the pixels the GIF thumbnail uses', async () => {
  const noise = (x, y) => (Math.imul(x + 1, 2654435761) ^ Math.imul(y + 1, 40503)) >>> 24;
  const fixtures = {
    plain: patternGif(37, 50),
    interlaced: patternGif(37, 50, { interlace: true }),
    'interlaced, 5 rows': patternGif(160, 5, { interlace: true }),
    transparent: patternGif(60, 90, { transparent: indexAt(30, 45) }),
    'local color table': patternGif(37, 50, { local: true }),
    GIF87a: patternGif(37, 50, { version: '87a' }),
    'first of two frames': patternGif(37, 50, { second: 3 }),
    'frame inside the screen': gif({
      width: 50,
      height: 70,
      palette: PALETTE,
      pixel: indexAt,
      frame: { left: 10, top: 20, width: 30, height: 40 },
    }),
    'full table with clear codes': gif({ width: 300, height: 200, palette: PALETTE, pixel: noise }),
    'full table with deferred clear': gif({
      width: 300,
      height: 200,
      palette: PALETTE,
      pixel: noise,
      deferClear: true,
    }),
    'code size 8 with two colors': gif({
      width: 37,
      height: 50,
      palette: SIXTEEN.slice(0, 2),
      pixel: (x, y) => pick(x, y, 2),
      minimum: 8,
    }),
  };
  for (const [label, bytes] of Object.entries(fixtures)) await agrees(gifThumbnail, bytes, 'image/gif', label);
});

// Bitmaps with alpha samples between 0 and 255.
const PARTIAL_ALPHA = new Set([
  '32-bit V5 BI_BITFIELDS with an alpha mask',
  '32-bit BI_ALPHABITFIELDS after a 40-byte header',
]);

test('Chromium decodes the BMP fixtures to the pixels the BMP thumbnail uses', async () => {
  for (const [label, spec] of Object.entries(BITMAPS)) {
    await agrees(bmpThumbnail, bitmapOf(spec, 23, 31), 'image/bmp', label, PARTIAL_ALPHA.has(label) ? 3 : 0);
  }
  const runs = { width: 12, height: 8, palette: RUN_PALETTE, used: 10 };
  await agrees(bmpThumbnail, bmp({ ...runs, depth: 8, compression: 1, rle: RLE8 }), 'image/bmp', 'RLE8');
  await agrees(bmpThumbnail, bmp({ ...runs, depth: 4, compression: 2, rle: RLE4 }), 'image/bmp', 'RLE4');
  const endless = Array.from({ length: runs.height }, () => [2, 5, 0, 0]).flat();
  await agrees(
    bmpThumbnail,
    bmp({ ...runs, depth: 8, compression: 1, rle: endless }),
    'image/bmp',
    'RLE8 without an end escape',
  );
});
