import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { compilePlans, caseTemplate, dispatcher } from './compile.mjs';
import {
  authoredQuery,
  canonicalRows,
  compareResults,
  pageComplete,
  splitPayload,
  assessScenario,
  diffObservation,
  encodeArtifact,
  decodeArtifact,
} from './core.mjs';
import { createRunner, reconcileBackendArtifact } from './runtime.mjs';
import { shellSource, componentId } from './deploy.mjs';
const catalogue = JSON.parse(await fs.readFile(new URL('../data/catalogue.json', import.meta.url)));
const schema = JSON.parse(await fs.readFile(new URL('../dataverse/manifest.json', import.meta.url)));
const manifest = compilePlans(catalogue, schema);
const operation = {
  pqvd_testoperationid: '11111111-1111-4111-8111-111111111111',
  pqvd_markerutc: 'CO-UTC:2026-10-13T08:00:00.000Z',
  pqvd_markeroperation: 'CO-OP:11111111-1111-4111-8111-111111111111',
};

test('async reconciliation retains late multipart packets and waits for a stable complete operation', async () => {
  const { sha256 } = await import('./core.mjs');
  let time = 0,
    reads = 0;
  const part = async (n, text) => ({
      pqvd_plugineventid: 'part-' + n,
      pqvd_spanid: 'async-span',
      pqvd_artifacttype: 'AsyncContext',
      pqvd_partnumber: n,
      pqvd_partcount: 2,
      pqvd_payloadtext: text,
      pqvd_payloadhash: await sha256(text),
    }),
    a = await part(1, 'first'),
    b = await part(2, 'second');
  const result = await reconcileBackendArtifact({
    read: async () => ({ ok: true, data: { value: [[], [a], [a, b], [b, a]][Math.min(reads++, 3)] } }),
    artifactType: 'AsyncContext',
    timeoutMs: 10,
    intervalMs: 1,
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
  });
  assert.equal(result.state, 'observed');
  assert.equal(reads, 4);
  assert.equal(result.events.length, 2);
  assert.equal(result.elapsedMs, 3);
});

test('async reconciliation aborts an unresponsive transport within its deadline', async () => {
  let signal;
  const result = await reconcileBackendArtifact({
    read: (args) => {
      signal = args.signal;
      return new Promise(() => {});
    },
    artifactType: 'AsyncContext',
    timeoutMs: 5,
    intervalMs: 1,
  });
  assert.equal(result.state, 'timeout');
  assert.equal(signal.aborted, true);
  assert.deepEqual(result.events, []);
});

test('default async deadline admits the observed late queue and retains a finite timeout for longer queues', async () => {
  const { sha256 } = await import('./core.mjs');
  const packet = {
    pqvd_plugineventid: 'event',
    pqvd_spanid: 'span',
    pqvd_artifacttype: 'AsyncContext',
    pqvd_partnumber: 1,
    pqvd_partcount: 1,
    pqvd_payloadtext: 'delayed',
    pqvd_payloadhash: await sha256('delayed'),
  };
  for (const arrival of [76000, Infinity]) {
    let elapsed = 0;
    const result = await reconcileBackendArtifact({
      read: async () => ({ ok: true, data: { value: elapsed >= arrival ? [packet] : [] } }),
      artifactType: 'AsyncContext',
      now: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms;
      },
    });
    assert.equal(result.state, Number.isFinite(arrival) ? 'observed' : 'timeout');
    assert.equal(elapsed, Number.isFinite(arrival) ? 77000 : 120000);
  }
});

test('async reconciliation retains partial failures and never qualifies missing, corrupt, paged or cancelled evidence', async () => {
  const { sha256 } = await import('./core.mjs'),
    event = {
      pqvd_plugineventid: 'event',
      pqvd_spanid: 'span',
      pqvd_artifacttype: 'ChainA',
      pqvd_partnumber: 1,
      pqvd_partcount: 1,
      pqvd_payloadtext: 'payload',
      pqvd_payloadhash: await sha256('payload'),
    };
  for (const mode of ['timeout', 'transport', 'checksum', 'paging', 'cancel']) {
    let time = 0,
      reads = 0;
    const result = await reconcileBackendArtifact({
      read: async () => {
        reads++;
        return mode === 'transport' && reads > 1
          ? { ok: false, status: 403, text: 'denied' }
          : {
              ok: true,
              data: {
                value: [mode === 'checksum' ? { ...event, pqvd_payloadhash: 'bad' } : event],
                ...(mode === 'paging' ? { '@odata.nextLink': 'more' } : {}),
              },
            };
      },
      artifactType: 'AsyncContext',
      timeoutMs: 3,
      intervalMs: 1,
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
      stopped: () => mode === 'cancel' && reads > 0,
    });
    assert.equal(
      result.state,
      {
        timeout: 'timeout',
        transport: 'read-failed',
        checksum: 'checksum-failed',
        paging: 'paging-incomplete',
        cancel: 'stopped',
      }[mode],
    );
    assert.equal(result.events.length, 1);
    if (mode === 'transport') assert.equal(result.httpStatus, 403);
  }
});

