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
  site ??= catalogue.settings.values.PAQVILO_SITE ?? catalogue.root.defaultSite ?? Object.keys(catalogue.sites)[0];
  if (!catalogue.sites[site]) throw new Error(`Unknown site '${site}'`);
  const environments = all ? Object.keys(catalogue.sites[site].environments) : [env];
  // Validate every target before opening any browser or changing local state.
  const targets = await Promise.all(environments.map(env => loadConfig({ config, site, env }, process.env)));
  if (targets.some(cfg => cfg.caution)) throw new Error('Shell capture refuses caution environments');
  const resolved = await resolveCatalogue({ config });
  const target = resolved.sites.find(item => item.name === site);
  const reports = [];
  for (const cfg of targets) {
    let browser, simulator;
    try {
      const cdpUrl = cdp ?? (browser = await launchBrowser(cfg.browser.channel)).cdp;
      const running = (await discoveries(miragePaths(cfg), { probe: false })).filter(item => item.processAlive && (samePath(item.sourceDir, target.sourceDir) || item.stateFile && samePath(item.stateFile, target.mirage.stateFile)));
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
      reports.push({ site, env: cfg.envName, ...await captureThroughRuntime(client, cdpUrl, pagePath) });
    } finally { try { await simulator?.close(); } finally { await browser?.close(); } }
  }
  return { schemaVersion: 1, command: 'capture-shell', reports, complete: reports.every(report => report.complete) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { config: { type: 'string' }, site: { type: 'string' }, env: { type: 'string' }, all: { type: 'boolean' }, path: { type: 'string' }, cdp: { type: 'string' }, json: { type: 'boolean' } } });
    const report = await captureShell(values); console.log(JSON.stringify(report, null, 2)); process.exitCode = report.complete ? 0 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
