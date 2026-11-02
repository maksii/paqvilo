import { reportCliError } from './cli-output.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import { windowsLaunchOptions } from './lib/browser-launch.mjs';
import { loadCatalogue, loadConfig } from '../lense/config.mjs';
import { miragePaths, discoveries, samePath } from '../lense/commands/mirage.mjs';
import { createSimulator } from './server.mjs';
import { connectRuntime } from './testing/runtime.mjs';
import { resolveCatalogue } from '../lense/resolved-catalogue.mjs';
import { assertOfflineState } from './lib/offline-state.mjs';
import { validateLivePath } from './lib/live.mjs';

export function captureCdpUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('CDP must be a loopback URL without credentials, path or query');
  return url.origin;
}

// Windows keeps files of a closed browser busy for seconds (2-12 s observed with the sandbox: chrome_debug.log).
// The profile removal retries without blocking the event loop, up to 11 s of linear backoff.
const removeProfile = (directory) =>
  fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

/** A headless browser on a temporary profile with a loopback CDP port; close() removes the profile. */
export async function launchCaptureBrowser(channel) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-shell-'));
  let context;
  try {
    const probe = net.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    context = await chromium.launchPersistentContext(
      directory,
      windowsLaunchOptions({
        headless: true,
        ...(channel !== 'chromium' ? { channel } : {}),
        args: [`--remote-debugging-port=${port}`],
      }),
    );
    return {
      cdp: `http://127.0.0.1:${port}`,
      close: async () => {
        try {
          await context.close();
        } finally {
          await removeProfile(directory);
        }
      },
    };
  } catch (error) {
    await context?.close().catch(() => {});
    await removeProfile(directory);
    throw error;
  }
}

/** Always disconnect, including a partial/failed connect. */
export async function captureThroughRuntime(client, cdp, pagePath, options = {}) {
  let failure;
  try {
    await client.liveConnect(cdp);
    return await client.captureShell(pagePath, options);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await client.liveDisconnect();
    } catch (error) {
      // eslint-disable-next-line no-unsafe-finally -- Cleanup failure is deliberately reported while preserving the primary failure.
      if (!failure) throw error;
      failure.disconnectFailed = true;
    }
  }
}

function captureFailure(error) {
  const message = String(error?.message ?? 'Capture failed before a usable shell report was returned.')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(
      /((?:access_token|id_token|password|secret|authorization|cookie|csrf|api[_-]?key)\s*[=:]\s*)[^\s&]+/gi,
      '$1[redacted]',
    )
    .replace(/https?:\/\/[^\s)]+/gi, (value) => {
      try {
        const url = new URL(value);
        return url.origin + url.pathname;
      } catch {
        return '<invalid URL>';
      }
    })
    .slice(0, 2000);
  return {
    code: 'SHELL_CAPTURE_FAILED',
    blocking: true,
    message,
    ...(error?.disconnectFailed ? { disconnectFailed: true } : {}),
    ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
    ...(typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? { causeCode: error.code } : {}),
  };
}

function chooseCaptureSiteCandidate(name, cfg, candidates, skipped) {
  for (const candidate of candidates)
    if (candidate.caution) skipped.push({ site: name, env: candidate.envName, reason: 'Caution environment' });
  if (cfg.caution) cfg = candidates.find((candidate) => !candidate.caution);
  if (!cfg) return null;
  for (const candidate of candidates)
    if (!candidate.caution && candidate.envName !== cfg.envName)
      skipped.push({
        site: name,
        env: candidate.envName,
        reason: 'One capture per site state file; using ' + cfg.envName,
      });
  return cfg;
}

async function resolveCaptureSite(name, context) {
  const { catalogue, resolved, config, all, env, skipped, targets } = context;
  const target = resolved.sites.find((item) => item.name === name);
  if (all && !Number.isInteger(catalogue.sites[name].mirage?.port)) {
    skipped.push({ site: name, reason: 'No Mirage port configured' });
    return null;
  }
  let cfg = await loadConfig({ config, site: name, env: all ? undefined : env }, process.env);
  if (all) {
    const candidates = await Promise.all(
      Object.keys(catalogue.sites[name].environments).map((candidateEnv) =>
        loadConfig({ config, site: name, env: candidateEnv }, process.env),
      ),
    );
    cfg = chooseCaptureSiteCandidate(name, cfg, candidates, skipped);
    if (!cfg) return null;
  } else if (cfg.caution) throw new Error('Shell capture refuses caution environments');
  const shared = targets.find((entry) => samePath(entry.target.mirage.stateFile, target.mirage.stateFile));
  if (shared) {
    skipped.push({
      site: name,
      env: cfg.envName,
      reason: `Shared state file already selected for ${shared.cfg.siteName}`,
    });
    return null;
  }
  return { cfg, target };
}

async function resolveCaptureTargets(catalogue, resolved, options, skipped) {
  const { config, all, selectedSites, env } = options,
    targets = [];
  for (const name of selectedSites) {
    const target = await resolveCaptureSite(name, { catalogue, resolved, config, all, env, skipped, targets });
    if (target) targets.push(target);
  }
  return targets;
}

