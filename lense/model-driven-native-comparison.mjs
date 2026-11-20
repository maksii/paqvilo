/** Explicit exact-source comparison. Only the already validated owned app tab executes this reader. */
export async function readModelDrivenNativeSource({ origin, path, token }) {
  if (location.origin !== origin)
    return { ok: false, error: 'The app moved to another address. Try again from the app page.' };
  const controller = new AbortController(),
    limit = 3 * 1024 * 1024;
  const timer = setTimeout(() => controller.abort(), 12000);
  let reader;
  try {
    const url = new URL(path, origin);
    if (url.origin !== origin || url.search || url.hash) return { ok: false, error: 'The source address is invalid.' };
    const response = await fetch(url.href, {
      method: 'GET',
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'x-paqvilo-native-comparison': token },
    });
    if (!response.ok || !response.body?.getReader)
      return { ok: false, error: `The online file could not be read (HTTP ${response.status}).` };
    const mime = response.headers.get('content-type') ?? '';
    // Dataverse answers some web resource reads as text/jscript, a legacy JavaScript type.
    if (!/(?:javascript|ecmascript|jscript|text\/css)/i.test(mime))
      return { ok: false, error: 'The online file is not a script or stylesheet.' };
    reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        return { ok: false, error: 'The online file is larger than 3 MiB and cannot be compared here.' };
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    // Return bounded source text only; never record it in the agent or action event stream.
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), bytes: size };
  } catch {
    return { ok: false, error: 'The online file could not be read. Try again.' };
  } finally {
    clearTimeout(timer);
    reader?.releaseLock();
  }
}
