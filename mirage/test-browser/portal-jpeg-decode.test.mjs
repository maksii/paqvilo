// @test-kind compatibility: ITU-T T.81 baseline JPEG and Exif orientation as an independent decoder (Chromium's) reads them; the portal JPEG codec must agree with it on invented pixels both ways
// Chromium decodes JPEGs written by mirage/lib/portal-jpeg-codec.mjs, the codec decodes JPEGs written by Chromium's
// canvas encoder, and the Exif orientation model matches Chromium's from-image orientation.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { decodeJpeg, encodeJpeg } from '../lib/portal-jpeg-codec.mjs';
import { jpegThumbnail } from '../lib/portal-jpeg.mjs';

let browser, page;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  page = await browser.newPage();
  await page.setContent('<!doctype html><title>decode</title>');
});
after(() => browser?.close());

/** Chromium's RGB pixels of a JPEG, with its Exif orientation applied or ignored. */
async function chromiumPixels(bytes, imageOrientation = 'none') {
  return page.evaluate(
    async ({ base64, imageOrientation }) => {
      const blob = new Blob([Uint8Array.from(atob(base64), (c) => c.codePointAt(0))], { type: 'image/jpeg' });
      const bitmap = await createImageBitmap(blob, { imageOrientation, colorSpaceConversion: 'none' });
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
      const rgb = [];
      for (let i = 0; i < data.length; i += 4) rgb.push(data[i], data[i + 1], data[i + 2]);
      return { width: bitmap.width, height: bitmap.height, rgb };
    },
    { base64: Buffer.from(bytes).toString('base64'), imageOrientation },
  );
}

function rgbOf(decoded) {
  if (decoded.channels === 3) return [...decoded.data];
  return [...decoded.data].flatMap((value) => [value, value, value]);
}

// max and mean bound the per-sample difference; outliers bounds the share of samples that differ by more than 8.
function compare(ours, theirs, { max, mean, outliers = 0 }, label) {
  assert.deepEqual([ours.width, ours.height], [theirs.width, theirs.height], label);
  const mine = rgbOf(ours);
  let worst = 0;
  let sum = 0;
  let far = 0;
  for (let i = 0; i < mine.length; i++) {
    const delta = Math.abs(mine[i] - theirs.rgb[i]);
    worst = Math.max(worst, delta);
    sum += delta;
    if (delta > 8) far++;
  }
  const summary = `${label}: max ${worst}, mean ${(sum / mine.length).toFixed(3)}, outliers ${(far / mine.length).toFixed(4)}`;
  if (process.env.PAQVILO_JPEG_METRICS) console.log(summary);
  assert.ok(worst <= max && sum / mine.length <= mean && far / mine.length <= outliers, summary);
}

function gradient(width, height, channels) {
  const data = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const rgb = [
        Math.round(40 + (170 * x) / width),
        Math.round(220 - (150 * y) / height),
        Math.round(120 + 70 * Math.sin((x + 2 * y) / 30)),
      ];
      data.set(rgb.slice(0, channels), (y * width + x) * channels);
    }
  return { width, height, channels, data };
}

test('Chromium decodes the codec output like the codec does', async () => {
  for (const [label, channels, options] of [
    ['grayscale', 1, {}],
    ['4:4:4', 3, { sampling: { h: 1, v: 1 } }],
    ['4:2:2', 3, { sampling: { h: 2, v: 1 } }],
    ['4:4:0', 3, { sampling: { h: 1, v: 2 } }],
    ['4:2:0', 3, { sampling: { h: 2, v: 2 } }],
    ['4:2:0 with restarts', 3, { sampling: { h: 2, v: 2 }, restartInterval: 3 }],
  ]) {
    const bytes = encodeJpeg(gradient(101, 67, channels), options);
    // Chromium upsamples chroma with libjpeg's triangle filter, the codec replicates samples: subsampled images differ a little.
    const subsampled = channels === 3 && (options.sampling.h > 1 || options.sampling.v > 1);
    compare(
      decodeJpeg(bytes),
      await chromiumPixels(bytes),
      subsampled ? { max: 8, mean: 1.5 } : { max: 3, mean: 0.6 },
      label,
    );
  }
});

test('the codec decodes Chromium canvas JPEGs like Chromium does', async () => {
  for (const quality of [0.5, 0.92]) {
    const base64 = await page.evaluate((quality) => {
      const canvas = document.createElement('canvas');
      canvas.width = 157;
      canvas.height = 93;
      const context = canvas.getContext('2d');
      const fill = context.createLinearGradient(0, 0, 157, 93);
      fill.addColorStop(0, '#2050c0');
      fill.addColorStop(0.5, '#e0c040');
      fill.addColorStop(1, '#30a060');
      context.fillStyle = fill;
      context.fillRect(0, 0, 157, 93);
      context.fillStyle = '#ffffff';
      context.fillRect(40, 30, 50, 20);
      return canvas.toDataURL('image/jpeg', quality).split(',')[1];
    }, quality);
    const bytes = Buffer.from(base64, 'base64');
    const ours = decodeJpeg(bytes);
    assert.ok(ours, `quality ${quality}: the codec decodes Chromium's baseline JPEG`);
    // Chromium writes 4:2:0: only the hard edges of the white rectangle, where triangle and replicated chroma upsampling
    // differ, may be far apart.
    compare(ours, await chromiumPixels(bytes), { max: 64, mean: 1.5, outliers: 0.02 }, `Chromium quality ${quality}`);
  }
});

// The centered square of Chromium's pixels, by the nearest-sample rule of the portal thumbnails, at the image's own size.
function centerSquare({ width, height, rgb }) {
  const side = Math.min(width, height);
  const [insetX, insetY] = [(width - side) / 2, (height - side) / 2];
  const square = [];
  for (let y = 0; y < side; y++)
    for (let x = 0; x < side; x++) {
      const at = ((insetY + y) * width + insetX + x) * 3;
      square.push(rgb[at], rgb[at + 1], rgb[at + 2]);
    }
  return { width: side, height: side, rgb: square };
}

test('the JPEG thumbnail matches Chromium from-image orientation for every Exif orientation', async () => {
  const plain = encodeJpeg(gradient(48, 30, 3), { sampling: { h: 1, v: 1 }, quality: 95 });
  for (let orientation = 2; orientation <= 8; orientation++) {
    const tiff = Buffer.from('49492a0008000000010012010300010000000000000000000000', 'hex');
    tiff.writeUInt16LE(orientation, 18);
    const exif = Buffer.concat([Buffer.from([0xff, 0xe1, 0, 0]), Buffer.from('Exif\0\0', 'binary'), tiff]);
    exif.writeUInt16BE(exif.length - 2, 2);
    const tagged = Buffer.concat([plain.subarray(0, 2), exif, plain.subarray(2)]);
    const upright = centerSquare(await chromiumPixels(tagged, 'from-image'));
    // The thumbnail is re-encoded at quality 75 with 4:2:0 chroma (max 11, mean 2.1 and 0.4% outliers on this host);
    // a wrong orientation moves the gradient by tens of levels on average.
    compare(
      decodeJpeg(jpegThumbnail(tagged)),
      upright,
      { max: 16, mean: 3, outliers: 0.01 },
      `orientation ${orientation}`,
    );
  }
});
