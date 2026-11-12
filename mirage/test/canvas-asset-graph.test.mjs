// @test-kind contract: the Canvas player answers every JavaScript module its pages import at the URL that import resolves to.
import test from 'node:test';
import http from 'node:http';
import { createCanvasHandler } from '../lib/canvas-http.mjs';
import { canvasPlayerAssetNames } from '../lib/canvas-player.mjs';
import { assertStaticImportsServed } from './support/asset-graph.mjs';

const closeServer = (server) => {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
};

test('every static import of a served Canvas player module resolves to a served JavaScript module', async (t) => {
  const handler = createCanvasHandler({
    apps: () => [],
    csrf: () => 'token',
    principal: () => ({ kind: 'staff', principalId: 'local' }),
    runtime: { existing: () => null, session: async () => ({}) },
  });
  const server = http.createServer((req, res) => {
    if (!handler(req, res)) res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => closeServer(server));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const entries = canvasPlayerAssetNames
    .filter((name) => /\.m?js$/.test(name))
    .map((name) => `${origin}/_apps/canvas/${name}`);
  await assertStaticImportsServed(entries);
});