test('P10 saves reconciled packets before cleanup and marks failed reconciliation incomplete even with a durable backend', async () => {
  const { sha256 } = await import('./core.mjs');
  for (const fail of [false, true]) {
    const calls = [],
      operations = new Map(),
      queryCache = new Map();
    let eventReads = 0,
      elapsed = 0;
    const packet = {
      pqvd_plugineventid: 'event',
      pqvd_spanid: 'span',
      pqvd_artifacttype: 'AsyncContext',
      pqvd_partnumber: 1,
      pqvd_partcount: 1,
      pqvd_payloadtext: 'async',
      pqvd_payloadhash: await sha256('async'),
    };
    const request = async (args) => {
      calls.push(args);
      if (args.method === 'POST') {
        const id = crypto.randomUUID();
        if (args.url === '/_api/pqvd_testoperations')
          operations.set(id, {
            ...args.body,
            pqvd_testoperationid: id,
            pqvd_markeroperation: 'CO-OP:' + id,
            pqvd_markerutc: 'CO-UTC:2026-10-13T08:00:00.000Z',
          });
        return { ok: true, status: 204, entityId: id, text: '' };
      }
      if (args.url.startsWith('/_api/pqvd_testoperations(') && !args.method)
        return { ok: true, status: 200, data: operations.get(args.url.match(/\(([a-f0-9-]+)\)/)[1]), text: '' };
      if (args.url.startsWith('/_api/pqvd_pluginevents?')) {
        eventReads++;
        if (fail) return { ok: false, status: 403, text: 'denied' };
        if (eventReads > 3) throw Error('Cached query never exposed the late event.');
        const xml = new URL(args.url, 'http://127.0.0.1').searchParams.get('fetchXml'),
          operationId = xml.match(/attribute="pqvd_operationid" operator="eq" value="([a-f0-9-]+)"/)?.[1];
        assert.equal(operations.get(operationId)?.pqvd_caseid, 'P10');
        const equality = xml.match(/attribute="pqvd_plugineventid" operator="eq" value="([a-f0-9-]+)"/)?.[1],
          inequality = xml.match(/attribute="pqvd_plugineventid" operator="ne" value="([a-f0-9-]+)"/)?.[1];
        assert.ok(equality);
        assert.equal(equality, inequality);
        assert.match(xml, /<filter type="or">/);
        if (!queryCache.has(args.url)) queryCache.set(args.url, eventReads === 1 ? [] : [packet]);
        return { ok: true, status: 200, data: { value: queryCache.get(args.url) }, text: '' };
      }
      return { ok: true, status: 204, text: '' };
    };
    const runner = createRunner({
      manifest: {
        ...manifest,
        cases: [],
        crudFixtures: [],
        scenarios: [],
        pluginProfiles: [{ id: 'P10' }],
        readiness: { operationGuard: true, durableCollector: true, pipelineProfiles: ['P10'] },
      },
      context: { contactId: '11111111-1111-4111-8111-111111111111', roles: ['CO Test Runner'] },
      request,
      // Virtual time: the late packet arrives on the third poll without two real one-second intervals.
      clock: {
        now: () => elapsed,
        sleep: async (ms) => {
          elapsed += ms;
        },
      },
    });
    const result = await runner.run({ selectedCases: [], pluginProfile: 'P10' }),
      profile = result.evidence.find((e) => e.profile === 'P10' && !e.kind),
      cleanup = calls.findIndex((c) => c.method === 'DELETE'),
      saved = calls.filter(
        (c) =>
          c.url === '/_api/pqvd_testresults' &&
          c.body.pqvd_caseid === 'P10' &&
          c.body.pqvd_artifactkind === manifest.choices.pqvd_artifactkind.Summary,
      );
    assert.equal(profile.backendReconciliation.state, fail ? 'read-failed' : 'observed');
    assert.equal(eventReads, fail ? 1 : 3);
    assert.equal(elapsed, fail ? 0 : 2000, 'two default one-second polling intervals separate the three reads');
    assert.equal(queryCache.size, fail ? 0 : 3);
    assert.deepEqual(result.residuals, []);
    assert.ok(cleanup > calls.findLastIndex((c) => c.url.startsWith('/_api/pqvd_pluginevents?')));
    assert.equal(calls.at(-1).body.pqvd_runstate, manifest.choices.pqvd_runstate[fail ? 'Incomplete' : 'Completed']);
    const artifact = JSON.parse(await decodeArtifact(saved.map((c) => c.body.pqvd_payloadtext).join('')));
    assert.equal(artifact.backendEvents.length, fail ? 0 : 1);
    assert.equal(artifact.backendReconciliation.state, profile.backendReconciliation.state);
  }
});

