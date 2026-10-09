// Offline, read-only timing of real toolkit paths. No browser, portal requests or source edits.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { loadConfig } from '../lense/config.mjs';

const round = (n) => Math.round(n * 100) / 100;
const summarize = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return { samplesMs: samples.map(round), medianMs: round(sorted[Math.floor(sorted.length / 2)]), p95Ms: round(sorted[Math.ceil(sorted.length * 0.95) - 1]) };
};

try {
  const { values } = parseArgs({ options: {
    site: { type: 'string' }, config: { type: 'string' }, samples: { type: 'string', default: '5' },
    implementation: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('npm run benchmark -- --site <site> [--samples 1..20] [--json]\nOffline, read-only startup and unchanged-save timings. --implementation <src-directory> compares a saved implementation. Disk cache and concurrent work affect results.');
  } else {
    if (!/^\d+$/.test(values.samples) || Number(values.samples) < 1 || Number(values.samples) > 20) throw new Error('--samples must be an integer from 1 to 20');
    const cfg = await loadConfig({ site: values.site, config: values.config });
    const root = values.implementation ? path.resolve(values.implementation) : path.resolve(import.meta.dirname, '../src');
    const { OverlaySession } = await import(pathToFileURL(path.join(root, 'session.mjs')).href);
    const sampleCount = Number(values.samples);
    let session;
    const timed = async (operation) => {
      const values = [];
      for (let i = 0; i < sampleCount; i++) {
        const started = performance.now();
        await operation();
        values.push(performance.now() - started);
      }
      return summarize(values);
    };
    const before = process.memoryUsage();
    const startup = await timed(async () => {
      session = typeof OverlaySession.create === 'function' ? await OverlaySession.create(cfg) : new OverlaySession(cfg);
    });
    const webFile = session.model.webFiles.find((file) => file.file && /\.css$/i.test(file.url) && session.resolver.resolve(file.url)?.file === file.file);
    const inline = session.rewriter.blocks.find((source) => source.kind === 'page-js' && !source.extract && source.text.trim());
    const timings = { startup };
    // Named paths force the normal invalidation/refresh path without changing the extract.
    if (webFile) {
      const prepare = [], tracking = [], total = [];
      for (let i = 0; i < sampleCount; i++) {
        const started = performance.now();
        const result = session.refresh([webFile.file], { deferChangeTracking: true });
        const prepared = performance.now();
        if (result?.changeTrackingDeferred) await session.refreshChangeTracking([webFile.file]);
        const completed = performance.now();
        prepare.push(prepared - started);
        tracking.push(completed - prepared);
        total.push(completed - started);
      }
      timings.webFilePrepare = summarize(prepare);
      timings.webFileChangeTracking = summarize(tracking);
      timings.webFileRefresh = summarize(total);
    }
    const refresh = (files) => typeof session.refreshAsync === 'function' ? session.refreshAsync(files) : session.refresh(files);
    if (inline) timings.inlineRefresh = await timed(() => refresh([inline.file]));
    timings.fullRefresh = await timed(() => refresh());
    timings.unrelatedSave = await timed(() => refresh([path.join(cfg.sourceDir, '__benchmark_note__.txt')]));
    const after = process.memoryUsage();
    const report = {
      offline: true, sourceWrites: false, site: cfg.siteName, source: cfg.sourceDir, implementation: root,
      scope: cfg.site.scope, node: process.version, samples: sampleCount,
      webFileChangeTrackingMeasured: typeof session.refreshChangeTracking === 'function',
      counts: { pages: session.model.pages.size, webFiles: session.model.webFileByUrl.size, inlineSources: session.model.inlineSources.length },
      refreshSources: { webFile: webFile ? session.rel(webFile.file) : null, inline: inline?.rel ?? null },
      timings, memory: { rssBytes: after.rss, heapUsedBytes: after.heapUsed, rssGrowthBytes: after.rss - before.rss },
      note: 'Refreshes invalidate named unchanged files. unrelatedSave uses an absent note path (as when deleting an unrelated file) without writing sources. Web file preparation makes new bytes available; change tracking runs afterward, with both included in webFileRefresh. Legacy implementations without refreshChangeTracking may perform tracking outside these measured paths; their zero tracking time is not a cost comparison. Browser rendering is not measured. Memory is an end-of-run snapshot, not peak or retained-heap proof. Compare medians on the same checkout; OS disk cache and concurrent work affect timings.',
    };
    if (values.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`Offline benchmark: ${report.site}, ${report.counts.inlineSources} inline sources, ${sampleCount} samples`);
      for (const [name, timing] of Object.entries(timings)) console.log(`${name.padEnd(20)} median ${timing.medianMs} ms, p95 ${timing.p95Ms} ms`);
      console.log(`RSS ${round(after.rss / 1024 / 1024)} MiB; ${report.note}`);
    }
  }
} catch (err) {
  console.error(`benchmark: ${err.message}`);
  process.exitCode = 1;
}
