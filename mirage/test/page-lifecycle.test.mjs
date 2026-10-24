import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { observePageLifecycle, observeContextLifecycle } from '../lib/page-lifecycle.mjs';

const options = { origin: 'http://127.0.0.1:8787' };
const listeners = (emitter) => emitter.eventNames().flatMap((name) => emitter.listeners(name));

test('an unsupported page attachment removes all request listeners', async () => {
  const page = new EventEmitter();
  page.context = () => ({
    newCDPSession: async () => {
      throw new Error('unsupported browser');
    },
  });
  await assert.rejects(observePageLifecycle(page, options), /unsupported browser/);
  assert.equal(listeners(page).length, 0);
});

test('document-observation initialization failure cleans lifecycle listeners and its CDP session', async () => {
  const page = new EventEmitter(),
    cdp = new EventEmitter();
  let detached = false;
  cdp.send = async (name) => {
    if (name === 'Page.enable') throw new Error('page closed');
  };
  cdp.detach = async () => {
    detached = true;
  };
  page.exposeBinding = async () => {};
  page.context = () => ({ newCDPSession: async () => cdp });
  await assert.rejects(observePageLifecycle(page, options), /page closed/);
  assert.equal(listeners(page).length, 0);
  assert.equal(listeners(cdp).length, 0);
  assert.equal(detached, true);
});

test('a failed future page attachment stays visible after its asynchronous setup finishes', async () => {
  const context = new EventEmitter();
  context.pages = () => [];
  const observer = await observeContextLifecycle(context, options);
  const page = new EventEmitter();
  page.context = () => ({
    newCDPSession: async () => {
      throw new Error('future attachment failed');
    },
  });
  context.emit('page', page);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(observer.ready(), /future attachment failed/);
  await assert.rejects(observer.settle(), /future attachment failed/);
  await observer.dispose();
  assert.equal(listeners(context).length, 0);
  assert.equal(listeners(page).length, 0);
});

test('context settling bounds pending attachment by the same deadline as page work', { timeout: 2000 }, async () => {
  const context = new EventEmitter();
  context.pages = () => [];
  const observer = await observeContextLifecycle(context, options);
  let rejectAttachment;
  const page = new EventEmitter();
  page.context = () => ({
    newCDPSession: () =>
      new Promise((_resolve, reject) => {
        rejectAttachment = reject;
      }),
  });
  context.emit('page', page);
  try {
    const report = await observer.settle({ timeout: 30 });
    assert.equal(report.settled, false);
    assert.equal(report.passed, false);
    assert.equal(report.pendingAttachments, 1);
    assert.ok(report.waitedMs < 500, 'attachment does not escape the caller deadline');
  } finally {
    rejectAttachment(new Error('invented slow attachment failure'));
    await new Promise((resolve) => setImmediate(resolve));
    await observer.dispose();
  }
});
