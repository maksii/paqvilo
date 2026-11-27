import { createDomProvenanceTransport } from './dom-provenance-transport.mjs';
import { createPortalProvenanceTransport } from './portal-provenance-transport.mjs';

/** One response acknowledgement feeds markup and script observations in its actual document. */
export function createInspectionProvenanceTransport(context, configs) {
  const attachments = new WeakMap();
  // The markup attachments of each tab (its own target and its out-of-process frames'), for Inspect's closed shadow
  // roots (admitSealed).
  const markupByPage = new WeakMap();
  const admitSealedIn = async (page, roots, frameId) => {
    // Each attachment answers only for a document of its own target.
    for (const markup of Array.from(markupByPage.get(page) ?? []))
      if (await markup.admitSealed?.(roots, frameId)) return true;
    return false;
  };
  const dom = createDomProvenanceTransport(context, configs);
  const portal = createPortalProvenanceTransport(context, configs, {
    domProvenanceSlot: dom.slot,
    onDescriptor({ cdp, frameId, loaderId, proof, request }) {
      return attachments.get(cdp)?.publishDescriptor(frameId, loaderId, proof, request);
    },
  });
  return {
    slot: portal.slot,
    domSlot: dom.slot,
    // `(origin, (route) => portal source index)`: parsed scripts of that origin are admitted by content hash against
    // the export (dom-provenance-transport.mjs registerScriptSources).
    registerScriptSources: dom.registerScriptSources,
    /**
     * Hands closed shadow roots (backend node ids) of `page`'s document, or of its frame `frameId`, to that document's
     * registry; false when it has none.
     */
    admitSealed: (page, roots, frameId = null) => admitSealedIn(page, roots, frameId),
    async onAttach(options) {
      const scripts = await dom.onAttach(options);
      attachments.set(options.cdp, scripts);
      let markup;
      try {
        markup = await portal.onAttach(options);
        if (options.page) {
          if (!markupByPage.has(options.page)) markupByPage.set(options.page, new Set());
          markupByPage.get(options.page).add(markup);
        }
      } catch (error) {
        attachments.delete(options.cdp);
        await scripts.dispose();
        throw error;
      }
      return {
        async publishProvenance(event, proof) {
          return proof?.channel === 'lense-script-resource'
            ? scripts.publishProvenance(event, proof)
            : markup.publishProvenance(event, proof);
        },
        async dispose() {
          attachments.delete(options.cdp);
          markupByPage.get(options.page)?.delete(markup);
          try {
            await scripts.dispose();
          } finally {
            await markup.dispose();
          }
        },
      };
    },
  };
}
