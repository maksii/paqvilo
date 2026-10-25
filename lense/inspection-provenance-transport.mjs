import { createDomProvenanceTransport } from './dom-provenance-transport.mjs';
import { createPortalProvenanceTransport } from './portal-provenance-transport.mjs';

/** One response acknowledgement feeds markup and script observations in its actual document. */
export function createInspectionProvenanceTransport(context, configs) {
  const attachments = new WeakMap();
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
    async onAttach(options) {
      const scripts = await dom.onAttach(options);
      attachments.set(options.cdp, scripts);
      let markup;
      try {
        markup = await portal.onAttach(options);
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
