/** Explicit online frame providers do not broaden local scripts, API calls or forms. */
export function externalFrameOrigins(value = []) {
  const invalid = () =>
    Object.assign(
      new Error(
        "externalFrameOrigins must contain at most 20 exact HTTPS origins without paths, credentials, queries or fragments.",
      ),
      { status: 400, code: "EXTERNAL_FRAME_ORIGIN_INVALID" },
    );
  if (!Array.isArray(value) || value.length > 20) throw invalid();
  const origins = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry !== entry.trim()) throw invalid();
    let url;
    try {
      url = new URL(entry);
    } catch {
      throw invalid();
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      /[\s;*\\]/.test(entry)
    )
      throw invalid();
    if (!origins.includes(url.origin)) origins.push(url.origin);
  }
  return origins;
}

export function portalContentSecurityPolicy(config = {}) {
  const frames = externalFrameOrigins(config.externalFrameOrigins);
  if (config.externalAssets) return null;
  return (
    "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'self'; frame-src 'self'" +
    (frames.length ? " " + frames.join(" ") : "")
  );
}
