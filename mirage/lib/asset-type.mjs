/** Classify browser assets by their served MIME type; extensions are a fallback only. */
export function assetKind(contentType, file = '') {
  const type = String(contentType ?? '').split(';', 1)[0].trim().toLowerCase();
  if (type) {
    if (type === 'text/css') return 'stylesheet';
    if (['text/javascript', 'application/javascript', 'application/x-javascript', 'text/ecmascript', 'application/ecmascript'].includes(type)) return 'script';
    return type.startsWith('image/') ? 'image' : 'asset';
  }
  const pathname = String(file).split(/[?#]/, 1)[0];
  if (/\.css$/i.test(pathname)) return 'stylesheet';
  if (/\.[cm]?js$/i.test(pathname)) return 'script';
  return /\.(?:png|jpe?g|gif|svg|webp|avif|ico)$/i.test(pathname) ? 'image' : 'asset';
}
