import fs from 'node:fs/promises';
import path from 'node:path';
import chokidar from 'chokidar';
import { loadProjectConfig } from '../../mirage/lib/project-config.mjs';
import { solutionWatchFilter } from '../../mirage/lib/solution-roots.mjs';
import { standaloneMirageConfiguration } from '../standalone-mirage.mjs';
import { openBrowser } from '../browser.mjs';
import { interceptOrigins } from '../intercept.mjs';
import { createInspectionProvenanceTransport } from '../inspection-provenance-transport.mjs';
import { refreshUrl } from '../navigation.mjs';
import { startModelDrivenInspector } from '../model-driven-inspector.mjs';
import { createModelDrivenOverlay, importModelDrivenProject } from '../model-driven.mjs';
import { modelDrivenTargets, readTargetMappings, modelDrivenTargetSessions } from '../model-driven-targets.mjs';
import { startupProgress, waitForStartupPage } from '../startup-progress.mjs';
import { startupDeadline } from '../startup-deadline.mjs';
import { createModelDrivenMetadataIndex } from '../model-driven-metadata.mjs';

const cleanError = (error) =>
  String(error.message).replace(/https?:\/\/[^\s<>"']+/g, (value) => {
    try {
      const url = new URL(value);
      return `${url.origin}${url.pathname}${url.search ? '?[redacted]' : ''}`;
    } catch {
      return '[redacted URL]';
    }
  });

/** One active import and one latest pending revision, regardless of save volume. */
export function modelDrivenReloadQueue(task) {
  let pending,
    requested = false,
    stopped = false;
  return {
    request() {
      if (stopped) return Promise.resolve();
      requested = true;
      return (pending ??= Promise.resolve()
        .then(async () => {
          do {
            requested = false;
            await task();
          } while (requested && !stopped);
        })
        .finally(() => {
          pending = null;
        }));
    },
    async close() {
      stopped = true;
      requested = false;
      await pending;
    },
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
  const failed = next.diagnostics.find((item) =>
    [
      'MODEL_CLIENT_IMPORT_FAILED',
      'MODEL_CLIENT_IMPORT_LIMIT',
      'MODEL_CLIENT_XML_INVALID',
      'MODEL_WEBRESOURCE_UNRESOLVED',
      'MODEL_PCF_IMPORT_FAILED',
      'MODEL_PCF_RESOURCE_UNRESOLVED',
      'MODEL_APP_ACTION_INVALID',
      'PCF_IMPORT_FAILED',
    ].includes(item.code),
  );
  if (failed) throw new Error(`Local resource reload failed (${failed.code}); the previous overlay remains active.`);
  overlay.replace(next, mappings);
}

export function validateModelDrivenArguments(args, action = 'dev') {
  if (!['inspect', 'dev'].includes(action)) throw new Error('model-driven accepts inspect or dev.');
  if (action === 'inspect') {
    const allowed = new Set([
      'config',
      'project',
      'env',
      'url',
      'path',
      'resource-map',
      'local-simulation',
      'json',
      'event-cursor',
      'include-event-parameters',
    ]);
    for (const option of Object.keys(args))
      if (!allowed.has(option))
        throw Object.assign(new Error(`--${option} is not supported by model-driven inspect`), {
          code: 'unsupported_option',
        });
  }
  if (!args.project) throw new Error('model-driven requires --project with selected Solution sources.');
  if (args.env && args.url) throw new Error('Choose --env or --url, not both.');
  if (action === 'dev' && args['startup-timeout'] !== undefined) {
    const timeout = Number(args['startup-timeout']);
    if (!/^\d+$/.test(args['startup-timeout']) || !Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 600000)
      throw new Error('--startup-timeout must be an integer from 1000 to 600000 milliseconds');
  }
  if (
    action === 'dev' &&
    args.timeout !== undefined &&
    (!/^\d+$/.test(args.timeout) ||
      !Number.isSafeInteger(Number(args.timeout)) ||
      Number(args.timeout) < 1 ||
      Number(args.timeout) > 3600000)
  )
    throw new Error('--timeout must be 1..3600000 milliseconds.');
  if (args.json && action !== 'inspect')
    throw new Error('--json is supported by model-driven inspect. Use --output for a dev session report.');
  if (action !== 'inspect' && (args['event-cursor'] !== undefined || args['include-event-parameters'] !== undefined))
    throw new Error('Event report options are supported by model-driven inspect only.');
}

export function modelDrivenEventPage(imported, args = {}) {
  let cursor;
  if (args['event-cursor'] !== undefined) {
    const text = args['event-cursor'];
    if (typeof text !== 'string' || !/^[A-Za-z0-9_-]{1,4096}$/.test(text)) throw new Error('Invalid --event-cursor.');
    try {
      cursor = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
    } catch {
      throw new Error('Invalid --event-cursor.');
    }
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) throw new Error('Invalid --event-cursor.');
  }
  const page = createModelDrivenMetadataIndex(imported).eventRegistrations({
    cursor,
    includeParameters: Boolean(args['include-event-parameters']),
  });
  return {
    ...page,
    ...(page.nextCursor ? { nextCursorToken: Buffer.from(JSON.stringify(page.nextCursor)).toString('base64url') } : {}),
  };
}

