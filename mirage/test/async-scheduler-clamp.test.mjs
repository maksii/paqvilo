// The default async scheduler: delays above the timer limit are clamped, and close(api) clears pending timers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { close, defaultSchedule } from '../lib/dataverse-async.mjs';

const MAX_TIMER_DELAY = 2 ** 31 - 1;
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

function fakeTimers(t) {
  const created = [];
  const cleared = [];
  t.mock.method(globalThis, 'setTimeout', (task, delay) => {
    const handle = {
      task,
      delay,
      unrefed: false,
      unref() {
        this.unrefed = true;
        return this;
      },
    };
    created.push(handle);
    return handle;
  });
  t.mock.method(globalThis, 'clearTimeout', (handle) => {
    cleared.push(handle);
  });
  return { created, cleared };
}

test('a postponed job 30 days ahead arms a clamped, unref-ed timer', async (t) => {
  const { created } = fakeTimers(t);
  const api = {};
  let ran = false;
  defaultSchedule(
    api,
    () => {
      ran = true;
    },
    THIRTY_DAYS,
  );
  assert.equal(created.length, 1);
  assert.equal(created[0].delay, MAX_TIMER_DELAY);
  assert.equal(created[0].unrefed, true);
  assert.equal(ran, false);
});

test('a delay within the limit is passed through unchanged', async (t) => {
  const { created } = fakeTimers(t);
  defaultSchedule({}, () => {}, 5000);
  assert.equal(created[0].delay, 5000);
});

test('close(api) clears the pending timers and schedules nothing afterwards', async (t) => {
  const { created, cleared } = fakeTimers(t);
  const api = {};
  let ran = false;
  defaultSchedule(
    api,
    () => {
      ran = true;
    },
    THIRTY_DAYS,
  );
  close(api);
  assert.deepEqual(cleared, [created[0]]);
  defaultSchedule(
    api,
    () => {
      ran = true;
    },
    1000,
  );
  defaultSchedule(
    api,
    () => {
      ran = true;
    },
    0,
  );
  assert.equal(created.length, 1, 'no timer is armed after close');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ran, false);
});

test('close(api) leaves another API scheduler running', async (t) => {
  const { created, cleared } = fakeTimers(t);
  const closed = {};
  const other = {};
  defaultSchedule(closed, () => {}, THIRTY_DAYS);
  defaultSchedule(other, () => {}, THIRTY_DAYS);
  close(closed);
  assert.deepEqual(cleared, [created[0]]);
  defaultSchedule(other, () => {}, 1000);
  assert.equal(created.length, 3);
});
