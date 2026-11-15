// @test-kind contract: browser startup begins its owned context cookie read before later close events.
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
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
  ownedFixture(t).remove(() => fs.rmSync(profileDir, { recursive: true, force: true }));
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
    {
      configDir: profileDir,
      siteName: 'test',
      envName: 'dev',
      origin: 'http://127.0.0.1:4100',
      browser: { channel: 'chromium', headless: true },
    },
    { profileDir },
  );
  queueMicrotask(() => {
    closed = true;
    events.push('close');
    context.emit('close');
  });
  const opened = await opening;
  ownedFixture(t).add(() => opened.close());
  assert.deepEqual(events.slice(0, 3), ['launch', 'cookies:open', 'close']);
  await opened.close();
});

test('owned browser without a portal origin neither reads nor rewrites the stored session cookies', async (t) => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-browser-no-origin-'));
  const sessionFile = `${profileDir}.session.json`;
  t.after(() => {
    fs.rmSync(profileDir, { recursive: true, force: true });
    fs.rmSync(sessionFile, { force: true });
  });
  const stored = `${JSON.stringify([
    { name: 'paqvilo-mirage-auth-4100', value: 'stored', domain: '127.0.0.1', path: '/', expires: -1 },
  ])}\n`;
  fs.writeFileSync(sessionFile, stored);
  const context = new EventEmitter(),
    calls = [];
  context.cookies = async () => {
    calls.push('cookies');
    return [];
  };
  context.addCookies = async () => {
    calls.push('addCookies');
  };
  context.close = async () => {
    calls.push('close');
    context.emit('close');
  };
  t.mock.method(chromium, 'launchPersistentContext', () => Promise.resolve(context));
  const opened = await openBrowser(
    { configDir: profileDir, siteName: 'test', envName: 'dev', browser: { channel: 'chromium', headless: true } },
    { profileDir },
  );
  await opened.close();
  assert.deepEqual(calls, ['close']);
  assert.equal(fs.readFileSync(sessionFile, 'utf8'), stored);
});
