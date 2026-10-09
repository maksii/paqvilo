// A navigation to the current fragment URL can stay in the same document. Force a fresh GET
// only in that case, preserving the route, other query parameters and fragment position.
let revision = 0;
export function refreshUrl(address) {
  const url = new URL(address);
  if (url.href.includes('#')) url.searchParams.set('paqvilo', `${Date.now().toString(36)}-${++revision}`);
  return url.href;
}