export default async function run(_cfg, args, [action = 'dev'] = []) {
  validateModelDrivenArguments(args, action);
  const originalProgress = action === 'dev' ? (args.startup ?? startupProgress()) : null;
  const deadline = action === 'dev' ? startupDeadline(args['startup-timeout']) : null;
  const progress = originalProgress && {
    phase(name, detail) {
      deadline.phase(name);
      originalProgress.phase(name, detail);
    },
    complete(detail) {
      originalProgress.complete(detail);
    },
    fail(detail) {
      originalProgress.fail(detail);
    },
    close() {
      originalProgress.close();
    },
  };
  try {
    return await runModelDriven(args, action, progress, deadline);
  } catch (error) {
    progress?.fail(cleanError(error));
    throw error;
  } finally {
    deadline?.close();
    progress?.close();
  }
}

async function runModelDriven(args, action, progress, deadline) {
  const startupWait = (work, disposeLate) => (deadline ? deadline.wait(work, disposeLate) : work);
  progress?.phase('configuration');
  const project = await startupWait(loadProjectConfig(args.project));
  const selection = modelDrivenTargets(project, args),
    selected = selection.selected;
  let targets = selection.targets;
  if (args['local-simulation']) {
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(selected.origin).hostname))
      throw new Error('--local-simulation requires a loopback target.');
    targets = [selected];
    selected.envName = 'Local simulation';
  }
  progress?.phase('source discovery and Solution resources');
  let imported = await startupWait(importModelDrivenProject(project));
  if (args['local-simulation'])
    imported.diagnostics.push({
      code: 'MODEL_LOCAL_SIMULATION',
      message:
        'Local Mirage simulation. Actions use this loopback runtime; native-only APIs remain unavailable when the runtime does not expose them.',
    });
  progress?.phase('resource mappings');
  const mappings = await startupWait(readTargetMappings(targets, imported));
  const origin = selected.origin;
  let page, targetSessions;
  if (action === 'inspect') {
    const overlay = createModelDrivenOverlay({
      origin,
      imported,
      mappings: mappings.get(selected.id),
      localSimulation: Boolean(args['local-simulation']),
    });
    const report = {
      ...overlay.report(),
      selectedTarget: selected.id,
      targets: targets.map(({ id, origin }) => ({ id, origin })),
      trustedExtensions: project.modelDriven?.trustedExtensions ?? false,
      localSimulation: Boolean(args['local-simulation']),
      clientEvents: modelDrivenEventPage(imported, args),
    };
    if (args.json) console.log(JSON.stringify(report));
    else
      console.log(
        `${report.resources.length} declared Solution resources; ${report.unbound.length} require exact native resource mappings.\n${JSON.stringify(report, null, 2)}`,
      );
    return 0;
  }
  if (!project.modelDriven?.trustedExtensions)
    throw new Error(
      'Set modelDriven.trustedExtensions: true in the project to execute local Solution code in the model-driven browser.',
    );
  const url = new URL(selected.startPath, origin);
  const timeout = args.timeout == null ? null : Number(args.timeout);
  if (timeout != null && (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600000))
    throw new Error('--timeout must be 1..3600000 milliseconds.');
  const cfg = { ...standaloneMirageConfiguration(project, args), origin };
  progress?.phase('browser setup');
  const { context, close, attached, debugPort } = await startupWait(
    openBrowser(cfg, { debugPort: cfg.browser.debugPort }),
    (opened) => opened.close(),
  );
  const provenance = createInspectionProvenanceTransport(
    context,
    targets.map((target) => ({ origin: target.origin, mirage: Boolean(args['local-simulation']) })),
  );
  cfg.provenanceSlot = provenance.slot;
  cfg.domProvenanceSlot = provenance.domSlot;
  let release,
    watcher,
    timer,
    reloadTimer,
    reloads,
    stopping = false,
    stop,
    primaryFailure;
  const stopped = new Promise((resolve) => {
    stop = resolve;
  });
  const browser = context.browser();
  const onError = (error) => console.error(`Model-driven overlay: ${cleanError(error)}`);
  const onNavigation = (frame) => {
    if (frame !== page.mainFrame()) return;
    let nextOrigin;
    try {
      nextOrigin = new URL(page.url()).origin;
    } catch {
      return;
    }
    if (!targets.some((target) => target.origin === nextOrigin))
      targetSessions?.suspend().catch((error) => {
        primaryFailure ??= error;
        onError(error);
        stop();
      });
  };
  context.once('close', stop);
  browser?.once('disconnected', stop);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    page = attached
      ? await startupWait(context.newPage(), (late) => late.close())
      : (context.pages()[0] ?? (await startupWait(context.newPage(), (late) => late.close())));
    page.once('close', stop);
    progress?.phase('interception and inspector setup');
    targetSessions = modelDrivenTargetSessions({
      localSimulation: Boolean(args['local-simulation']),
      targets,
      initial: selected,
      imported,
      mappings,
      liveReload: !args['no-reload'],
      ownsRequest: (request) => request.frame?.().page?.() === page,
      onApplied: (event) => {
        if (event.count === 1) console.log(`Applied local Solution resource: ${event.resource}`);
      },
      createInspector: (session, source) =>
        startModelDrivenInspector({
          context,
          page,
          overlay: session.overlay,
          cfg: {
            ...cfg,
            origin: session.target.origin,
            siteName: session.target.siteName,
            envName: session.target.envName,
            caution: session.target.caution,
            devTargets: targets.map(({ siteName, envName, origin, startPath, caution }) => ({
              siteName,
              envName,
              origin,
              startPath,
              caution,
            })),
          },
          imported: source,
          attached,
          stop,
          savedState: session.saved,
          runtime: {
            watching: true,
            liveReload: session.live,
            setLive(value) {
              session.live = value;
            },
            debugPort: debugPort ?? null,
          },
        }),
    });
    release = await startupWait(
      interceptOrigins(
        context,
        targets.map((target) => target.origin),
        async (route) => {
          const request = route.request(),
            targetOrigin = new URL(request.url()).origin;
          try {
            if (request.resourceType() === 'document' && !request.frame()?.parentFrame()) {
              const previous = targetSessions.current();
              previous?.inspector?.prepareRequest(route);
              // Chromium cannot answer Page/Runtime teardown commands while its
              // next main document is Fetch-paused. Continue navigation first;
              // declared asset routes below wait for the serialized transition.
              const transition = targetSessions.activate(targetOrigin);
              void transition.catch((error) => {
                primaryFailure ??= error;
                onError(error);
                stop();
              });
              route.removeRequestHeader('x-paqvilo-native-comparison');
              return route.fallback();
            }
            const current = await targetSessions.ready();
            if (current?.target.origin !== targetOrigin || !current.inspector) {
              route.removeRequestHeader('x-paqvilo-native-comparison');
              return route.fallback();
            }
            current.inspector.prepareRequest(route);
            return current.overlay.handle(route);
          } catch (error) {
            primaryFailure ??= error;
            onError(error);
            stop();
            return route.abort();
          }
        },
        {
          bypassCSP: cfg.browser.bypassCSP,
          ownsPage: (candidate) => candidate === page,
          onError,
          onAttach: provenance.onAttach,
        },
      ),
      (dispose) => dispose(),
    );
    await startupWait(targetSessions.activate(origin));
    page.on('framenavigated', onNavigation);
    {
      progress?.phase('source watcher setup');
      const mapFiles = targets.flatMap((target) => (target.mapFile ? [target.mapFile] : []));
      const clientSources = project.modelDriven?.clientSources ?? [],
        sourceRoots = [...project.solutionRoots, ...clientSources];
      const watchFilter = () =>
        solutionWatchFilter({
          roots: sourceRoots,
          layers: [...imported.layers, ...clientSources.map((dir) => ({ type: 'directory', dir }))],
        });
      let ignoredSource = watchFilter();
      let watchedLayers = new Set(
        imported.layers.filter((layer) => layer.type === 'directory').map((layer) => layer.dir),
      );
      watcher = chokidar.watch([...sourceRoots, ...mapFiles], {
        ignoreInitial: true,
        ignored: (candidate, stats) => {
          const resolved = path.resolve(candidate);
          return mapFiles.some((mapFile) => resolved === mapFile || mapFile.startsWith(resolved + path.sep))
            ? false
            : ignoredSource(candidate, stats);
        },
      });
      watcher.on('error', onError);
      await startupWait(
        new Promise((resolve, reject) => {
          const ready = () => {
            clearTimeout(deadline);
            watcher.off('error', fail);
            resolve();
          };
          const fail = (error) => {
            clearTimeout(deadline);
            watcher.off('ready', ready);
            reject(error);
          };
          const deadline = setTimeout(
            () => fail(new Error('The local Solution watcher did not become ready within 10 seconds.')),
            10000,
          );
          watcher.once('ready', ready);
          watcher.once('error', fail);
        }),
      );
      reloads = modelDrivenReloadQueue(async () => {
        if (stopping) return;
        try {
          const next = await importModelDrivenProject(project),
            maps = await readTargetMappings(targets, next);
          if (args['local-simulation'])
            next.diagnostics.push({
              code: 'MODEL_LOCAL_SIMULATION',
              message:
                'Local Mirage simulation. Actions use this loopback runtime; native-only APIs remain unavailable when the runtime does not expose them.',
            });
          // Preserve the same importer failure admission as the one-target runner.
          publishModelDrivenReload({ replace() {} }, next, []);
          await targetSessions.replace(next, maps);
          imported = next;
          ignoredSource = watchFilter();
          const nextLayers = new Set(
            imported.layers.filter((layer) => layer.type === 'directory').map((layer) => layer.dir),
          );
          const addedLayers = [...nextLayers].filter((dir) => !watchedLayers.has(dir));
          if (addedLayers.length) watcher.add(addedLayers);
          watchedLayers = nextLayers;
          // Only this session's own app tab reloads. Login pages and attached
          // user tabs remain under their existing owner's control.
          const active = targetSessions.current();
          if (
            !stopping &&
            active?.inspector &&
            active.live &&
            (await refreshModelDrivenPage(page, active.target.origin))
          )
            console.log('Reloaded model-driven app with local Solution resources.');
        } catch (error) {
          onError(error);
        }
      });
      watcher.on('all', () => {
        clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
          reloads.request().catch(onError);
        }, 150);
      });
    }
    console.log(
      `Opening model-driven app at ${origin}. ${args['local-simulation'] ? 'Local Mirage simulation; app actions use this loopback runtime.' : 'Local scripts are overlaid in this browser; app actions use the selected environment.'}`,
    );
    console.log(
      'Close the dedicated browser or press Ctrl+C to stop. Resource queries and credentials are omitted from the report.',
    );
    let loaded;
    try {
      loaded = await startupWait(
        waitForStartupPage(page, url.href, {
          progress,
          stopped,
          signal: deadline?.signal,
          modelDriven: Boolean(args['local-simulation']),
          nativeModelDriven: !args['local-simulation'],
        }),
      );
    } catch (error) {
      throw Object.assign(new Error(`Could not open the model-driven app: ${cleanError(error)}`), {
        code: error.code,
        phase: error.phase,
      });
    }
    deadline?.finish();
    if (timeout) timer = setTimeout(stop, timeout);
    if (loaded)
      console.log(
        'Model-driven overlay installed; document loaded. Sign-in and native application readiness remain unverified. Edit a declared Solution webresource or mapped PCF resource to reload.',
      );
    await stopped;
    if (primaryFailure) throw primaryFailure;
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    stop();
    stopping = true;
    clearTimeout(timer);
    clearTimeout(reloadTimer);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    context.off('close', stop);
    browser?.off('disconnected', stop);
    page?.off('close', stop);
    page?.off('framenavigated', onNavigation);
    const cleanupFailures = [];
    let browserReleased = false;
    if (['startup_timeout', 'startup_cancelled'].includes(primaryFailure?.code)) {
      // Closing the owned target first releases paused CDP setup commands.
      // Inspector retirement otherwise queues behind the very startup work
      // whose deadline just expired. close() only detaches an attached browser.
      try {
        if (page && !page.isClosed()) await page.close({ runBeforeUnload: false });
      } catch (error) {
        cleanupFailures.push(error);
      }
      try {
        await close();
        browserReleased = true;
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    // Finish every cleanup step even if a disconnected browser rejects one.
    for (const cleanup of [
      () => watcher?.close(),
      () => reloads?.close(),
      () => targetSessions?.close(),
      () => release?.(),
      () => (attached && page && !page.isClosed() ? page.close() : undefined),
      () => (browserReleased ? undefined : close()),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        cleanupFailures.push(error);
        onError(error);
      }
    }
    const report =
      targetSessions?.report() ??
      createModelDrivenOverlay({
        origin,
        imported,
        mappings: mappings.get(selected.id),
        localSimulation: Boolean(args['local-simulation']),
      }).report();
    report.localSimulation = Boolean(args['local-simulation']);
    try {
      if (args.output) {
        const file = path.resolve(args.output);
        report.writesFiles = [file];
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, JSON.stringify(report, null, 2) + '\n');
        console.log(`Model-driven overlay report: ${file}`);
      }
    } catch (error) {
      cleanupFailures.push(error);
      onError(error);
    }
    console.log(
      `Model-driven overlay stopped${cleanupFailures.length ? ' with cleanup failures' : ''}: ${report.applied} local resource applications; ${report.currentRevisionApplied} on the current revision; ${report.resources.filter((resource) => resource.currentRevisionApplied === 0).length} current resources not observed.`,
    );
    if (cleanupFailures.length) {
      const causes = [...new Set([...(primaryFailure ? [primaryFailure] : []), ...cleanupFailures])];
      // eslint-disable-next-line no-unsafe-finally -- Cleanup failures explicitly retain the primary failure in causes.
      if (causes.length === 1) throw causes[0];
      // eslint-disable-next-line no-unsafe-finally -- Aggregate both primary and cleanup failures instead of replacing the primary silently.
      throw new AggregateError(
        causes,
        primaryFailure ? `${cleanError(primaryFailure)} (cleanup also failed).` : 'Model-driven cleanup failed.',
      );
    }
  }
  return 0;
}
