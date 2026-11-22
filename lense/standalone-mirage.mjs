import path from 'node:path';
import { existsSync } from 'node:fs';
import { browserSettings, readEnvSettings, resolveMirageConfig, loadCatalogue } from './config.mjs';
import { runtimeSettings } from '../mirage/lib/runtime-config.mjs';
import { startupProgress, startupWaitOptions, waitForStartupPage } from './startup-progress.mjs';
import { guardShutdownSignals } from './signal-forwarding.mjs';
import { logBrowserProfile } from './commands/dev.mjs';

const standaloneBase = Object.freeze({ sourceDir: null, envName: 'local', portals: 'selected', origin: null });

export function standaloneMirageConfiguration(project, args = {}) {
  const configDir = project ? path.dirname(project.configFile) : process.cwd();
  const catalogueFile = args.config ?? path.join(configDir, 'paqvilo.config.yml');
  const catalogue = args.config || existsSync(catalogueFile) ? loadCatalogue({ config: catalogueFile }) : null;
  const settings = catalogue?.settings.values ?? readEnvSettings(configDir).values;
  const selectedSite =
    args.site ?? settings.PAQVILO_SITE ?? catalogue?.root.defaultSite ?? Object.keys(catalogue?.sites ?? {})[0];
  if (
    ((args.config || args.site) && Object.keys(catalogue?.sites ?? {}).length && !catalogue?.sites[selectedSite]) ||
    (args.site && !catalogue?.sites[args.site])
  )
    throw new Error(`Unknown Mirage configuration '${selectedSite}'.`);
  // A catalogue site selected without a project is the runtime's site, whatever its own runtime kind: the runtime takes
  // the site's Mirage settings (Solution roots, data packs, port) and is recorded for that site.
  if (!project && !args.project && (args.config || args.site) && catalogue?.sites[selectedSite])
    return standaloneCatalogueConfiguration(catalogue, selectedSite, args);
  return {
    configDir,
    configFile: null,
    // A project's runtime ownership stays in configDir; an explicitly selected catalogue
    // identity still scopes records and stop selection independently of it.
    catalogueScope:
      (args.config || args.site) && catalogue?.sites[selectedSite]
        ? { configFile: catalogue.configFile, siteName: selectedSite }
        : null,
    stateDir: path.join(configDir, '.paqvilo'),
    ...standaloneBase,
    siteName: project ? path.basename(project.configFile, path.extname(project.configFile)) : 'organization',
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
  return {
    ...standaloneBase,
    catalogueScope: { configFile: catalogue.configFile, siteName: name },
    configDir: catalogue.configDir,
    configFile: catalogue.configFile,
    sourceRoot: catalogue.sourceRoot,
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

// The browser automation library loads with the first browser this module opens: the configuration functions above
// serve start, stop and status, which open none.
const openBrowser = async (...args) => (await import('./browser.mjs')).openBrowser(...args);

/** Open the local application directly. No portal overlay or source model is created. */
export async function developStandalone(cfg, args, session, { open = openBrowser, signal, source = process } = {}) {
  if (signal?.aborted) throw signal.reason;
  const progress = args.startup ?? startupProgress();
  progress.phase('browser setup');
  const {
    context,
    close,
    attached,
    profile,
    page: profilePage,
  } = await open({ ...cfg, origin: session.url }, { debugPort: cfg.browser.debugPort });
  if (profile) logBrowserProfile(attached, cfg, profile);
  let stop, page;
  const errors = [];
  const stopped = new Promise((resolve) => {
    stop = resolve;
  });
  const browser = context.browser();
  context.once('close', stop);
  browser?.once('disconnected', stop);
  source.once('SIGINT', stop);
  source.once('SIGTERM', stop);
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  try {
    page = profilePage ?? (attached ? await context.newPage() : (context.pages()[0] ?? (await context.newPage())));
    // Observe this owned tab before navigation/readiness can yield. In an
    // attached browser its closure does not close the user-owned context.
    if (attached) page.once('close', stop);
    const destination = args.path ?? (cfg.runtime.kind === 'model-driven' ? '/main.aspx' : '/_sim/');
    if (!destination.startsWith('/') || destination.startsWith('//') || destination.includes('\\'))
      throw new Error('The starting path must be local to this runtime.');
    if (session.adminUrl) console.log(`admin       ${session.adminUrl}`);
    console.log(`Opening ${session.url}${destination}. Close the dedicated browser or press Ctrl+C to stop.`);
    const loaded = await waitForStartupPage(
      page,
      session.url + destination,
      startupWaitOptions(args, {
        progress,
        stopped,
        modelDriven: cfg.runtime.kind === 'model-driven',
      }),
    );
    // A closed page ends the session, whatever the browser still shows; the finally block then closes the browser.
    if (!loaded && page.isClosed()) {
      console.log('browser closed before start-up finished');
      stop();
    }
    await stopped;
  } finally {
    progress.close();
    source.off('SIGINT', stop);
    source.off('SIGTERM', stop);
    signal?.removeEventListener('abort', stop);
    context.off('close', stop);
    browser?.off('disconnected', stop);
    page?.off('close', stop);
    await guardShutdownSignals(
      async () => {
        for (const cleanup of [() => (attached && page && !page.isClosed() ? page.close() : undefined), close]) {
          try {
            await cleanup();
          } catch (error) {
            errors.push(error);
          }
        }
      },
      undefined,
      { source },
    );
  }
  if (errors.length) throw new AggregateError(errors, 'Standalone browser cleanup failed.');
  if (signal?.aborted) throw signal.reason;
  return 0;
}
