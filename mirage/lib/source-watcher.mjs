import { watch } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import chokidar from 'chokidar';

/** Windows directory notifications are recursive in the OS. Avoid installing
 * one watcher per exported directory; retain chokidar on other platforms and
 * when a native root cannot be watched (including not-yet-created roots). */
export function watchSources(roots, options = {}) {
  if (process.platform !== 'win32') return chokidar.watch(roots, options);
  const events = new EventEmitter(), monitors = new Map(), pending = new Map(), interests = [];
  let closed = false, fallback, recovery = Promise.resolve();
  const delay = options.awaitWriteFinish?.stabilityThreshold ?? 200;
  const within = (file, base) => { const relative = path.relative(base, file); return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
  const infoOf = async file => { try { return await fs.stat(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } };
  const stamp = info => info && `${info.size}:${info.mtimeMs}`;
  const settle = (file, notification) => {
    notification.timer = setTimeout(async () => {
      try {
        const info = await infoOf(file);
        if (closed || fallback || pending.get(file) !== notification) return;
        if (stamp(info) !== stamp(notification.info)) { notification.info = info; settle(file, notification); return; }
        pending.delete(file);
        events.emit('all', info ? notification.event === 'rename' ? 'add' : 'change' : 'unlink', file);
      } catch (error) { pending.delete(file); if (!closed) events.emit('error', error); }
    }, delay);
  };
  const changed = async (event, file) => {
    if (closed || fallback || !interests.some(root => root.directory ? within(file, root.path) : path.relative(root.path, file) === '')) return;
    const info = await infoOf(file);
    if (closed || fallback || options.ignored?.(file, info)) return;
    // Windows also reports a directory's mtime when a child is written. Only
    // its rename/add/remove notification is a source change; the child event
    // carries the actual file and its output/DATA exclusion rules.
    if (event === 'change' && info?.isDirectory()) return;
    clearTimeout(pending.get(file)?.timer);
    const notification = { info, event }; pending.set(file, notification); settle(file, notification);
  };
  events.close = async () => {
    closed = true; for (const notification of pending.values()) clearTimeout(notification.timer); pending.clear();
    for (const monitor of monitors.values()) { monitor.handle?.close(); monitor.handle = null; }
    await fallback?.close();
  };
  events.nativeWatchCount = () => [...monitors.values()].filter(monitor => monitor.handle).length;
  events.getWatched = () => fallback?.getWatched() ?? {};
  const useFallback = () => {
    for (const monitor of monitors.values()) { monitor.handle?.close(); monitor.handle = null; }
    if (closed || fallback) return;
    for (const notification of pending.values()) clearTimeout(notification.timer); pending.clear();
    fallback = chokidar.watch(roots, options);
    for (const event of ['ready', 'error', 'all']) fallback.on(event, (...args) => { if (!closed) events.emit(event, ...args); });
  };
  const reconcile = async (initial = false) => {
    const replaced = [];
    for (const monitor of monitors.values()) {
      const info = await infoOf(monitor.path);
      if (closed || fallback) return;
      const identity = info && `${info.dev}:${info.ino}:${info.birthtimeMs}`;
      if (monitor.initialized && monitor.identity === identity && (monitor.handle || !info)) continue;
      monitor.handle?.close(); monitor.handle = null; monitor.identity = identity; monitor.initialized = true;
      if (info) {
        const handle = watch(monitor.path, { recursive: monitor.recursive }, (event, name) => {
          if (!name || closed || fallback) return;
          const file = path.resolve(monitor.path, String(name));
          if (monitor.recursive) void changed(event, file).catch(error => { if (!closed) events.emit('error', error); });
          if (event === 'rename' && monitor.children.has(file.toLowerCase())) {
            recovery = recovery.then(() => reconcile()).catch(() => useFallback());
          }
        });
        handle.on('error', () => useFallback()); monitor.handle = handle;
      }
      if (!initial && monitor.recursive) replaced.push(monitor.path);
    }
    // A replacement can already contain its complete export before the new
    // recursive handle attaches. Refresh every affected source root explicitly.
    for (const root of interests) if (replaced.some(base => within(root.path, base))) await changed('rename', root.path);
  };
  void (async () => {
    try {
      const bases = [];
      for (const root of [...new Set(roots.filter(Boolean).map(root => path.resolve(root)))]) {
        const info = await fs.stat(root);
        interests.push({ path: root, directory: info.isDirectory() });
        bases.push(info.isDirectory() ? root : path.dirname(root));
      }
      const unique = [], seen = new Set();
      for (const base of bases) if (!seen.has(base.toLowerCase())) { seen.add(base.toLowerCase()); unique.push(base); }
      for (const base of unique.filter(base => !unique.some(other => other !== base && within(base, other)))) {
        const plan = (file, recursive = false) => {
          const key = file.toLowerCase();
          if (!monitors.has(key)) monitors.set(key, { path: file, recursive, children: new Set(), handle: null });
          const monitor = monitors.get(key); monitor.recursive ||= recursive; return monitor;
        };
        plan(base, true);
        // Native recursive watches follow the old directory when an export root
        // is replaced. Shared nonrecursive ancestor sentinels reattach affected
        // roots, including when a containing directory is replaced. Their count
        // is bounded by source path depth rather than exported directory count.
        let child = base;
        while (path.dirname(child) !== child) {
          const parent = path.dirname(child); plan(parent).children.add(child.toLowerCase()); child = parent;
        }
      }
      // Arm ancestors before descendants so replacement during setup is seen.
      const ordered = [...monitors.entries()].sort(([, left], [, right]) => left.path.length - right.path.length);
      monitors.clear(); for (const [key, monitor] of ordered) monitors.set(key, monitor);
      recovery = reconcile(true); await recovery;
      if (!closed && !fallback) events.emit('ready');
    } catch { useFallback(); }
  })();
  return events;
}
