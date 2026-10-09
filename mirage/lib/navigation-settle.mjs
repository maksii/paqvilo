// Navigation and in-flight requests in an observed Chromium page.
//
// A navigation replaces the document whose script writes (XHR/fetch) are still in flight;
// the browser then abandons their responses, and the server may or may not finish them.
// Locally a write can take longer than on the platform, so an acceptance runner lets the
// navigation wait until those writes settle, as when the user acts after the page has
// finished saving. The wait is bounded and recorded; it never drops or alters a request.
//
// Only Document requests are intercepted (CDP Fetch with a Document resource-type pattern).
// Intercepting every request, as Playwright's page.route does, stalls a frame whose
// synchronous XHR is answered with a redirect while a navigation of that frame waits to
// commit; portal pages do issue such requests while they navigate themselves.

const WRITE_TYPES = new Set(["XHR", "Fetch"]);
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const NO_FRAMES = Object.freeze({ loaders: new Map(), detached: new Set() });

/** The CDP fetch pattern that pauses only document (navigation) requests. */
export const DOCUMENT_REQUEST_PATTERN = Object.freeze({
  urlPattern: "*",
  resourceType: "Document",
  requestStage: "Request",
});

/**
 * Whether `frameId` is `ancestor` or lies below it. `parents` maps a frame id to its parent
 * frame id (from CDP Page.frameAttached/frameNavigated events). The frame tree cannot be
 * queried while a document request of the page is paused.
 */
export function withinFrame(frameId, ancestor, parents) {
  const seen = new Set();
  for (let current = frameId; current && !seen.has(current); current = parents.get(current)) {
    if (current === ancestor) return true;
    seen.add(current);
  }
  return false;
}

/**
 * The loader of each frame's current document and the frames that were removed, from CDP
 * Page events ({ event, frameId, loaderId, reason }) in the order observed. A frame detached
 * with reason "swap" moved to another renderer process and continues.
 */
export function frameState(frameEvents) {
  const loaders = new Map();
  const detached = new Set();
  const parents = new Map();
  for (const row of frameEvents) {
    if (row.parentFrameId) parents.set(row.frameId, row.parentFrameId);
    if (row.event === "frameNavigated" && row.loaderId) {
      // A new document replaces the child frames of the one before it; Chromium does not
      // always report their removal.
      if (loaders.has(row.frameId) && loaders.get(row.frameId) !== row.loaderId)
        for (const child of parents.keys()) if (child !== row.frameId && withinFrame(child, row.frameId, parents)) detached.add(child);
      loaders.set(row.frameId, row.loaderId);
      detached.delete(row.frameId);
    } else if (row.event === "frameDetached" && row.reason !== "swap") detached.add(row.frameId);
  }
  return { loaders, detached };
}

/**
 * Whether a CDP Network record ({ frameId, loaderId }) belongs to a document that is still
 * current: a request of a replaced document or of a removed frame can no longer complete in
 * the browser, which may omit its final Network event.
 */
export function ofCurrentDocument(row, { loaders, detached } = NO_FRAMES) {
  if (detached.has(row.frameId)) return false;
  return !row.loaderId || !loaders.has(row.frameId) || loaders.get(row.frameId) === row.loaderId;
}

/**
 * Script writes still in flight in `frameId` or below it, from CDP Network records
 * ({ frameId, loaderId, method, type, path, finishedTimestamp, failure }); `frames` is
 * frameState() of the page.
 */
export function inflightWrites(records, frameId, parents, frames = NO_FRAMES) {
  return records.filter(
    (row) =>
      withinFrame(row.frameId, frameId, parents) &&
      ofCurrentDocument(row, frames) &&
      !READ_METHODS.has(row.method) &&
      WRITE_TYPES.has(row.type) &&
      row.finishedTimestamp === undefined &&
      !row.failure,
  );
}

/**
 * Before a paused Document request of `frameId` continues, wait (at most `timeout` ms) until
 * the writes in flight in that frame and below settle. `records()` returns the current CDP
 * Network records, `parents()` the frame parent map and `frames()` the frameState(). Returns
 * null when none were in flight, else { writes, waitedMs, settled }.
 */
export async function awaitWritesBeforeDocument(frameId, records, parents, { timeout, poll = 50, frames = () => NO_FRAMES }) {
  const pending = () => inflightWrites(records(), frameId, parents(), frames());
  const writes = pending();
  if (!writes.length) return null;
  const started = Date.now();
  while (pending().length && Date.now() - started < timeout)
    await new Promise((resolve) => setTimeout(resolve, poll));
  return {
    writes: writes.map((row) => `${row.method} ${row.path}`),
    waitedMs: Date.now() - started,
    settled: !pending().length,
  };
}

/**
 * Wait until a loaded page's own requests are done: none of the current documents' requests
 * (or a pending navigation) is open and nothing started or ended for `quietMs`. Exported
 * pages chain their load-time work (ready handlers, then anti-forgery token, then reads and
 * writes), so a user acts once the page has finished loading. Event streams never end and
 * `ignore(row)` excludes further records. Bounded by `timeout`; never fails the caller.
 * Returns { waitedMs, settled, pending? }.
 */
export async function awaitNetworkQuiet(records, { frames = () => NO_FRAMES, timeout, quietMs = 500, poll = 50, ignore = () => false }) {
  const started = Date.now();
  let signature = "";
  let changed = started;
  for (;;) {
    const rows = records();
    const state = frames();
    const open = rows.filter(
      (row) =>
        row.type !== "EventSource" &&
        row.finishedTimestamp === undefined &&
        !row.failure &&
        !ignore(row) &&
        (row.type === "Document" ? !state.detached.has(row.frameId) : ofCurrentDocument(row, state)),
    );
    const now = Date.now();
    const current = `${rows.length}:${rows.filter((row) => row.finishedTimestamp !== undefined || row.failure).length}`;
    if (current !== signature) {
      signature = current;
      changed = now;
    }
    if (!open.length && now - changed >= quietMs) return { waitedMs: now - started, settled: true };
    if (now - started >= timeout)
      return { waitedMs: now - started, settled: false, pending: open.map((row) => `${row.method} ${row.path}`) };
    await new Promise((resolve) => setTimeout(resolve, poll));
  }
}
