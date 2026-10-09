// An offline demonstration using production browser/session code and disposable synthetic sources.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';
import { loadDevTargets } from '../lense/config.mjs';
import { openBrowser } from '../lense/browser.mjs';
import { startDevSessions } from '../lense/dev-sessions.mjs';
import { readDiscovery, agentRequest } from '../lense/commands/agent.mjs';

const { values } = parseArgs({ options: { browser: { type: 'string', default: process.platform === 'win32' ? 'msedge' : 'chromium' }, headless: { type: 'boolean' }, evidence: { type: 'boolean' } } });
if (!['msedge', 'chrome', 'chromium'].includes(values.browser)) throw new Error('--browser must be msedge, chrome or chromium');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = path.join(root, '.paqvilo', 'demo', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(work, { recursive: true });
const servers = [];
let browser;
let runtime;
let stop;
const stopped = new Promise((resolve) => { stop = resolve; });
const log = [];
const failures = [];
const networkFailures = [];
const saved = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const stylesheet = `:root{font:16px/1.5 system-ui;color:#18324f;background:#f4f7fb}body{margin:0}main{max-width:1050px;margin:auto;padding:56px 24px 140px}h1{font-size:44px;line-height:1.1}h2{font-size:20px}.label{font-weight:700;font-size:12px;letter-spacing:.1em;color:#496c90}.card{background:white;border:1px solid #d6e1ed;border-radius:14px;padding:24px;box-shadow:0 8px 20px #18324f08}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin:28px 0}strong{color:#087761}.status{color:#087761;background:#e7f8ef;border-radius:7px;padding:14px}table{width:100%;border-collapse:collapse}td,th{padding:12px;text-align:left;border-bottom:1px solid #e3eaf2}button{font:inherit;border:0;border-radius:6px;background:#1764a5;color:white;padding:8px 14px}a{color:#1764a5}@media(max-width:700px){.grid{grid-template-columns:1fr}h1{font-size:32px}}`;

try {
  const sites = {};
  for (const [index, name] of ['workspace', 'sandbox'].entries()) {
    const source = path.join(work, name);
    const id = `00000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`;
    saved(path.join(source, 'website.yml'), YAML.stringify({ adx_websiteid: id, adx_name: `Synthetic ${name}` }));
    saved(path.join(source, 'web-pages/home/Home.webpage.yml'), YAML.stringify({ adx_webpageid: id, adx_partialurl: '/', adx_name: 'Standalone preview' }));
    saved(path.join(source, 'web-files/theme.css.webfile.yml'), YAML.stringify({ adx_name: 'theme.css', adx_partialurl: 'theme.css', adx_parentpageid: id, filename: 'theme.css' }));
    saved(path.join(source, 'web-files/theme.css'), stylesheet);
    saved(path.join(source, 'web-files/app.js.webfile.yml'), YAML.stringify({ adx_name: 'app.js', adx_partialurl: 'app.js', adx_parentpageid: id, filename: 'app.js' }));
    saved(path.join(source, 'web-files/app.js'), 'document.querySelector("#source-value").textContent = "Local source applied";\n');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
    const git = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', ...args], { cwd: source, env, stdio: 'pipe', windowsHide: true, timeout: 30_000 });
    git('init', '-q', '--initial-branch=main');
    git('add', '-A');
    git('-c', 'user.name=Local demo', '-c', 'user.email=demo@localhost', 'commit', '-qm', 'Synthetic portal baseline');
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>paqvilo — standalone preview</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/theme.css"></head><body><main><div class="label">PAQVILO LENSE · LOOPBACK DEMONSTRATION</div><h1>Your portal checkout.<br>Your branch. Your browser.</h1><p>The toolkit runs independently and overlays local files through its production development session.</p><div class="status"><strong id="source-value">Online baseline</strong> · ${name} @ demo · synthetic data</div><div class="grid"><section class="card"><h2>Independent repository</h2><p>Settings, dependencies and browser state stay in <b>paqvilo</b>.</p></section><section class="card"><h2>Separate source checkout</h2><p>Select any clone or worktree with <b>--repo</b> or <b>PAQVILO_REPO</b>.</p></section><section class="card"><h2>Save and preview</h2><p>Local JavaScript reloads automatically. Styles update without navigation.</p></section></div><section class="card"><h2>Active development loop</h2><table><thead><tr><th>Capability</th><th>Observed state</th></tr></thead><tbody><tr><td>Local source overlay</td><td id="overlay-state">Applied</td></tr><tr><td>Portal / environment selector</td><td>Two isolated loopback targets</td></tr><tr><td>Browser diagnostics</td><td>Captured by the local agent API</td></tr><tr><td>Source edits</td><td>Disposable synthetic checkout</td></tr></tbody></table></section><p>Open the LOCAL panel with <b>Alt+Shift+P</b> to inspect overrides and switch targets.</p></main><script src="/app.js"></script></body></html>`;
    const server = http.createServer((req, res) => {
      if (req.method !== 'GET' || !req.url.startsWith('/')) return res.writeHead(403).end();
      if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
      if (req.url === '/theme.css') return res.writeHead(200, { 'content-type': 'text/css' }).end(stylesheet);
      if (req.url === '/app.js') return res.writeHead(200, { 'content-type': 'application/javascript' }).end('document.querySelector("#source-value").textContent = "Online baseline";');
      res.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    servers.push(server);
    sites[name] = { source, environments: { demo: `http://127.0.0.1:${server.address().port}` } };
  }
  const config = path.join(work, 'paqvilo.config.yml');
  saved(config, YAML.stringify({ defaultSite: 'workspace', sites, browser: { channel: values.browser, headless: Boolean(values.headless || values.evidence), debugPort: null }, panel: true, sourceMaps: true }));
  const selection = await loadDevTargets({ config, portals: 'all' }, {});
  browser = await openBrowser(selection.initial);
  browser.context.once('close', stop);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const origins = new Set(selection.targets.map((target) => target.origin));
  await browser.context.route('**/*', (route) => origins.has(new URL(route.request().url()).origin) ? route.continue() : route.abort('blockedbyclient'));
  runtime = await startDevSessions(browser.context, selection, { stop, log: (message) => { log.push(message); console.log(message); } });
  const page = browser.context.pages()[0] ?? await browser.context.newPage();
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('console', (message) => { if (['error', 'warning'].includes(message.type())) failures.push(`${message.type()}: ${message.text()}`); });
  page.on('requestfailed', (request) => networkFailures.push({ url: request.url(), error: request.failure()?.errorText }));
  page.on('response', (response) => { if (response.status() >= 400) networkFailures.push({ url: response.url(), status: response.status() }); });
  await page.goto(selection.initial.origin, { waitUntil: 'networkidle' });
  console.log(`\nDemo running at ${selection.initial.origin}; sources: ${work}\nCtrl+C or close the demo browser to stop.`);
  if (values.evidence) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForFunction(() => document.querySelector('#source-value')?.textContent === 'Local source applied');
    await page.screenshot({ path: path.join(work, 'standalone-desktop.png'), fullPage: true });
    const record = runtime.active.get(selection.initial.origin);
    await page.keyboard.press('Alt+Shift+P');
    await record.panel.draw(page);
    await page.screenshot({ path: path.join(work, 'standalone-panel.png'), fullPage: true });
    await page.keyboard.press('Alt+Shift+P');
    const refreshed = once(record.session, 'refreshed', { signal: AbortSignal.timeout(15_000) });
    saved(path.join(selection.initial.sourceDir, 'web-files/app.js'), 'document.querySelector("#source-value").textContent = "Saved JavaScript reloaded";\n');
    await refreshed;
    await page.waitForFunction(() => document.querySelector('#source-value')?.textContent === 'Saved JavaScript reloaded');
    await page.screenshot({ path: path.join(work, 'standalone-live-reload.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 850 });
    await page.screenshot({ path: path.join(work, 'standalone-mobile.png'), fullPage: true });
    await page.goto(selection.targets[1].origin, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelector('#source-value')?.textContent === 'Local source applied');
    const reports = [];
    for (const target of selection.targets) {
      const current = runtime.active.get(target.origin);
      const status = await agentRequest(await readDiscovery(current.agent.discoveryFile), '/v1/session');
      reports.push({ site: target.siteName, source: target.sourceDir, warnings: current.session.model.warnings, needsDeploy: current.session.rewriter.unsupported, status });
    }
    const passed = failures.length === 0 && networkFailures.length === 0 && reports.every((report) => report.warnings.length === 0 && report.needsDeploy.length === 0);
    saved(path.join(work, 'evidence.json'), JSON.stringify({ passed, browser: values.browser, sourceReloadVerified: true, targetSwitchVerified: true, failures, networkFailures, reports }, null, 2));
    if (!passed) throw new Error(`Demo diagnostics failed; inspect ${path.join(work, 'evidence.json')}`);
    console.log(`Evidence passed: ${work}`);
  } else await stopped;
} finally {
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  await runtime?.close();
  await browser?.close();
  for (const server of servers) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  saved(path.join(work, 'demo.log'), log.join('\n'));
}
