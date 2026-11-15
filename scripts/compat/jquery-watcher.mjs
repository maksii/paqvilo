// Author once; generate standalone adapter fragments with scripts/generate-compat-watchers.mjs.
export function watchJQuery(registry, attach) {
  let watchers = registry.jqueryWatchers;
  if (!watchers) {
    watchers = new Set();
    registry.jqueryWatchers = watchers;
  }
  watchers.add(attach);
  if (registry.jqueryWatched) return;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'jQuery');
  if (descriptor && (descriptor.get || descriptor.set || descriptor.configurable === false)) return;
  let current = globalThis.jQuery;
  try {
    Object.defineProperty(globalThis, 'jQuery', {
      configurable: true,
      enumerable: true,
      get: () => current,
      set: (value) => {
        current = value;
        for (const watcher of registry.jqueryWatchers) {
          try {
            watcher(value);
          } catch (error) {
            console.error(error);
          }
        }
      },
    });
    registry.jqueryWatched = true;
  } catch {
    // A non-configurable global stays a plain property; repeated includes still re-attach.
  }
}
