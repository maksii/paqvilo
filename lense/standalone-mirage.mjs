import path from 'node:path';
import { browserSettings, readEnvSettings, resolveMirageConfig } from './config.mjs';
import { openBrowser } from './browser.mjs';
import { runtimeSettings } from '../mirage/lib/runtime-config.mjs';
import { startupProgress, waitForStartupPage } from './startup-progress.mjs';

export function standaloneMirageConfiguration(project, args = {}) {
  const configDir = project ? path.dirname(project.configFile) : process.cwd();
  return { configDir, configFile: null, stateDir: path.join(configDir, '.paqvilo'), sourceDir: null,
    siteName: project ? path.basename(project.configFile, path.extname(project.configFile)) : 'organization', envName: 'local',
    portals: 'selected', origin: null, runtime: runtimeSettings(args.runtime ? { kind: args.runtime } : project?.runtime), mirageConfig: {},
    browser: browserSettings({ configDir, options: args, settings: readEnvSettings(configDir).values }) };
}

export function standaloneCatalogueConfiguration(catalogue, name, args = {}) {
  const site = catalogue.sites[name];
  if (!site) throw new Error(`Unknown Mirage configuration '${name}'.`);
  const mirageConfig = resolveMirageConfig(site.mirage, { configDir: catalogue.configDir, sourceRoot: catalogue.sourceRoot });
  const cfg = standaloneMirageConfiguration(null, { ...args, runtime: args.runtime ?? mirageConfig.runtime?.kind });
  return { ...cfg, configDir: catalogue.configDir, configFile: catalogue.configFile, stateDir: path.join(catalogue.configDir, '.paqvilo'),
    siteName: name, runtime: runtimeSettings(args.runtime ? { kind: args.runtime } : mirageConfig.runtime), mirageConfig,
    browser: browserSettings({ browser: catalogue.root.browser, configDir: catalogue.configDir, options: args, settings: catalogue.settings.values }) };
}

/** Open the local application directly. No portal overlay or source model is created. */
export async function developStandalone(cfg, args, session) {
  const progress = args.startup ?? startupProgress();
  progress.phase('browser setup');
  const { context, close, attached } = await openBrowser({ ...cfg, origin: session.url }, { debugPort: cfg.browser.debugPort });
  let stop;
  const stopped = new Promise(resolve => { stop = resolve; });
  const browser = context.browser();
  context.once('close', stop); browser?.once('disconnected', stop);
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const page = attached ? await context.newPage() : context.pages()[0] ?? await context.newPage();
    const destination = args.path ?? (cfg.runtime.kind === 'model-driven' ? '/main.aspx' : '/_sim/');
    if (!destination.startsWith('/') || destination.startsWith('//') || destination.includes('\\')) throw new Error('The starting path must be local to this runtime.');
    console.log(`Opening ${session.url}${destination}. Close the dedicated browser or press Ctrl+C to stop.`);
    await waitForStartupPage(page, session.url + destination, { progress, stopped, modelDriven: cfg.runtime.kind === 'model-driven' });
    if (attached) page.once('close', stop);
    await stopped;
    if (attached && !page.isClosed()) await page.close();
  } finally {
    progress.close();
    process.off('SIGINT', stop); process.off('SIGTERM', stop); context.off('close', stop); browser?.off('disconnected', stop);
    await close();
  }
  return 0;
}