async function matchingCaptureRuntimes(cfg, target) {
  const running = (await discoveries(miragePaths(cfg), { probe: false })).filter(
    (item) =>
      item.processAlive &&
      (item.stateFile ? samePath(item.stateFile, target.mirage.stateFile) : samePath(item.sourceDir, target.sourceDir)),
  );
  if (!running.length && target.mirage.port > 0) {
    const url = `http://127.0.0.1:${target.mirage.port}`;
    let response;
    try {
      response = await fetch(`${url}/_sim/api/status`, { signal: AbortSignal.timeout(1000), redirect: 'error' });
    } catch {
      /* No configured runtime. */
    }
    if (response?.ok) {
      const status = await response.json();
      if (typeof status.sourceDir === 'string') running.push({ url });
    }
  }
  if (running.length > 1) throw new Error('Multiple runtimes match; stop extras before capturing');
  return running;
}

function chooseRunningCaptureEnvironment(cfg, state, candidates, skipped) {
  const active = candidates.find((candidate) => !candidate.caution && candidate.origin === state.config.live?.origin);
  if (!active && candidates.some((candidate) => candidate.caution && candidate.origin === state.config.live?.origin)) {
    skipped.push({
      site: cfg.siteName,
      env: cfg.envName,
      reason: 'State file is owned by a runtime using a caution environment',
    });
    return null;
  }
  if (!active) throw new Error('Running runtime origin is not a non-caution environment for this site');
  skipped.push({
    site: cfg.siteName,
    env: cfg.envName,
    reason: 'Using the running runtime environment ' + active.envName,
  });
  const index = skipped.findIndex((item) => item.site === active.siteName && item.env === active.envName);
  if (index >= 0) skipped.splice(index, 1);
  return active;
}

async function connectRunningCaptureRuntime(running, cfg, target, options) {
  const { all, catalogue, config, skipped } = options;
  const client = await connectRuntime({ origin: running[0].url });
  const status = await client.status(),
    state = await client.state({ summary: true });
  if (all && state.config.live?.origin !== cfg.origin) {
    const candidates = await Promise.all(
      Object.keys(catalogue.sites[cfg.siteName].environments).map((env) =>
        loadConfig({ config, site: cfg.siteName, env }, process.env),
      ),
    );
    const active = chooseRunningCaptureEnvironment(cfg, state, candidates, skipped);
    if (!active) return null;
    cfg = active;
  }
  if (
    !samePath(status.sourceDir, target.sourceDir) ||
    (status.stateFile && !samePath(status.stateFile, target.mirage.stateFile)) ||
    state.config.live?.origin !== cfg.origin
  )
    throw new Error('Running runtime source/origin does not match the capture target');
  if (state.status.live?.connected)
    throw new Error('Runtime already has a live connection; disconnect it before shell capture');
  return { cfg, client };
}

async function startLocalCaptureSimulator(cfg, target, createLocalSimulator) {
  await assertOfflineState(target.mirage.stateFile);
  const simulator = await createLocalSimulator({
    sourceDir: target.sourceDir,
    stateFile: target.mirage.stateFile,
    origin: cfg.origin,
    port: 0,
    watch: false,
    solutionRoots: target.solutionRoots,
    dataPacks: cfg.mirageConfig.dataPacks,
    observed: cfg.mirageConfig.observed,
    localOverrides: cfg.mirageConfig.localOverrides,
  });
  // A cached state may have been last used with another selected environment.
  const state = simulator.store.snapshot();
  state.simulator.live = { ...state.simulator.live, origin: cfg.origin };
  await simulator.store.replaceState(state);
  simulator.live.configure(state.simulator.live);
  const client = await connectRuntime({ origin: simulator.url });
  return { simulator, client };
}

async function captureTarget(entry, options, reports) {
  let { cfg } = entry;
  const { target } = entry;
  let browser, simulator, progress;
  try {
    const running = await matchingCaptureRuntimes(cfg, target);
    let client;
    if (running.length) {
      const connection = await connectRunningCaptureRuntime(running, cfg, target, options);
      if (!connection) return;
      cfg = connection.cfg;
      client = connection.client;
    } else {
      const started = await startLocalCaptureSimulator(cfg, target, options.createLocalSimulator);
      simulator = started.simulator;
      client = started.client;
    }
    let cdpUrl = options.cdp;
    if (cdpUrl == null) {
      browser = await options.launchBrowser(cfg.browser.channel);
      cdpUrl = browser.cdp;
    }
    const startedAt = Date.now();
    options.onProgress?.({ site: cfg.siteName, phase: 'started', elapsedMs: 0 });
    if (options.onProgress)
      progress = setInterval(
        () => options.onProgress({ site: cfg.siteName, phase: 'waiting', elapsedMs: Date.now() - startedAt }),
        15000,
      );
    reports.push({
      site: cfg.siteName,
      env: cfg.envName,
      ...(await captureThroughRuntime(client, cdpUrl, options.pagePath, {
        richText: !options.noRichText,
        timeoutMs: options.timeoutMs,
      })),
    });
  } catch (error) {
    if (!options.all) throw error;
    // One failed local capture must not hide reports from other selected sites.
    reports.push({
      site: cfg.siteName,
      env: cfg.envName,
      applied: false,
      ready: false,
      complete: false,
      failures: [captureFailure(error)],
    });
  } finally {
    clearInterval(progress);
    try {
      await simulator?.close();
    } finally {
      await browser?.close();
    }
  }
}

