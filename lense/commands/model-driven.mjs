import fs from 'node:fs/promises';
import path from 'node:path';
import chokidar from 'chokidar';
import { loadProjectConfig } from '../../mirage/lib/project-config.mjs';
import { solutionWatchFilter } from '../../mirage/lib/solution-roots.mjs';
import { standaloneMirageConfiguration } from '../standalone-mirage.mjs';
import { openBrowser } from '../browser.mjs';
import { interceptOrigin } from '../intercept.mjs';
import { refreshUrl } from '../navigation.mjs';
import { startModelDrivenInspector } from '../model-driven-inspector.mjs';
import { createModelDrivenOverlay, importModelDrivenProject, modelDrivenOrigin, readModelDrivenResourceMap } from '../model-driven.mjs';
import { startupProgress, waitForStartupPage } from '../startup-progress.mjs';

const cleanError = error => String(error.message).replace(/https?:\/\/[^\s<>"']+/g, value => {
  try { const url = new URL(value); return `${url.origin}${url.pathname}${url.search ? '?[redacted]' : ''}`; } catch { return '[redacted URL]'; }
});

/** One active import and one latest pending revision, regardless of save volume. */
export function modelDrivenReloadQueue(task) {
  let pending, requested = false, stopped = false;
  return {
    request() {
      if (stopped) return Promise.resolve();
      requested = true;
      return pending ??= Promise.resolve().then(async () => {
        do { requested = false; await task(); } while (requested && !stopped);
      }).finally(() => { pending = null; });
    },
    async close() { stopped = true; requested = false; await pending; },
  };
}

export async function refreshModelDrivenPage(page, origin) {
  if (!page.isClosed() && new URL(page.url()).origin === origin) {
    // A native app can reach its current document through POST. Never replay it
    // as a side effect of saving a local file.
    await page.goto(refreshUrl(page.url()), { waitUntil: 'domcontentloaded', timeout: 15000 });
    return true;
  }
  return false;
}

export function publishModelDrivenReload(overlay, next, mappings) {
  const failed = next.diagnostics.find(item => ['MODEL_CLIENT_IMPORT_FAILED', 'MODEL_CLIENT_IMPORT_LIMIT', 'MODEL_CLIENT_XML_INVALID',
    'MODEL_WEBRESOURCE_UNRESOLVED', 'MODEL_PCF_IMPORT_FAILED', 'MODEL_PCF_RESOURCE_UNRESOLVED', 'MODEL_APP_ACTION_INVALID', 'PCF_IMPORT_FAILED'].includes(item.code));
  if (failed) throw new Error(`Local resource reload failed (${failed.code}); the previous overlay remains active.`);
  overlay.replace(next, mappings);
}

export default async function run(_cfg, args, [action = 'dev'] = []) {
  const progress = action === 'dev' ? args.startup ?? startupProgress() : null;
  try { return await runModelDriven(args, action, progress); }
  catch (error) { progress?.fail(cleanError(error)); throw error; }
  finally { progress?.close(); }
}

