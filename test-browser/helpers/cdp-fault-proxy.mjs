import { createRequire } from 'node:module';
import path from 'node:path';
import { once, EventEmitter } from 'node:events';

// The pinned browser driver already bundles the WebSocket transport. This
// fixture uses it as an independent wire proxy, without replacing CDP.send or
// any toolkit implementation. No protocol payloads are logged or persisted.
const require = createRequire(import.meta.url);
const { ws: WebSocket, wsServer: WebSocketServer } = require(
  path.join(path.dirname(require.resolve('playwright-core/package.json')), 'lib/utilsBundle.js'),
);

export async function createCdpFaultProxy(endpoint, signal) {
  const url = new URL(endpoint);
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1') throw Error('CDP fixture must be loopback');
  const events = new EventEmitter();
  const peers = new Set();
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening', { signal });
  let armed;
  const dropped = [];
  server.on('connection', (client) => {
    const upstream = new WebSocket(endpoint);
    peers.add(client);
    peers.add(upstream);
    const requests = new Map(),
      explicitSessions = new Set(),
      queued = [];
    client.on('message', (bytes) => {
      const message = JSON.parse(bytes.toString());
      if (armed && message.method === 'Page.getFrameTree' && explicitSessions.has(message.sessionId)) {
        const fault = armed;
        armed = null;
        dropped.push({ method: message.method, sessionId: message.sessionId });
        fault.resolve(dropped.at(-1));
        return; // The actual command receives no response; the toolkit's real deadline must fire.
      }
      if (message.id) requests.set(message.id, message);
      if (upstream.readyState === WebSocket.OPEN) upstream.send(bytes.toString());
      else queued.push(bytes.toString());
    });
    upstream.on('open', () => {
      for (const message of queued) upstream.send(message);
      queued.length = 0;
    });
    upstream.on('message', (bytes) => {
      const message = JSON.parse(bytes.toString());
      const request = requests.get(message.id);
      requests.delete(message.id);
      if (request?.method === 'Target.attachToTarget' && message.result?.sessionId)
        explicitSessions.add(message.result.sessionId);
      if (request && !message.error) events.emit('ack:' + request.method, message.result);
      if (client.readyState === WebSocket.OPEN) client.send(bytes.toString());
    });
    for (const [peer, other] of [
      [client, upstream],
      [upstream, client],
    ]) {
      peer.on('error', () => other.terminate());
      peer.on('close', () => {
        peers.delete(peer);
        other.terminate();
      });
    }
  });
  return {
    endpoint: `ws://127.0.0.1:${server.address().port}`,
    dropped,
    nextAck: (method) => once(events, 'ack:' + method, { signal }),
    arm() {
      if (armed) throw Error('A protocol fault is already armed');
      armed = Promise.withResolvers();
      return armed.promise;
    },
    disconnect() {
      for (const peer of peers) peer.terminate();
    },
    async close() {
      for (const peer of peers) peer.terminate();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
