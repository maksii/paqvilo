import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import { loadCatalogue, loadConfig } from '../lense/config.mjs';
import { miragePaths, discoveries, samePath } from '../lense/commands/mirage.mjs';
import { createSimulator } from './server.mjs';
import { connectRuntime } from './testing/runtime.mjs';
import { resolveCatalogue } from '../lense/resolved-catalogue.mjs';
import { assertOfflineState } from './lib/offline-state.mjs';
import { validateLivePath } from './lib/live.mjs';

export function captureCdpUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('CDP must be a loopback URL without credentials, path or query');
  return url.origin;
}

async function launchCaptureBrowser(channel) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-shell-'));
  let context;
  try {
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    context = await chromium.launchPersistentContext(directory, { headless: true, ...(channel !== 'chromium' ? { channel } : {}), args: [`--remote-debugging-port=${port}`] });
    return { cdp: `http://127.0.0.1:${port}`, close: async () => { try { await context.close(); } finally { await fs.rm(directory, { recursive: true, force: true }); } } };
  } catch (error) { await context?.close().catch(() => {}); await fs.rm(directory, { recursive: true, force: true }); throw error; }
}

/** Always disconnect, including a partial/failed connect. */
export async function captureThroughRuntime(client, cdp, pagePath) {
  try { await client.liveConnect(cdp); return await client.captureShell(pagePath); }
  finally { await client.liveDisconnect(); }
}

