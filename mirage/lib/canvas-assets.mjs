// Assets are private symbol properties: object spreads preserve them, JSON never emits bytes.
export const CANVAS_ASSETS = Symbol.for('paqvilo.canvas.assets');
const TYPES = Object.freeze({
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
});
export const CANVAS_ASSET_MAX_BYTES = 8 * 1024 * 1024;
export const CANVAS_ASSET_TOTAL_BYTES = 32 * 1024 * 1024;
export function canvasAssetName(path) {
  const match = /^Assets\/((?:Images\/)?[^/\\]+)$/i.exec(path);
  if (!match || !/^(?:Images\/)?[\p{L}\p{N}_ .-]+$/u.test(match[1]) || /[. ]$/.test(match[1])) return null;
  const dot = match[1].lastIndexOf('.');
  const type = TYPES[match[1].slice(dot + 1).toLowerCase()];
  return dot > 0 && type ? { name: match[1], type } : null;
}
export function canvasAssetUrls(app, assets) {
  return Object.fromEntries(
    [...assets.keys()].map((name) => [
      name,
      `/_apps/canvas/${encodeURIComponent(app)}/assets/${encodeURIComponent(name)}`,
    ]),
  );
}
