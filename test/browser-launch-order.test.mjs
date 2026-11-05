// @test-kind contract: browser startup begins its owned context cookie read before later close events.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { openBrowser } from '../lense/browser.mjs';

test('owned browser starts cookie restore before a subsequent context close', async (t) => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-browser-order-'));
  t.after(() => fs.rmSync(profileDir, { recursive: true, force: true }));
  const context = new EventEmitter(),
    events = [];
  let closed = false;
  context.cookies = () => {
    events.push(closed ? 'cookies:closed' : 'cookies:open');
    return closed ? Promise.reject(new Error('closed by owner')) : Promise.resolve([]);
  };
  context.close = async () => {
    if (!closed) {
      closed = true;
      events.push('close');
      context.emit('close');
    }
  };
  t.mock.method(chromium, 'launchPersistentContext', () => {
    events.push('launch');
    return Promise.resolve(context);
  });
  const opening = openBrowser(
    { configDir: profileDir, siteName: 'test', envName: 'dev', browser: { channel: 'chromium', headless: true } },
    { profileDir },
  );
  queueMicrotask(() => {
    closed = true;
    events.push('close');
    context.emit('close');
  });
  const opened = await opening;
  t.after(() => opened.close());
  assert.deepEqual(events.slice(0, 3), ['launch', 'cookies:open', 'close']);
  await opened.close();
});