export async function captureShell({ config, site, env, all = false, path: pagePath = '/', cdp, launchBrowser = launchCaptureBrowser, createLocalSimulator = createSimulator } = {}) {
  validateLivePath(pagePath);
  if (all && env) throw new Error('--all and --env are mutually exclusive');
  if (cdp) cdp = captureCdpUrl(cdp);
  const catalogue = loadCatalogue({ config });
  const selectedSite = site;
  site ??= catalogue.settings.values.PAQVILO_SITE ?? catalogue.root.defaultSite ?? Object.keys(catalogue.sites)[0];
  if (!catalogue.sites[site]) throw new Error(`Unknown site '${site}'`);
  const skipped = [], targets = [];
  // Validate every target before opening any browser or changing local state.
  const resolved = await resolveCatalogue({ config });
  for (const name of all ? selectedSite ? [selectedSite] : Object.keys(catalogue.sites) : [site]) {
    const target = resolved.sites.find(item => item.name === name);
    if (all && !Number.isInteger(catalogue.sites[name].mirage?.port)) { skipped.push({ site: name, reason: 'No Mirage port configured' }); continue; }
    let cfg = await loadConfig({ config, site: name, env: all ? undefined : env }, process.env);
    if (all) {
      const candidates = await Promise.all(Object.keys(catalogue.sites[name].environments).map(env => loadConfig({ config, site: name, env }, process.env)));
      for (const candidate of candidates) if (candidate.caution) skipped.push({ site: name, env: candidate.envName, reason: 'Caution environment' });
      if (cfg.caution) cfg = candidates.find(candidate => !candidate.caution);
      if (!cfg) continue;
      for (const candidate of candidates) if (!candidate.caution && candidate.envName !== cfg.envName) skipped.push({ site: name, env: candidate.envName, reason: 'One capture per site state file; using ' + cfg.envName });
    } else if (cfg.caution) throw new Error('Shell capture refuses caution environments');
    const shared = targets.find(entry => samePath(entry.target.mirage.stateFile, target.mirage.stateFile));
    if (shared) { skipped.push({ site: name, env: cfg.envName, reason: `Shared state file already selected for ${shared.cfg.siteName}` }); continue; }
    targets.push({ cfg, target });
  }
  const reports = [];
  for (const entry of targets) {
    let { cfg } = entry;
    const { target } = entry;
    let browser, simulator;
    try {
      const running = (await discoveries(miragePaths(cfg), { probe: false })).filter(item => item.processAlive && (item.stateFile ? samePath(item.stateFile, target.mirage.stateFile) : samePath(item.sourceDir, target.sourceDir)));
      if (!running.length && target.mirage.port > 0) {
        const url = `http://127.0.0.1:${target.mirage.port}`;
        let response;
        try { response = await fetch(`${url}/_sim/api/status`, { signal: AbortSignal.timeout(1000), redirect: 'error' }); } catch { /* No configured runtime. */ }
        if (response?.ok) {
          const status = await response.json();
          if (typeof status.sourceDir === 'string') running.push({ url });
        }
      }
      if (running.length > 1) throw new Error('Multiple runtimes match; stop extras before capturing');
      let client;
      if (running.length) {
        client = await connectRuntime({ origin: running[0].url });
        const status = await client.status(), state = await client.state({ summary: true });
        if (all && state.config.live?.origin !== cfg.origin) {
          const candidates = await Promise.all(Object.keys(catalogue.sites[cfg.siteName].environments).map(env => loadConfig({ config, site: cfg.siteName, env }, process.env)));
          const active = candidates.find(candidate => !candidate.caution && candidate.origin === state.config.live?.origin);
          if (!active && candidates.some(candidate => candidate.caution && candidate.origin === state.config.live?.origin)) {
            skipped.push({ site: cfg.siteName, env: cfg.envName, reason: 'State file is owned by a runtime using a caution environment' });
            continue;
          }
          if (!active) throw new Error('Running runtime origin is not a non-caution environment for this site');
          skipped.push({ site: cfg.siteName, env: cfg.envName, reason: 'Using the running runtime environment ' + active.envName });
          const index = skipped.findIndex(item => item.site === active.siteName && item.env === active.envName);
          if (index >= 0) skipped.splice(index, 1);
          cfg = active;
        }
        if (!samePath(status.sourceDir, target.sourceDir) || status.stateFile && !samePath(status.stateFile, target.mirage.stateFile) || state.config.live?.origin !== cfg.origin)
          throw new Error('Running runtime source/origin does not match the capture target');
        if (state.status.live?.connected) throw new Error('Runtime already has a live connection; disconnect it before shell capture');
      } else {
        await assertOfflineState(target.mirage.stateFile);
        simulator = await createLocalSimulator({ sourceDir: target.sourceDir, stateFile: target.mirage.stateFile, origin: cfg.origin, port: 0, watch: false, solutionRoots: target.solutionRoots, dataPacks: cfg.mirageConfig.dataPacks, observed: cfg.mirageConfig.observed, localOverrides: cfg.mirageConfig.localOverrides });
        // A cached state may have been last used with another selected environment.
        const state = simulator.store.snapshot();
        state.simulator.live = { ...(state.simulator.live ?? {}), origin: cfg.origin };
        await simulator.store.replaceState(state);
        simulator.live.configure(state.simulator.live);
        client = await connectRuntime({ origin: simulator.url });
      }
      const cdpUrl = cdp ?? (browser = await launchBrowser(cfg.browser.channel)).cdp;
      reports.push({ site: cfg.siteName, env: cfg.envName, ...await captureThroughRuntime(client, cdpUrl, pagePath) });
    } finally { try { await simulator?.close(); } finally { await browser?.close(); } }
  }
  return { schemaVersion: 1, command: 'capture-shell', reports, skipped, complete: reports.every(report => report.complete) };
}

export function captureSummary(report) {
  return (report.reports ?? []).flatMap(item => {
    const failures = [...(item.failures ?? [])].sort((a, b) => Number(Boolean(b.blocking)) - Number(Boolean(a.blocking)));
    return [`Shell ${item.site}: ${item.applied ? 'applied' : 'not applied'}`, ...failures.map(failure =>
      `  ${failure.blocking ? 'BLOCKING' : 'observed'} ${failure.code}: ${failure.path}${failure.host ? ` [${failure.host}: ${failure.reason ?? 'excluded'}]` : ''} — ${failure.message}`)];
  }).join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { config: { type: 'string' }, site: { type: 'string' }, env: { type: 'string' }, all: { type: 'boolean' }, path: { type: 'string' }, cdp: { type: 'string' }, json: { type: 'boolean' } } });
    const report = await captureShell(values);
    if (!values.json) console.error(captureSummary(report));
    console.log(JSON.stringify(report, null, 2)); process.exitCode = report.complete ? 0 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