export async function captureShell({
  config,
  site,
  env,
  all = false,
  path: pagePath = '/',
  cdp,
  timeout = 0,
  onProgress,
  'no-rich-text': noRichText = false,
  launchBrowser = launchCaptureBrowser,
  createLocalSimulator = createSimulator,
} = {}) {
  const timeoutMs = typeof timeout === 'string' && /^\d+$/.test(timeout) ? Number(timeout) : timeout;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2147483647)
    throw new Error('--timeout must be an integer from 0 to 2147483647 milliseconds (0 disables the client timeout)');
  validateLivePath(pagePath);
  if (all && env) throw new Error('--all and --env are mutually exclusive');
  if (cdp) cdp = captureCdpUrl(cdp);
  const catalogue = loadCatalogue({ config });
  const selectedSite = site;
  site ??= catalogue.settings.values.PAQVILO_SITE ?? catalogue.root.defaultSite ?? Object.keys(catalogue.sites)[0];
  if (!catalogue.sites[site]) throw new Error(`Unknown site '${site}'`);
  const skipped = [];
  // Validate every target before opening any browser or changing local state.
  const resolved = await resolveCatalogue({ config });
  let selectedSites;
  if (!all) selectedSites = [site];
  else if (selectedSite) selectedSites = [selectedSite];
  else selectedSites = Object.keys(catalogue.sites);
  const targets = await resolveCaptureTargets(catalogue, resolved, { config, all, selectedSites, env }, skipped);
  const reports = [];
  const captureOptions = {
    all,
    catalogue,
    config,
    skipped,
    cdp,
    pagePath,
    timeoutMs,
    onProgress,
    noRichText,
    launchBrowser,
    createLocalSimulator,
  };
  for (const entry of targets) await captureTarget(entry, captureOptions, reports);
  return {
    schemaVersion: 1,
    command: 'capture-shell',
    reports,
    skipped,
    complete: reports.every((report) => report.complete),
  };
}

export function captureSummary(report) {
  return (report.reports ?? [])
    .flatMap((item) => {
      const failures = [
        ...(item.failures ?? []),
        ...(item.richText?.failures ?? []).map((failure) => ({ ...failure, blocking: false })),
      ].sort((a, b) => Number(Boolean(b.blocking)) - Number(Boolean(a.blocking)));
      const diagnostics = item.richText?.complete === false ? (item.richText.diagnostics ?? []) : [];
      return [
        `Shell ${item.site}: ${item.applied ? 'applied' : 'not applied'}; ${item.ready ? 'ready' : 'not ready'}; ${item.complete ? 'complete' : 'incomplete'}`,
        ...[...failures, ...diagnostics].map((failure) => {
          const path = failure.path ? ` ${failure.path}` : '',
            host = failure.host ? ` [${failure.host}: ${failure.reason ?? 'excluded'}]` : '';
          return `  ${failure.blocking ? 'BLOCKING' : 'observed'} ${failure.code}:${path}${host} — ${failure.message}`;
        }),
      ];
    })
    .join('\n');
}

export function captureExitCode(report, { strict = false } = {}) {
  return (report.reports ?? []).length > 0 &&
    report.reports.every(
      (item) => item.applied && item.ready && !(item.failures ?? []).some((failure) => failure.blocking),
    ) &&
    (!strict || report.complete)
    ? 0
    : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        config: { type: 'string' },
        site: { type: 'string' },
        env: { type: 'string' },
        all: { type: 'boolean' },
        path: { type: 'string' },
        cdp: { type: 'string' },
        timeout: { type: 'string' },
        json: { type: 'boolean' },
        strict: { type: 'boolean' },
        'no-rich-text': { type: 'boolean' },
      },
    });
    const report = await captureShell({
      ...values,
      ...(!values.json
        ? {
            onProgress: ({ site, phase, elapsedMs }) => {
              const progress =
                phase === 'started'
                  ? 'capturing shell and editor resources'
                  : `still capturing (${Math.floor(elapsedMs / 1000)} s)`;
              console.error(`Shell ${site}: ${progress}`);
            },
          }
        : {}),
    });
    if (!values.json) console.error(captureSummary(report));
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = captureExitCode(report, values);
  } catch (error) {
    reportCliError(captureFailure(error));
    process.exitCode = 1;
  }
}
