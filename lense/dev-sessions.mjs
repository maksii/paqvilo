// One browser can visit many configured origins. Each gets its own sources, baseline and controls,
// but interception is installed once per tab so CDP handlers cannot race to answer one request.
import { OverlaySession } from './session.mjs';
import { interceptOrigins } from './intercept.mjs';
import { enablePanel } from './panel.mjs';
import { startAgentServer } from './agent-server.mjs';
import { watchSources, trackOnlineState, logHits, printSummary } from './commands/dev.mjs';
import { isExtract } from './config.mjs';
import { GitBaseline } from './git.mjs';
import { compareWebFile } from './online.mjs';

export async function startDevSessions(context, selection, { args = {}, attached = false, stop = () => {}, debugPort = null, log = console.log } = {}) {
  const { mode, initial, targets } = selection;
  const configs = new Map(targets.map((cfg) => [cfg.origin, cfg]));
  if (!configs.size || configs.size !== targets.length || !configs.has(initial.origin)) throw new Error('Development targets must have unique origins and include the start portal');
  const devTargets = targets.map((cfg) => ({ siteName: cfg.siteName, envName: cfg.envName, origin: cfg.origin, startPath: cfg.site.startPath, caution: cfg.caution }));
  const active = new Map();
  const pending = new Map();
  const failedAt = new Map();
  const records = new Set();
  let closed = false;
  let detach;
  let closing;
  let failure;

  const dispose = (record) => record.closing ??= (async () => {
    record.stopComparisons?.();
    record.stopLogs?.();
    // Each teardown runs even if another resource has already lost its browser connection.
    await Promise.allSettled([record.agent?.close(), record.panel?.dispose(), record.watcher?.close()]);
    record.session.removeAllListeners();
    if (active.get(record.session.cfg.origin) === record) active.delete(record.session.cfg.origin);
    records.delete(record);
  })();

  const ensure = (origin) => {
    if (closed) return Promise.reject(new Error('Development browser is stopping'));
    if (!configs.has(origin)) return Promise.reject(new Error('Portal is not configured for this browser'));
    // A temporarily missing checkout can be restored during the working day. Bound retries
    // instead of poisoning the target permanently or rebuilding for every asset request.
    if (failedAt.has(origin) && Date.now() - failedAt.get(origin) >= 5000) {
      pending.delete(origin);
      failedAt.delete(origin);
    }
    if (!pending.has(origin)) {
      const initializing = (async () => {
        const cfg = { ...configs.get(origin), devTargets };
        if (!isExtract(cfg.sourceDir)) throw new Error(`Portal extract not found: ${cfg.sourceDir}. Restore the checkout and reload this portal; other portal sessions remain active.`);
        // Default HEAD means the state at session start. Committing during the working day
        // must not erase active template/snippet patches. Explicit branch refs remain dynamic.
        if (cfg.site.markup?.baseline === 'HEAD') {
          const baseline = new GitBaseline(cfg.sourceDir, 'HEAD');
          if (baseline.available && baseline.commit) cfg.site = { ...cfg.site, markup: { ...cfg.site.markup, baseline: baseline.commit, requestedBaseline: 'HEAD' } };
        }
        const session = await OverlaySession.create(cfg);
        const record = { session };
        records.add(record);
        try {
          if (closed) throw new Error('Development browser is stopping');
          printSummary(session, log);
          record.stopLogs = logHits(session, log);
          if (!cfg.mirage) {
            // Compare with the browser's own sign-in: a signed-in portal serves its files to that session only.
            record.stopComparisons = trackOnlineState(session, { compare: (origin, target, options) => compareWebFile(origin, target, { ...options, request: context.request }) });
          }
          session.liveReload = cfg.mirage ? true : Boolean(cfg.liveReload && !args['no-reload']);
          if (cfg.panel) record.panel = enablePanel(context, session);
          // Mirage watches and reloads its own renderer. Keep this watcher only to refresh
          // the toolkit's source inventory; a second page reload can execute handlers twice.
          record.watcher = watchSources(session, context, { log, reload: !cfg.mirage });
          await record.watcher.ready;
          if (closed) throw new Error('Development browser is stopping');
          record.agent = await startAgentServer({ session, context, panel: record.panel, attached, stop, runtime: { watching: true, debugPort, portals: mode } });
          if (closed) throw new Error('Development browser is stopping');
          if (record.agent) log(`agent API   ${cfg.siteName} @ ${cfg.envName}: ${record.agent.discoveryFile}`);
          active.set(origin, record);
          return record;
        } catch (error) {
          await dispose(record);
          throw error;
        }
      })();
      pending.set(origin, initializing);
      initializing.catch((error) => {
        failedAt.set(origin, Date.now());
        if (!closed) log(`ERROR       ${origin}: ${error.message}`);
      });
    }
    return pending.get(origin);
  };

  const close = () => closing ??= (async () => {
    closed = true;
    // Release paused requests first. Initializers finish before disposing any resources they own.
    try { await detach?.(); }
    finally {
      await Promise.allSettled(pending.values());
      await Promise.allSettled([...records].map(dispose));
      records.clear();
      pending.clear();
      failedAt.clear();
    }
  })();

  try {
    detach = await interceptOrigins(context, [...configs.keys()], async (route) => {
      try {
        const { session } = await ensure(new URL(route.request().url()).origin);
        if (closed) return route.abort();
        await session.route(route);
      } catch {
        // A configured portal must not quietly appear online after its local setup failed.
        await route.abort();
      }
    }, {
      bypassCSP: Boolean(initial.browser.bypassCSP),
      onError: (error) => {
        failure = error;
        log(`ERROR       Portal interception failed: ${error.message}`);
        close().finally(stop).catch(() => {});
      },
    });
    if (closed) { await detach(); throw failure ?? new Error('Development browser is stopping'); }
    await ensure(initial.origin);
    if (closed) throw failure ?? new Error('Development browser is stopping');
    return { active, close, get failure() { return failure; } };
  } catch (error) {
    await close();
    throw error;
  }
}
