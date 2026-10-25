import path from 'node:path';
import { existsSync } from 'node:fs';
import { browserSettings, readEnvSettings, resolveMirageConfig, loadCatalogue } from './config.mjs';
import { openBrowser } from './browser.mjs';
import { runtimeSettings } from '../mirage/lib/runtime-config.mjs';
import { startupProgress, waitForStartupPage } from './startup-progress.mjs';

export function standaloneMirageConfiguration(project, args = {}) {
  const configDir = project ? path.dirname(project.configFile) : process.cwd();
  const catalogueFile = args.config ?? path.join(configDir, 'paqvilo.config.yml');
  const catalogue = args.config || existsSync(catalogueFile) ? loadCatalogue({ config: catalogueFile }) : null;
  const settings = catalogue?.settings.values ?? readEnvSettings(configDir).values;
  return {
    configDir,
    configFile: null,
    stateDir: path.join(configDir, '.paqvilo'),
    sourceDir: null,
    siteName: project ? path.basename(project.configFile, path.extname(project.configFile)) : 'organization',
    envName: 'local',
    portals: 'selected',
    origin: null,
    runtime: runtimeSettings(args.runtime ? { kind: args.runtime } : project?.runtime),
    mirageConfig: {},
    browser: browserSettings({
      configDir: catalogue?.configDir ?? configDir,
      browser: catalogue?.root.browser,
      options: args,
      settings,
    }),
    editor: settings.PAQVILO_EDITOR ?? catalogue?.root.editor ?? 'code',
  };
}

export function standaloneCatalogueConfiguration(catalogue, name, args = {}) {
  const site = catalogue.sites[name];
  if (!site) throw new Error(`Unknown Mirage configuration '${name}'.`);
  const mirageConfig = resolveMirageConfig(site.mirage, {
    configDir: catalogue.configDir,
    sourceRoot: catalogue.sourceRoot,
  });
  const cfg = standaloneMirageConfiguration(null, { ...args, runtime: args.runtime ?? mirageConfig.runtime?.kind });
  return {
    ...cfg,
    configDir: catalogue.configDir,
    configFile: catalogue.configFile,
    stateDir: path.join(catalogue.configDir, '.paqvilo'),
    siteName: name,
    runtime: runtimeSettings(args.runtime ? { kind: args.runtime } : mirageConfig.runtime),
    mirageConfig,
    editor: catalogue.settings.values.PAQVILO_EDITOR ?? catalogue.root.editor,
    browser: browserSettings({
      browser: catalogue.root.browser,
      configDir: catalogue.configDir,
      options: args,
      settings: catalogue.settings.values,
    }),
  };
}

/** Open the local application directly. No portal overlay or source model is created. */
export async function developStandalone(cfg, args, session, { open = openBrowser } = {}) {
  const progress = args.startup ?? startupProgress();
  progress.phase('browser setup');
  const { context, close, attached } = await open(
    { ...cfg, origin: session.url },
    { debugPort: cfg.browser.debugPort },
  );
  let stop, page;
  const errors = [];
  const stopped = new Promise((resolve) => {
    stop = resolve;
  });
  const browser = context.browser();
  context.once('close', stop);
  browser?.once('disconnected', stop);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    page = attached ? await context.newPage() : (context.pages()[0] ?? (await context.newPage()));
    // Observe this owned tab before navigation/readiness can yield. In an
    // attached browser its closure does not close the user-owned context.
    if (attached) page.once('close', stop);
    const destination = args.path ?? (cfg.runtime.kind === 'model-driven' ? '/main.aspx' : '/_sim/');
    if (!destination.startsWith('/') || destination.startsWith('//') || destination.includes('\\'))
      throw new Error('The starting path must be local to this runtime.');
    console.log(`Opening ${session.url}${destination}. Close the dedicated browser or press Ctrl+C to stop.`);
    await waitForStartupPage(page, session.url + destination, {
      progress,
      stopped,
      modelDriven: cfg.runtime.kind === 'model-driven',
    });
    await stopped;
  } finally {
    progress.close();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    context.off('close', stop);
    browser?.off('disconnected', stop);
    page?.off('close', stop);
    for (const cleanup of [() => (attached && page && !page.isClosed() ? page.close() : undefined), close]) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Standalone browser cleanup failed.');
  return 0;
}