async function runModelDriven(args, action, progress) {
  if (!['inspect', 'dev'].includes(action)) throw new Error('model-driven accepts inspect or dev.');
  if (!args.project) throw new Error('model-driven requires --project with selected Solution sources.');
  if (args.json && action !== 'inspect') throw new Error('--json is supported by model-driven inspect. Use --output for a dev session report.');
  progress?.phase('configuration');
  const origin = modelDrivenOrigin(args.url), project = await loadProjectConfig(args.project);
  progress?.phase('source discovery and Solution resources');
  let imported = await importModelDrivenProject(project);
  progress?.phase('resource mappings');
  const mappings = await readModelDrivenResourceMap(args['resource-map']);
  let page, inspector;
  const overlay = createModelDrivenOverlay({ origin, imported, mappings, ownsRequest: request => request.frame?.().page?.() === page,
    onApplied: event => { if (event.count === 1) console.log(`Applied local Solution resource: ${event.resource}`); inspector?.refresh(); } });
  if (action === 'inspect') {
    const report = { ...overlay.report(), trustedExtensions: project.modelDriven.trustedExtensions };
    if (args.json) console.log(JSON.stringify(report));
    else console.log(`${report.resources.length} declared Solution resources; ${report.unbound.length} require exact native resource mappings.\n${JSON.stringify(report, null, 2)}`);
    return 0;
  }
  if (!project.modelDriven.trustedExtensions) throw new Error('Set modelDriven.trustedExtensions: true in the project to execute local Solution code in the model-driven browser.');
  const destination = args.path ?? '/main.aspx';
  const url = new URL(destination, origin);
  if (!destination.startsWith('/') || destination.startsWith('//') || destination.includes('\\') || url.origin !== origin) throw new Error('--path must be local to the selected environment origin.');
  const timeout = args.timeout == null ? null : Number(args.timeout);
  if (timeout != null && (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600000)) throw new Error('--timeout must be 1..3600000 milliseconds.');
  const cfg = { ...standaloneMirageConfiguration(project, args), origin };
  progress?.phase('browser setup');
  const { context, close, attached, debugPort } = await openBrowser(cfg, { debugPort: cfg.browser.debugPort });
  let release, watcher, timer, reloadTimer, reloads, stopping = false, stop;
  const stopped = new Promise(resolve => { stop = resolve; });
  const browser = context.browser();
  const onError = error => console.error(`Model-driven overlay: ${cleanError(error)}`);
  context.once('close', stop); browser?.once('disconnected', stop); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    page = attached ? await context.newPage() : context.pages()[0] ?? await context.newPage();
    page.once('close', stop);
    progress?.phase('interception and inspector setup');
    release = await interceptOrigin(context, origin, route => overlay.handle(route), { bypassCSP: cfg.browser.bypassCSP, ownsPage: candidate => candidate === page, onError });
    inspector = await startModelDrivenInspector({ context, page, overlay, cfg, imported, attached, stop,
      runtime: { watching: !args['no-reload'], debugPort: debugPort ?? null } });
    if (!args['no-reload']) {
      progress?.phase('source watcher setup');
      const mapFile = args['resource-map'] ? path.resolve(args['resource-map']) : null;
      const clientSources = project.modelDriven?.clientSources ?? [], sourceRoots = [...project.solutionRoots, ...clientSources];
      const watchFilter = () => solutionWatchFilter({ roots: sourceRoots, layers: [...imported.layers, ...clientSources.map(dir => ({ type: 'directory', dir }))] });
      let ignoredSource = watchFilter();
      let watchedLayers = new Set(imported.layers.filter(layer => layer.type === 'directory').map(layer => layer.dir));
      watcher = chokidar.watch([...sourceRoots, ...(mapFile ? [mapFile] : [])], { ignoreInitial: true,
        ignored: (candidate, stats) => {
          const resolved = path.resolve(candidate);
          return mapFile && (resolved === mapFile || mapFile.startsWith(resolved + path.sep)) ? false : ignoredSource(candidate, stats);
        } });
      watcher.on('error', onError);
      await new Promise((resolve, reject) => {
        const ready = () => { clearTimeout(deadline); watcher.off('error', fail); resolve(); };
        const fail = error => { clearTimeout(deadline); watcher.off('ready', ready); reject(error); };
        const deadline = setTimeout(() => fail(new Error('The local Solution watcher did not become ready within 10 seconds.')), 10000);
        watcher.once('ready', ready); watcher.once('error', fail);
      });
      reloads = modelDrivenReloadQueue(async () => {
        if (stopping) return;
        try {
          const next = await importModelDrivenProject(project), map = await readModelDrivenResourceMap(args['resource-map']);
          publishModelDrivenReload(overlay, next, map); imported = next;
          inspector.refresh(next);
          ignoredSource = watchFilter();
          const nextLayers = new Set(imported.layers.filter(layer => layer.type === 'directory').map(layer => layer.dir));
          const addedLayers = [...nextLayers].filter(dir => !watchedLayers.has(dir));
          if (addedLayers.length) watcher.add(addedLayers);
          watchedLayers = nextLayers;
          // Only this session's own app tab reloads. Login pages and attached
          // user tabs remain under their existing owner's control.
          if (!stopping && await refreshModelDrivenPage(page, origin)) console.log('Reloaded model-driven app with local Solution resources.');
        } catch (error) { onError(error); }
      });
      watcher.on('all', () => {
        clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => { reloads.request().catch(onError); }, 150);
      });
    }
    if (timeout) timer = setTimeout(stop, timeout);
    console.log(`Opening model-driven app at ${origin}. Local scripts are overlaid in this browser; app actions use the selected environment.`);
    console.log('Close the dedicated browser or press Ctrl+C to stop. Resource queries and credentials are omitted from the report.');
    let loaded;
    try { loaded = await waitForStartupPage(page, url.href, { progress, stopped }); }
    catch (error) { throw new Error(`Could not open the model-driven app: ${cleanError(error)}`); }
    if (loaded) console.log('Model-driven overlay installed; document and initial resources loaded. Sign-in and native application readiness remain unverified. Edit a declared Solution webresource or mapped PCF resource to reload.');
    await stopped;
  } finally {
    stopping = true; clearTimeout(timer); clearTimeout(reloadTimer);
    process.off('SIGINT', stop); process.off('SIGTERM', stop); context.off('close', stop); browser?.off('disconnected', stop); page?.off('close', stop);
    // Finish every cleanup step even if a disconnected browser rejects one.
    for (const cleanup of [() => watcher?.close(), () => reloads?.close(), () => inspector?.close(), () => release?.(),
      () => attached && page && !page.isClosed() ? page.close() : undefined, close]) {
      try { await cleanup(); } catch (error) { onError(error); }
    }
    const report = overlay.report();
    if (args.output) { const file = path.resolve(args.output); report.writesFiles = [file]; await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(report, null, 2) + '\n'); console.log(`Model-driven overlay report: ${file}`); }
    console.log(`Model-driven overlay stopped: ${report.applied} local resource applications; ${report.currentRevisionApplied} on the current revision; ${report.resources.filter(resource => resource.currentRevisionApplied === 0).length} current resources not observed.`);
  }
  return 0;
}
