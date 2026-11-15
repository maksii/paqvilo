import { readFile } from 'node:fs/promises';
import { appsShellPage } from './apps-shell.mjs';
import { escapeHtml } from '../admin/ui-kit.mjs';

const assets = new Map([
  ['_player.js', ['text/javascript; charset=utf-8', new URL('./canvas-player.js', import.meta.url)]],
  ['_shell-menu.js', ['text/javascript; charset=utf-8', new URL('../admin/shell-menu.js', import.meta.url)]],
  ['canvas-pcf-client.js', ['text/javascript; charset=utf-8', new URL('./canvas-pcf-client.js', import.meta.url)]],
  [
    'model-driven/pcf-runtime.mjs',
    ['text/javascript; charset=utf-8', new URL('./model-driven/pcf-runtime.mjs', import.meta.url)],
  ],
  ['canvas-display.mjs', ['text/javascript; charset=utf-8', new URL('./canvas-display.mjs', import.meta.url)]],
  ['_player.css', ['text/css; charset=utf-8', new URL('./canvas-player.css', import.meta.url)]],
  ['_ui-kit.css', ['text/css; charset=utf-8', new URL('../admin/ui-kit.css', import.meta.url)]],
  ['_shell.css', ['text/css; charset=utf-8', new URL('../admin/shell.css', import.meta.url)]],
  // The served pcf-runtime.mjs imports ../date-only-format.mjs, which resolves to this path under the Canvas mount.
  ['date-only-format.mjs', ['text/javascript; charset=utf-8', new URL('./date-only-format.mjs', import.meta.url)]],
]);
export const canvasPlayerAssetNames = [...assets.keys()];
// The player is a classic script, so the gesture trace helper (an ES module, lib/trace-gesture.js) is served in front of it
// with its export removed. Read once: the texts do not change while the server runs.
const playerScript =
  (await readFile(new URL('./trace-gesture.js', import.meta.url), 'utf8')).replace(/^export /m, '') +
  (await readFile(new URL('./canvas-player.js', import.meta.url), 'utf8'));
export async function canvasPlayerAsset(name) {
  const asset = assets.get(name);
  if (!asset) return null;
  return { type: asset[0], body: name === '_player.js' ? Buffer.from(playerScript) : await readFile(asset[1]) };
}
// trace: the page root ({ traceId, spanId }, X-Trace-Id / X-Sim-Span-Id of its response): the player sends both on its
// driver calls, so every action joins the page trace (docs/design/tracing.md).
// Where the app is served from and what a source edit does there (the wording of canvas-apps.md). An origin without a
// path leaves the path out of the sentence.
const originText = (origin, uniqueName) => {
  const where = origin?.path ? escapeHtml(origin.path) : '';
  if (origin?.kind === 'canvas.sources') {
    const location = where ? `: ${where}` : '';
    return `Served from canvas.sources${location}. Saved edits reload the app; Start runs the new version.`;
  }
  const location = where ? ` ${where}` : '';
  return `Served from the Solution's packed app${location}. To make source edits reload the app, add the app's extracted folder, named ${escapeHtml(uniqueName)}, to canvas.sources.`;
};
export function canvasPlayerPage(app, csrf, trace = {}) {
  const name = escapeHtml(app.source.app.name);
  return appsShellPage({
    title: app.source.app.name,
    prefix: '/_apps/canvas/',
    crumbs: [['Simulator', '/_sim/'], ['Canvas apps', '/_apps/canvas/'], [app.source.app.name]],
    head: '<link rel="stylesheet" href="/_apps/canvas/_player.css"><script defer src="/_apps/canvas/_player.js"></script>',
    bodyAttributes: `data-app="${escapeHtml(app.uniqueName)}" data-csrf="${escapeHtml(csrf)}" data-trace-id="${escapeHtml(trace.traceId)}" data-trace-parent="${escapeHtml(trace.spanId)}"`,
    body:
      `<div class="canvas-toolbar"><h1>${name}</h1><button class="button" data-testid="canvas-start">Start the app</button><button class="button" data-testid="canvas-restart" hidden>Restart the app</button><label>Resolution <select data-testid="canvas-resolution"><option value="1366x768">1366 × 768</option><option value="1280x720">1280 × 720</option><option value="1024x768">1024 × 768</option><option value="768x1024">768 × 1024</option><option value="390x844">390 × 844</option><option value="browser">Browser viewport</option></select></label><label>Zoom <select data-testid="canvas-zoom"><option value="fit">Fit to window</option><option value="1">100%</option></select></label><a href="?view=inspect">Inspect inventory and headless state</a></div>` +
      `<p data-testid="canvas-status" role="status">The app has not been started. Start runs its OnStart formula.</p><p class="muted" data-testid="canvas-origin">${originText(app.source.app.origin, app.uniqueName)}</p>` +
      `<div class="canvas-main"><div class="stage-scroll"><div class="canvas-fit"><div class="canvas-surface"><div data-testid="canvas-stage" class="stage"></div><div data-testid="canvas-notifications" class="canvas-notifications"></div></div></div></div><aside data-testid="canvas-inspector"><h2>Inspector</h2><p>Start the app to inspect its state. Browser developer tools are available; Power Fx stepping is not supported.</p></aside></div>`,
  });
}
