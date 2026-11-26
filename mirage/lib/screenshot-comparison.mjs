import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

export function comparePngPixels(live, local) {
  const width = Math.max(live.width, local.width);
  const height = Math.max(live.height, local.height);
  const pad = (image) => {
    if (image.width === width && image.height === height) return image;
    const padded = new PNG({ width, height });
    padded.data.fill(255);
    PNG.bitblt(image, padded, 0, 0, image.width, image.height, 0, 0);
    return padded;
  };
  const diff = new PNG({ width, height });
  const differentPixels = pixelmatch(pad(live).data, pad(local).data, diff.data, width, height, {
    threshold: 0,
    includeAA: true,
  });
  return {
    diff,
    differentPixels,
    pixels: {
      width,
      height,
      total: width * height,
      different: differentPixels,
      fraction: differentPixels / (width * height),
    },
  };
}
