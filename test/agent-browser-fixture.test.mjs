import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { agentBrowserFixture } from '../test-browser/support/agent-fixture.mjs';
for (const failure of ['server', 'browser', 'context', 'page', 'agent', null]) {
  test(`agent fixture drains exactly acquired resources after ${failure ?? 'successful acquisition'}`, async () => {
    const after = [],
      events = [];
    const fail = (stage) => {
      if (failure === stage) throw Error(stage);
    };
    const server = Object.assign(new EventEmitter(), {
      listen() {
        queueMicrotask(() =>
          server.emit(failure === 'server' ? 'error' : 'listening', failure === 'server' ? Error('server') : undefined),
        );
      },
      address: () => ({ port: 12345 }),
      closeAllConnections: () => events.push('connections'),
      close: (callback) => {
        events.push('server');
        callback();
      },
    });
    const browser = {
      newContext: async () => {
        fail('context');
        return {
          newPage: async () => {
            fail('page');
            return {};
          },
        };
      },
      close: () => events.push('browser'),
    };
    const fixture = agentBrowserFixture({ after: (callback) => after.push(callback) }, 'paqvilo-agent-owned-', {
      createServer: () => server,
      launchBrowser: async () => {
        fail('browser');
        return browser;
      },
      startAgent: async () => {
        fail('agent');
        return { close: () => events.push('agent') };
      },
    });
    const acquire = async () => fixture.launch(await fixture.serve(() => {}));
    if (failure) await assert.rejects(acquire, { message: failure });
    else await acquire();
    assert.equal(after.length, 1);
    assert.equal(fs.existsSync(fixture.work), true);
    await after[0]();
    assert.equal(fs.existsSync(fixture.work), false);
    assert.deepEqual(events, [
      ...(failure === null ? ['agent'] : []),
      ...(!['server', 'browser'].includes(failure) ? ['browser'] : []),
      'connections',
      'server',
    ]);
  });
}