test('all36 cases plus inner/outer variant share typed plans without administrator oracle leakage', () => {
  assert.equal(manifest.cases.length, 37);
  assert.equal(new Set(manifest.cases.map((c) => c.id.slice(0, 3))).size, 36);
  for (const c of manifest.cases) {
    assert.ok(!c.expected);
    assert.ok(!c.fetchXml.includes('{{ref:'));
    assert.ok(!/<[^>]*\/>/.test(c.fetchXml));
    assert.match(c.fetchXml, /<filter type="or"><condition attribute="[^"]+" operator="null">/);
    assert.equal((c.fetchXml.match(/\{\{markerUtc\}\}/g) || []).length, 1);
    assert.equal((c.fetchXml.match(/\{\{markerOperation\}\}/g) || []).length, 1);
  }
  assert.equal(manifest.cases.find((c) => c.id === 'R34').fields[0].type, 'string');
  assert.equal(
    manifest.cases.find((c) => c.id === 'R31').fields.find((f) => f.name === 'equipmentcount').type,
    'integer',
  );
});
test('query construction requires server markers and bounded paging', () => {
  const plan = manifest.cases[0],
    xml = authoredQuery(plan, operation, 2);
  assert.match(xml, /page="2"/);
  assert.ok(xml.includes(operation.pqvd_markerutc));
  assert.throws(() => authoredQuery(plan, { ...operation, pqvd_markeroperation: 'forged' }), /markers/);
  assert.throws(() => authoredQuery(plan, operation, 21), /bound/);
});
test('canonical parity keeps null, empty, dates, tuples and duplicate multiplicity', () => {
  const plan = {
    fields: [
      { name: 'id', type: 'guid' },
      { name: 'salary', type: 'money', precision: 2 },
      { name: 'date', type: 'dateonly' },
      { name: 'text', type: 'string' },
    ],
  };
  const rows = canonicalRows(
    [
      { id: '{AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA}', salary: 100, date: '2026-10-13T00:00:00Z', text: '' },
      { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', salary: null, date: null },
    ],
    plan,
  );
  assert.equal(rows[0].salary, '100.00');
  assert.equal(rows[0].date, '2026-10-13');
  assert.equal(rows[0].text, '');
  assert.equal(rows[1].text, null);
  assert.equal(
    compareResults(
      { complete: true, outcome: 'success', rows: [1], ids: ['a'] },
      { complete: true, outcome: 'success', rows: [], ids: [] },
    ),
    'different-counts',
  );
  assert.equal(compareResults({ complete: false }, { complete: true }), 'incomplete');
});
test('full terminal page needs extra proof when provider omits more-record metadata', () => {
  assert.equal(pageComplete({ rowCount: 50, pageSize: 50 }), false);
  assert.equal(pageComplete({ rowCount: 0, pageSize: 50 }), true);
  assert.equal(pageComplete({ rowCount: 50, pageSize: 50, more: false }), true);
  assert.equal(pageComplete({ rowCount: 0, pageSize: 50, more: true }), false);
});
test('chunking reconstructs exactly and never splits surrogate pairs', () => {
  const text = 'ab😀c'.repeat(30),
    parts = splitPayload(text, 7);
  assert.equal(parts.join(''), text);
  assert.ok(parts.every((p) => p.length <= 7));
  assert.ok(parts.every((p) => !/[\uD800-\uDBFF]$/.test(p)));
});
test('artifact transport preserves original Unicode and API URLs through memo rewriting and rejects tampering', async () => {
  const original = 'https://portal.example.test/_api/$metadata\r\n東京😀'.repeat(15000),
    encoded = await encodeArtifact(original, 'application/xml'),
    parts = splitPayload(encoded),
    stored = parts.map((p) =>
      p.replaceAll('https://portal.example.test/_api/', 'https://dataverse.example.test/api/data/v9.1/'),
    );
  assert.equal(await decodeArtifact(stored.join('')), original);
  const corrupt = JSON.parse(encoded);
  corrupt.payloadSha256 = '0'.repeat(64);
  await assert.rejects(() => decodeArtifact(JSON.stringify(corrupt)), /checksum/);
  assert.equal(await decodeArtifact('[{"legacy":true}]'), '[{"legacy":true}]');
});
test('per-run artifact transport overflow records incomplete persistence before writing any oversized parts', async () => {
  const calls = [],
    operations = new Map();
  const request = async (args) => {
    calls.push(args);
    if (args.method === 'POST') {
      const id = crypto.randomUUID();
      if (args.url === '/_api/pqvd_testoperations')
        operations.set(id, {
          pqvd_testoperationid: id,
          pqvd_markeroperation: 'CO-OP:' + id,
          pqvd_markerutc: 'CO-UTC:2026-10-13T08:00:00.000Z',
        });
      return { ok: true, status: 204, entityId: id, text: '' };
    }
    if (args.url.startsWith('/_api/pqvd_testoperations(')) {
      const id = args.url.match(/\(([a-f0-9-]+)\)/)[1];
      return { ok: true, status: 200, data: operations.get(id), text: '' };
    }
    return { ok: true, status: 204, text: '' };
  };
  const runner = createRunner({
    manifest: {
      ...manifest,
      cases: [],
      scenarios: [],
      crudFixtures: [],
      artifactTransportBudgetBytes: 512,
      readiness: { operationGuard: true, durableCollector: false },
    },
    context: { contactId: '11111111-1111-4111-8111-111111111111', roles: ['CO Test Runner'] },
    request,
  });
  const result = await runner.run({ selectedCases: [] });
  assert.equal(result.artifactTransport.limitBytes, 512);
  assert.ok(result.evidence.find((e) => e.kind === 'persistence-error' && e.error.includes('budget exceeded')));
  assert.equal(calls.filter((c) => c.url === '/_api/pqvd_testresults').length, 0);
  assert.equal(calls.at(-1).body.pqvd_runstate, manifest.choices.pqvd_runstate.Incomplete);
});
test('reusable runner rejects overlap and starts each sequential run with its own budget and evidence', async () => {
  let release,
    firstPost = true;
  const gate = new Promise((r) => (release = r)),
    operations = new Map();
  const request = async (args) => {
    if (args.method === 'POST') {
      if (args.url === '/_api/pqvd_testruns' && firstPost) {
        firstPost = false;
        await gate;
      }
      const id = crypto.randomUUID();
      if (args.url === '/_api/pqvd_testoperations')
        operations.set(id, {
          pqvd_testoperationid: id,
          pqvd_markeroperation: 'CO-OP:' + id,
          pqvd_markerutc: 'CO-UTC:2026-10-13T08:00:00.000Z',
        });
      return { ok: true, status: 204, entityId: id, text: '' };
    }
    if (args.url.startsWith('/_api/pqvd_testoperations('))
      return { ok: true, status: 200, data: operations.get(args.url.match(/\(([a-f0-9-]+)\)/)[1]), text: '' };
    return { ok: true, status: 204, text: '' };
  };
  const runner = createRunner({
    manifest: {
      ...manifest,
      cases: [],
      scenarios: [],
      crudFixtures: [],
      artifactTransportBudgetBytes: 512,
      readiness: { operationGuard: true, durableCollector: false },
    },
    context: { contactId: '11111111-1111-4111-8111-111111111111', roles: ['CO Test Runner'] },
    request,
  });
  const pending = runner.run();
  await assert.rejects(() => runner.run(), /already in progress/);
  release();
  const first = await pending,
    second = await runner.run();
  assert.notEqual(first.runId, second.runId);
  assert.notEqual(first.evidence, second.evidence);
  assert.equal(first.evidence.length, 1);
  assert.equal(second.evidence.length, 1);
  assert.equal(first.artifactTransport.estimatedUsedBytesBeforeSummary, 0);
  assert.equal(second.artifactTransport.estimatedUsedBytesBeforeSummary, 0);
});
test('templates escape XML, use immutable operation intent, and hide no failed oracle as pass', async () => {
  const source = caseTemplate(manifest.cases[0]);
  assert.match(source, /visibility_query.xml \| xml_escape/);
  assert.match(dispatcher(manifest), /pqvd_runnercontactid.id == user.id/);
  assert.match(dispatcher(manifest), /CO Test Runner/);
  const shell = await shellSource(manifest);
  assert.match(shell, /{% raw %}/);
  const module = /<script type="module">([\s\S]*?)<\/script>/.exec(shell)?.[1];
  assert.ok(module, 'the shell includes its browser module');
  assert.doesNotThrow(
    () => new vm.Script(module, { filename: 'bundled-portal-shell.js' }),
    'the browser bundle has no unresolved module imports or exports',
  );
  assert.match(shell, /pre.textContent/);
  const actual = assessScenario(catalogue.scenarios[0], [], manifest);
  assert.ok(actual.every((a) => a.verdict === 'incomplete'));
  assert.equal(
    componentId('11111111-1111-4111-8111-111111111111', 'x'),
    componentId('11111111-1111-4111-8111-111111111111', 'x'),
  );
});

test('disjoint request fragments retain every fixture and joined row multiplicity without splitting aggregates', () => {
  for (const p of manifest.cases.filter((p) => p.fragments)) {
    const fixtureValues = (xml) => [...xml.matchAll(/<value>([^<]+)<\/value>/g)].map((v) => v[1]);
    assert.deepEqual(
      p.fragments.flatMap((f) => fixtureValues(f.fetchXml)),
      fixtureValues(p.fetchXml),
    );
    for (const f of p.fragments) assert.ok(encodeURIComponent(f.fetchXml).length < 3500);
    assert.ok(!p.fields.some((f) => f.aggregate));
    assert.ok(!/distinct="true"/.test(p.fetchXml));
  }
  assert.equal(manifest.cases.find((c) => c.id === 'R31').fragments, undefined);
});
test('empty failed lanes retain differing HTTP and platform outcome classes', () => {
  const plan = { primaryId: 'id', fields: [{ name: 'id', type: 'guid' }] },
    previous = {
      outcome: 'error',
      complete: false,
      rows: [],
      pages: [{ httpStatus: 400, body: JSON.stringify({ error: { cdscode: '0x8004430d' } }) }],
    },
    current = {
      outcome: 'error',
      complete: false,
      rows: [],
      pages: [{ httpStatus: 403, body: JSON.stringify({ error: { code: '90040120' } }) }],
    };
  const diff = diffObservation(previous, current, plan);
  assert.equal(diff.outcomeVerdict, 'different');
  assert.equal(diff.rowCompleteness, 'incomplete');
  assert.equal(diff.priorOutcome.pages[0].platformCode, '0x8004430d');
  assert.equal(diff.currentOutcome.pages[0].portalCode, '90040120');
  assert.deepEqual(diff.added, []);
});

test('failed probe read records its denial and still deletes the disposable owned probe', async () => {
  const calls = [],
    operations = new Map(),
    context = { contactId: '11111111-1111-4111-8111-111111111111', roles: ['CO Test Runner'] };
  const request = async (args) => {
    calls.push(args);
    if (args.method === 'POST') {
      const id = crypto.randomUUID();
      if (args.url === '/_api/pqvd_testoperations')
        operations.set(id, {
          pqvd_testoperationid: id,
          pqvd_markeroperation: 'CO-OP:' + id,
          pqvd_markerutc: 'CO-UTC:2026-10-13T08:00:00.000Z',
        });
      return { ok: true, status: 204, entityId: id, text: '' };
    }
    if (args.url.startsWith('/_api/pqvd_testoperations(') && !args.method) {
      const id = args.url.match(/\(([a-f0-9-]+)\)/)[1];
      return { ok: true, status: 200, data: operations.get(id), text: '' };
    }
    if (args.url.startsWith('/_api/pqvd_crudprobes(') && args.method === 'GET')
      return { ok: false, status: 403, text: 'fixture denial', data: { error: { code: '90040101' } } };
    return { ok: true, status: 204, text: '' };
  };
  const runner = createRunner({
    manifest: {
      ...manifest,
      cases: [],
      crudFixtures: [],
      scenarios: [],
      manifestHash: 'fixture-only',
      readiness: { operationGuard: true, durableCollector: false },
    },
    context,
    request,
  });
  const result = await runner.run({ selectedCases: [], crud: true, crudMode: 'probe' });
  assert.ok(
    calls.find(
      (c) => c.method === 'GET' && c.url.includes('?$select=pqvd_crudprobeid,pqvd_name,pqvd_value,pqvd_counter'),
    ),
    JSON.stringify({
      error: result.error,
      evidence: result.evidence,
      calls: calls.map((c) => ({ url: c.url, method: c.method })),
    }),
  );
  assert.equal(calls.filter((c) => c.method === 'DELETE').length, 1);
  assert.deepEqual(result.residuals, []);
  assert.ok(result.evidence.find((e) => e.method === 'GET' && e.status === 403));
  assert.ok(
    calls.find(
      (c) =>
        c.url === '/_api/pqvd_testresults' && c.body?.pqvd_artifactkind === manifest.choices.pqvd_artifactkind.Cleanup,
    ),
  );
});

test('actual P02 and P05 runner PATCH the intended probe and clean it on success or exception', async () => {
  for (const profile of ['P02', 'P05'])
    for (const fail of [false, true]) {
      const calls = [],
        operations = new Map();
      let probe;
      const request = async (args) => {
        calls.push(args);
        if (args.method === 'POST') {
          const id = crypto.randomUUID();
          if (args.url === '/_api/pqvd_crudprobes') probe = id;
          if (args.url === '/_api/pqvd_testoperations')
            operations.set(id, {
              pqvd_testoperationid: id,
              pqvd_markeroperation: 'CO-OP:' + id,
              pqvd_markerutc: 'CO-UTC:2026-10-13T08:00:00.000Z',
            });
          return { ok: true, status: 204, entityId: id, text: '' };
        }
        if (args.url.startsWith('/_api/pqvd_testoperations(') && !args.method) {
          const id = args.url.match(/\(([a-f0-9-]+)\)/)[1];
          return { ok: true, status: 200, data: operations.get(id), text: '' };
        }
        if (args.method === 'PATCH' && args.url.startsWith('/_api/pqvd_crudprobes(')) {
          if (fail) throw new Error('fixture PATCH exception');
          return { ok: true, status: 204, text: '' };
        }
        if (args.url.startsWith('/_api/pqvd_pluginevents?'))
          return { ok: true, status: 200, data: { value: [] }, text: '{"value":[]}' };
        return { ok: true, status: 204, text: '' };
      };
      const runner = createRunner({
        manifest: {
          ...manifest,
          cases: [],
          crudFixtures: [],
          scenarios: [],
          manifestHash: 'fixture-only',
          pluginProfiles: [{ id: profile }],
          readiness: { operationGuard: true, durableCollector: false, pipelineProfiles: [profile] },
        },
        context: { contactId: '11111111-1111-4111-8111-111111111111', roles: ['CO Test Runner'] },
        request,
      });
      const result = await runner.run({ selectedCases: [], pluginProfile: profile });
      const patch = calls.find((c) => c.method === 'PATCH' && c.url.startsWith('/_api/pqvd_crudprobes('));
      assert.ok(patch);
      assert.equal(patch.url, '/_api/pqvd_crudprobes(' + probe + ')');
      assert.equal(patch.body.pqvd_pluginscenario, profile);
      assert.equal(patch.body.pqvd_hopbudget, 3);
      assert.match(patch.body['pqvd_activeoperationid@odata.bind'], /^\/pqvd_testoperations\([a-f0-9-]{36}\)$/);
      assert.equal(
        calls.filter((c) => c.method === 'DELETE' && c.url === '/_api/pqvd_crudprobes(' + probe + ')').length,
        1,
      );
      assert.deepEqual(result.residuals, []);
      assert.ok(result.evidence.find((e) => e.kind === 'profile-cleanup' && e.status === 204));
      assert.ok(
        calls.find(
          (c) =>
            c.url === '/_api/pqvd_testresults' &&
            c.body?.pqvd_artifactkind === manifest.choices.pqvd_artifactkind.Cleanup &&
            c.body?.pqvd_httpstatus === 204,
        ),
      );
      if (fail)
        assert.ok(result.evidence.find((e) => e.kind === 'profile-error' && e.error === 'fixture PATCH exception'));
      else assert.equal(result.evidence.find((e) => e.profile === profile).status, 204);
    }
});
