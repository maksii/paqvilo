/** Modern captures carry qualification; older caches must at least include languages. */
export function nativeRichTextReady(manifest, profile, origin) {
  const assets = (manifest?.assets ?? []).filter((asset) => !origin || asset.origin === origin);
  const paths = assets.map((asset) => asset.path ?? asset.requestedPath ?? '');
  const core = paths.some((path) => /\/ckeditor\.js(?:\?|$)/i.test(path));
  const qualified = profile?.richTextReadiness;
  if (qualified?.origin && origin && qualified.origin !== origin) return false;
  if (!core || qualified?.nativeReady === false) return false;
  if (qualified?.nativeReady === true) return true;
  return paths.some((path) =>
    /\/ckeditor_latest\/lang\/(?:editor-language-resources|[a-z]{2}(?:-[a-z]{2})?)\.js(?:\?|$)/i.test(path),
  );
}
