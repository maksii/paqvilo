// @test-kind contract: provisioning preserves client and progress callback ordering across async operations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planManifest, applyManifest, scopeSolutionRoots } from '../lense/dataverse/provision.mjs';

const manifest = (withTable = false) => ({
  schemaVersion: 1,
  publisher: {
    uniqueName: 'fictionalpublisher',
    friendlyName: 'Fictional Publisher',
    prefix: 'tst',
    optionValuePrefix: 12345,
  },
  solutions: [{ uniqueName: 'FictionalSchema', friendlyName: 'Fictional schema', version: '1.0.0.0' }],
  choices: [],
  relationships: [],
  forms: [],
  views: [],
  tables: withTable
    ? [
        {
          name: 'tst_node',
          entitySetName: 'tst_nodes',
          label: 'Node',
          pluralLabel: 'Nodes',
          ownership: 'organization',
          solution: 'FictionalSchema',
          primaryName: { name: 'tst_name', label: 'Name', maxLength: 160 },
          columns: [],
        },
      ]
    : [],
});

test('online planning resumes table lookup before the next microtask marker', async () => {
  const events = [];
  const client = {
    origin: 'http://127.0.0.1',
    optional() {
      events.push('optional');
      return null;
    },
    list(route) {
      events.push(route.startsWith('publishers?') ? 'publisher-list' : 'solution-list');
      return Promise.resolve([]);
    },
  };
  const pending = planManifest(manifest(true), { client });
  queueMicrotask(() => events.push('marker'));
  await pending;
  assert.deepEqual(events.slice(0, 3), ['optional', 'publisher-list', 'marker']);
});

test('empty solution scoping starts its list calls before the next microtask marker', async () => {
  const events = [];
  const client = {
    list(route) {
      events.push(route.startsWith('solutions?') ? 'solution-list' : 'component-list');
      return Promise.resolve(
        route.startsWith('solutions?') ? [{ solutionid: '11111111-1111-4111-8111-111111111111' }] : [],
      );
    },
    get() {
      throw new Error('unexpected get');
    },
    request() {
      throw new Error('unexpected write');
    },
  };
  const pending = scopeSolutionRoots(manifest(), client);
  queueMicrotask(() => events.push('marker'));
  await pending;
  assert.deepEqual(events, ['solution-list', 'component-list', 'marker']);
});

test('apply reports its first created component before a queued metadata callback', async () => {
  const events = [],
    sentinel = new Error('stop after first progress');
  const client = {
    origin: 'http://127.0.0.1',
    verify() {
      return Promise.resolve({});
    },
    list() {
      return Promise.resolve([]);
    },
    request() {
      const data = {};
      Object.defineProperty(data, 'id', {
        get() {
          events.push('id:get');
          queueMicrotask(() => events.push('marker'));
          return '11111111-1111-4111-8111-111111111111';
        },
      });
      return Promise.resolve({ data });
    },
  };
  await assert.rejects(
    applyManifest(manifest(), {
      client,
      onProgress(entry) {
        events.push('progress');
        assert.equal(entry.status, 'created');
        throw sentinel;
      },
    }),
    (error) => error === sentinel,
  );
  assert.deepEqual(events, ['id:get', 'progress', 'marker']);
});
