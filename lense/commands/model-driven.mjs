import fs from 'node:fs/promises';
import path from 'node:path';
import chokidar from 'chokidar';
import { loadProjectConfig } from '../../mirage/lib/project-config.mjs';
import { solutionWatchFilter } from '../../mirage/lib/solution-roots.mjs';
import { standaloneMirageConfiguration } from '../standalone-mirage.mjs';
import { openBrowser } from '../browser.mjs';
import { interceptOrigin } from '../intercept.mjs';
import { createModelDrivenOverlay, importModelDrivenProject, modelDrivenOrigin, readModelDrivenResourceMap } from '../model-driven.mjs';

const cleanError = error => String(error.message).replace(/https?:\/\/[^\s<>"']+/g, value => {
  try { const url = new URL(value); return `${url.origin}${url.pathname}${url.search ? '?[redacted]' : ''}`; } catch { return '[redacted URL]'; }
});

export default async function run(_cfg, args, [action = 'dev'] = []) {
  if (!['inspect', 'dev'].includes(action)) throw new Error('model-driven accepts inspect or dev.');
  if (!args.project) throw new Error('model-driven requires --project with selected Solution sources.');
  if (args.json && action !== 'inspect') throw new Error('--json is supported by model-driven inspect. Use --output for a dev session report.');
  const origin = modelDrivenOrigin(args.url), project = await loadProjectConfig(args.project);
  let imported = await importModelDrivenProject(project);
  const mappings = await readModelDrivenResourceMap(args['resource-map']);
  let page;
  const overlay = createModelDrivenOverlay({ origin, imported, mappings, ownsRequest: request => request.frame?.().page?.() === page,
    onApplied: event => { if (event.count === 1) console.log(`Applied local Solution resource: ${event.resource}`); } });
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
  const { context, close, attached } = await openBrowser(cfg, { debugPort: cfg.browser.debugPort });
  let release, watcher, timer, reloadTimer, stopping = false, pending = Promise.resolve(), stop;
  const stopped = new Promise(resolve => { stop = resolve; });
  const browser = context.browser();
  const onError = error => console.error(`Model-driven overlay: ${cleanError(error)}`);
  context.once('close', stop); browser?.once('disconnected', stop); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    page = attached ? await context.newPage() : context.pages()[0] ?? await context.newPage();
    page.once('close', stop);
    release = await interceptOrigin(context, origin, route => overlay.handle(route), { bypassCSP: cfg.browser.bypassCSP, onError });
    if (!args['no-reload']) {
      watcher = chokidar.watch([...project.solutionRoots, ...(args['resource-map'] ? [path.resolve(args['resource-map'])] : [])], { ignoreInitial: true,
        ignored: solutionWatchFilter({ roots: project.solutionRoots, layers: imported.layers }) });
      watcher.on('error', onError);
      await new Promise((resolve, reject) => {
        const ready = () => { clearTimeout(deadline); watcher.off('error', fail); resolve(); };
        const fail = error => { clearTimeout(deadline); watcher.off('ready', ready); reject(error); };
        const deadline = setTimeout(() => fail(new Error('The local Solution watcher did not become ready within 10 seconds.')), 10000);
        watcher.once('ready', ready); watcher.once('error', fail);
      });
      watcher.on('all', () => {
        clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
          pending = pending.catch(() => {}).then(async () => {
            if (stopping) return;
            try {
              const next = await importModelDrivenProject(project), map = await readModelDrivenResourceMap(args['resource-map']);
              const failed = next.diagnostics.find(item => ['MODEL_CLIENT_IMPORT_FAILED', 'MODEL_CLIENT_XML_INVALID', 'MODEL_WEBRESOURCE_UNRESOLVED', 'PCF_IMPORT_FAILED'].includes(item.code));
              if (failed) throw new Error(`Local resource reload failed (${failed.code}); the previous overlay remains active.`);
              overlay.replace(next, map); imported = next;
              // Only this session's own app tab reloads. Login pages and attached
              // user tabs remain under their existing owner's control.
              if (!stopping && !page.isClosed() && new URL(page.url()).origin === origin) { await page.reload({ waitUntil: 'domcontentloaded' }); console.log('Reloaded model-driven app with local Solution resources.'); }
            } catch (error) { onError(error); }
          });
        }, 150);
      });
    }
    if (timeout) timer = setTimeout(stop, timeout);
    console.log(`Opening model-driven app at ${origin}. Local scripts are overlaid in this browser; app actions use the selected environment.`);
    console.log('Close the dedicated browser or press Ctrl+C to stop. Resource queries and credentials are omitted from the report.');
    try { await page.goto(url.href, { waitUntil: 'domcontentloaded' }); }
    catch (error) { throw new Error(`Could not open the model-driven app: ${cleanError(error)}`); }
    console.log('Model-driven overlay ready. Edit a declared Solution webresource or mapped PCF resource to reload.');
    await stopped;
  } finally {
    stopping = true; clearTimeout(timer); clearTimeout(reloadTimer);
    process.off('SIGINT', stop); process.off('SIGTERM', stop); context.off('close', stop); browser?.off('disconnected', stop); page?.off('close', stop);
    await watcher?.close(); await pending; await release?.();
    if (attached && page && !page.isClosed()) await page.close();
    await close();
    const report = overlay.report();
    if (args.output) { const file = path.resolve(args.output); report.writesFiles = [file]; await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(report, null, 2) + '\n'); console.log(`Model-driven overlay report: ${file}`); }
    console.log(`Model-driven overlay stopped: ${report.applied} local resource applications; ${report.currentRevisionApplied} on the current revision; ${report.resources.filter(resource => resource.currentRevisionApplied === 0).length} current resources not observed.`);
  }
  return 0;
}
