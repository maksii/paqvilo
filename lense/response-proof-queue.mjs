import { createHash } from 'node:crypto';

/**
 * Network notifications can trail a successful Fetch.fulfillRequest acknowledgement. An acknowledgement waits for
 * the notification of its own request (network ID, frame and full URL), however late it arrives. The count and byte
 * bounds discard the oldest one (`evicted` receives its frame), forget() discards those of a frame whose document was
 * replaced, and clear() discards all.
 */
export function createResponseProofQueue({ requests, admit, evicted }) {
  const pending = new Map();
  let bytes = 0,
    closed = false;
  const remove = (id) => {
    const entry = pending.get(id);
    if (entry) {
      bytes -= entry.bytes;
      pending.delete(id);
    }
    return entry;
  };
  const match = (entry, request) => entry.frameId === request.frameId && entry.urlKey === request.urlKey;
  return {
    async fulfill(event, proof) {
      if (closed || typeof event.networkId !== 'string' || !event.frameId || typeof event.request?.url !== 'string')
        return false;
      const urlKey = createHash('sha256').update(event.request.url).digest('hex');
      const entry = { frameId: event.frameId, urlKey, proof };
      const request = requests.get(event.networkId);
      if (request && match(entry, request)) return admit(request.frameId, request.loaderId, proof, request);
      try {
        entry.bytes = Buffer.byteLength(JSON.stringify(proof));
      } catch {
        return false;
      }
      if (entry.bytes > 8 * 1024 * 1024) return false;
      remove(event.networkId);
      while (pending.size >= 256 || bytes + entry.bytes > 16 * 1024 * 1024) {
        const oldest = remove(pending.keys().next().value);
        if (oldest) evicted?.(oldest.frameId);
      }
      pending.set(event.networkId, entry);
      bytes += entry.bytes;
      return true;
    },
    requested(id, request) {
      const entry = pending.get(id);
      if (closed || !entry || !match(entry, request)) return;
      remove(id);
      Promise.resolve()
        .then(() => (closed ? false : admit(request.frameId, request.loaderId, entry.proof, request)))
        .catch(() => {});
    },
    /** Whether an acknowledgement in `frameId` still waits for its request notification. */
    waiting(frameId) {
      for (const entry of pending.values()) if (entry.frameId === frameId) return true;
      return false;
    },
    forget(frameId) {
      for (const [id, entry] of pending) if (entry.frameId === frameId) remove(id);
    },
    clear() {
      closed = true;
      pending.clear();
      bytes = 0;
    },
  };
}
