import { renderCanvasPcfControl } from './model-driven/pcf-runtime.mjs';

// Instances survive snapshot redraws; absent controls are explicitly destroyed after a complete render.
const instances = new Map();
let seen = new Set();
window.paqviloCanvasPcf = {
  begin() {
    seen = new Set();
  },
  mount(key, definition, properties, onOutputs) {
    seen.add(key);
    let entry = instances.get(key);
    const fingerprint = JSON.stringify(definition);
    if (entry && entry.fingerprint !== fingerprint) {
      entry.host.destroy();
      instances.delete(key);
      entry = null;
    }
    if (!entry) {
      entry = { fingerprint, onOutputs };
      entry.host = renderCanvasPcfControl(definition, properties, {
        onOutputs: (outputs) => entry.onOutputs(outputs),
        onEvent: (name) => entry.onOutputs({}, name),
      });
      instances.set(key, entry);
    } else {
      entry.onOutputs = onOutputs;
      entry.host.update(properties);
    }
    return entry.host.element;
  },
  end() {
    for (const [key, entry] of instances)
      if (!seen.has(key)) {
        entry.host.destroy();
        instances.delete(key);
      }
  },
  inspect() {
    return [...instances].map(([key, entry]) => ({ key, ...entry.host.inspect() }));
  },
};
window.addEventListener('pagehide', () => {
  for (const entry of instances.values()) entry.host.destroy();
  instances.clear();
});
