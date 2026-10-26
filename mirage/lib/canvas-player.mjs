import { readFile } from 'node:fs/promises';

const assets = new Map([
  ['_player.js', ['text/javascript; charset=utf-8', new URL('./canvas-player.js', import.meta.url)]],
  ['_player.css', ['text/css; charset=utf-8', new URL('./canvas-player.css', import.meta.url)]],
]);
export async function canvasPlayerAsset(name) {
  const asset = assets.get(name);
  return asset ? { type: asset[0], body: await readFile(asset[1]) } : null;
}
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
export function canvasPlayerPage(app, csrf) {
  const name = esc(app.source.app.name);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${name}</title><link rel="stylesheet" href="/_apps/canvas/_player.css"><script defer src="/_apps/canvas/_player.js"></script></head><body data-app="${esc(app.uniqueName)}" data-csrf="${esc(csrf)}"><header><h1>${name}</h1><button data-testid="canvas-start">Start the app</button><label>Resolution <select data-testid="canvas-resolution"><option value="1366x768">1366 × 768</option><option value="1280x720">1280 × 720</option><option value="1024x768">1024 × 768</option><option value="768x1024">768 × 1024</option><option value="390x844">390 × 844</option></select></label><a href="?view=inspect">Inspect inventory and headless state</a></header><p data-testid="canvas-status" role="status">The app has not been started. Start runs its OnStart formula.</p><main><div class="stage-scroll"><div data-testid="canvas-stage" class="stage"></div></div><aside data-testid="canvas-inspector"><h2>Inspector</h2><p>Start the app to inspect its state. Browser developer tools are available; Power Fx stepping is not supported.</p></aside></main></body></html>`;
}
