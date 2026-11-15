// @test-kind contract+security: setup rejects invalid CSRF requests before asynchronous work and preserves error response ordering.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createSetupHandler } from '../lense/setup/server.mjs';

test('invalid setup CSRF is rejected before an independently queued callback', async () => {
  const events = [];
  let saves = 0;
  const store = {
    kind: 'project',
    file: path.resolve('unwritten-setup-config.json'),
    save() {
      saves++;
    },
  };
  const handler = await createSetupHandler({ store });
  const headers = {
    host: '127.0.0.1:8790',
    origin: 'http://127.0.0.1:8790',
    get ['x-paqvilo-setup-csrf']() {
      events.push('token');
      queueMicrotask(() => events.push('marker'));
      return 'bad';
    },
  };
  const req = {
    url: '/_setup/api/config',
    method: 'POST',
    headers,
    socket: { localAddress: '127.0.0.1', localPort: 8790 },
  };
  const res = {
    writeHead(status) {
      events.push(`status:${status}`);
    },
    end() {
      events.push('end');
    },
  };
  assert.equal(await handler(req, res), true);
  assert.equal(saves, 0);
  assert.deepEqual(events, ['token', 'status:403', 'end', 'marker']);
});
