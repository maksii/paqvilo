// @test-kind contract: the supplied flows view context observes the original notification property and coercion order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { view } from '../admin/view-flows.mjs';

function flowCase(events, result) {
  let finished;
  const done = new Promise((resolve) => {
    finished = resolve;
  });
  const form = { dataset: { flowWaitForm: 'wait-1' }, querySelector: () => null };
  const event = {
    type: 'submit',
    target: { closest: (selector) => (selector === '[data-flow-wait-form]' ? form : null) },
    submitter: { value: 'Approve' },
    preventDefault() {},
  };
  const ctx = {
    data: { flows: { waits: [{ id: 'wait-1', kind: 'approval' }] } },
    request: async () => result,
    refresh: async () => {
      events.push('refresh');
    },
    setButtonPending(_button, pending, failed) {
      if (!pending) finished(failed);
      return true;
    },
    get notify() {
      events.push('notify-get');
      return (message, failed) => events.push(failed === undefined ? message : [message, failed]);
    },
  };
  return { event, ctx, done };
}

test('flow wait notification evaluates the callee and result fields in original order', async () => {
  const OriginalFormData = globalThis.FormData;
  globalThis.FormData = class {
    get() {
      return null;
    }
  };
  try {
    for (const outcome of ['Approved', '', null]) {
      const events = [];
      const result = {
        get runId() {
          events.push('runId');
          return {
            toString() {
              events.push('coerce');
              return 'run-1';
            },
          };
        },
        get outcome() {
          events.push('outcome');
          return outcome;
        },
      };
      const { event, ctx, done } = flowCase(events, result);
      assert.equal(view.handle(ctx, event), true);
      assert.equal(await done, undefined);
      assert.deepEqual(events, [
        'notify-get',
        'runId',
        'coerce',
        'outcome',
        ...(outcome ? ['outcome'] : []),
        `Run run-1 is scheduled to resume${outcome ? ` (${outcome})` : ''}.`,
        'refresh',
      ]);
    }
  } finally {
    globalThis.FormData = OriginalFormData;
  }
});

test('a runId getter error wins before outcome is read', async () => {
  const OriginalFormData = globalThis.FormData;
  globalThis.FormData = class {
    get() {
      return null;
    }
  };
  try {
    const events = [],
      sentinel = new Error('run id sentinel');
    const result = {
      get runId() {
        events.push('runId');
        throw sentinel;
      },
      get outcome() {
        events.push('outcome');
        throw new Error('wrong getter');
      },
    };
    const { event, ctx, done } = flowCase(events, result);
    assert.equal(view.handle(ctx, event), true);
    assert.equal(await done, true);
    assert.deepEqual(events, ['notify-get', 'runId', 'notify-get', ['run id sentinel', true]]);
  } finally {
    globalThis.FormData = OriginalFormData;
  }
});
