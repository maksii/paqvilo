// @test-kind contract+security: Wire profiles preserve authentication precedence, structured tracing and postcommit attachment hydration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';
import { handleWebApi } from '../lib/webapi-handler.mjs';
import { createTraceStore } from '../lib/trace-store.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { makeTemporaryDirectory, ownedFixture } from '../testing/owned-fixture.mjs';
import { endedTree } from './support/trace-scenario.mjs';

const id = '10000000-0000-4000-8000-000000000001';
const origin = 'http://127.0.0.1:39123';
function response() {
  return {
    headersSent: false,
    sends: 0,
    writeHead(status, headers) {
      this.headersSent = true;
      this.statusCode = status;
      this.headers = headers;
    },
    end(body) {
      this.sends++;
      this.body = body;
    },
  };
}
const json = (out, status, body, headers, { wireText, omitContentType } = {}) => {
  const responseHeaders = { 'content-type': 'application/json; charset=utf-8', ...headers };
  if (omitContentType)
    for (const name of Object.keys(responseHeaders))
      if (name.toLowerCase() === 'content-type') delete responseHeaders[name];
  out.writeHead(status, responseHeaders);
  out.end(status === 204 ? undefined : (wireText ?? JSON.stringify(body)));
};

test('malformed percent escapes cannot replace authentication failures in either response mode', async () => {
  for (const observed of [
    {},
    {
      webApiErrorDetails: 'odata-wrapper',
      webApiReadResponse: 'jsonnet-indented',
      webApiWriteResponse: 'portal-classic',
    },
  ])
    for (const route of ['%ZZ', '%E0%A4%A', 'probes(%ZZ)'])
      for (const [token, expected] of [
        [undefined, 401],
        ['wrong', 403],
        ['valid', 400],
      ]) {
        const out = response();
        await handleWebApi(
          { method: 'POST', headers: token ? { __requestverificationtoken: token } : {} },
          out,
          new URL('/_api/' + route, origin),
          {
            portal: { observed },
            csrf: 'valid',
            json,
            store: new Proxy(
              {},
              {
                get() {
                  throw Error('Malformed or unauthenticated requests must not touch the store');
                },
              },
            ),
          },
        );
        assert.equal(out.statusCode, expected, route);
        assert.equal(out.sends, 1);
        assert.equal(typeof JSON.parse(out.body).error.message, 'string');
      }
});

function fixture(observed, events = []) {
  const store = new DataStore({
    state: {
      mappings: {
        annotation: {
          entitySet: 'annotations',
          idColumn: 'annotationid',
          fields: { subject: { type: 'string' }, documentbody: { type: 'string' } },
        },
      },
      tables: {
        annotation: [{ annotationid: id, subject: 'Stored attachment', documentbody: null, versionnumber: 1 }],
      },
      settings: { permissionMode: 'permissive' },
    },
  });
  store.readOperation = async (fn) => {
    events.push('begin');
    await fn();
    events.push('commit');
  };
  return {
    store,
    portal: {
      observed,
      settings: {
        'Webapi/annotation/enabled': 'true',
        'Webapi/annotation/fields': 'annotationid,subject,documentbody',
      },
    },
    origin,
    origins: [origin],
    identity: {},
    csrf: 'valid',
    json,
    change: (fn) => fn(),
    attachmentBody(logical, key) {
      events.push('attachment');
      assert.equal(events.at(-2), 'commit');
      assert.equal(logical, 'annotation');
      assert.deepEqual(key, { annotationid: id });
      return 'U3RvcmVkIGJ5dGVz';
    },
  };
}

test('default and observed reads hydrate storage attachments after commit and before final serialization', async () => {
  for (const observed of [{}, { webApiReadResponse: 'jsonnet-indented' }]) {
    const events = [],
      deps = fixture(observed, events),
      out = response();
    await handleWebApi(
      { method: 'GET', headers: {} },
      out,
      new URL('/_api/annotations?$select=subject,documentbody', origin),
      deps,
    );
    assert.equal(out.statusCode, 200);
    assert.deepEqual(events, ['begin', 'commit', 'attachment']);
    const body = JSON.parse(out.body);
    assert.equal(body.value[0].documentbody, 'U3RvcmVkIGJ5dGVz');
    assert.equal(
      out.body,
      JSON.stringify(body, null, observed.webApiReadResponse ? 2 : undefined).replaceAll(
        '\n',
        observed.webApiReadResponse ? '\r\n' : '\n',
      ),
    );
    assert.equal(out.sends, 1);
    const failed = fixture(observed),
      rejected = response();
    failed.store.readOperation = async (fn) => {
      await fn();
      throw Error('commit rejected');
    };
    failed.attachmentBody = () => assert.fail('Hydration must not run after a failed commit');
    await handleWebApi(
      { method: 'GET', headers: {} },
      rejected,
      new URL('/_api/annotations?$select=subject,documentbody', origin),
      failed,
    );
    assert.equal(rejected.statusCode, 500);
    assert.equal(rejected.sends, 1);
  }
});

test('observed raw response profiles retain collection and created-record trace outputs', async () => {
  const deps = fixture({ webApiReadResponse: 'jsonnet-indented', webApiWriteResponse: 'portal-classic' });
  deps.store.traces = createTraceStore({ settings: { level: 'full' } });
  const read = response();
  await handleWebApi({ method: 'GET', headers: {} }, read, new URL('/_api/annotations?$select=subject', origin), deps);
  assert.equal(read.statusCode, 200);
  const readSpan = deps.store.traces.spans({ kind: 'webapi' }).items[0];
  assert.equal(readSpan.attributes.rowCount, 1);
  assert.deepEqual(readSpan.output, { status: 200, rowCount: 1 });
  const created = response(),
    createdId = '10000000-0000-4000-8000-000000000002';
  await handleWebApi(
    { method: 'POST', headers: { __requestverificationtoken: 'valid' } },
    created,
    new URL('/_api/annotations', origin),
    { ...deps, jsonBody: async () => ({ annotationid: createdId, subject: 'Created' }) },
  );
  assert.equal(created.statusCode, 204, created.body);
  assert.equal(created.sends, 1);
  assert.equal(created.body, undefined);
  assert.equal(created.headers['OData-EntityId'], origin + '/api/data/v9.1/annotations(' + createdId + ')');
  assert.equal(
    Object.keys(created.headers).some((name) => name.toLowerCase() === 'content-type'),
    false,
  );
  const createSpan = deps.store.traces.spans({ kind: 'webapi', operation: 'create' }).items[0];
  assert.equal(createSpan.recordId, createdId);
  assert.equal(createSpan.attributes.id, createdId);
  assert.deepEqual(createSpan.output, { status: 204, id: createdId });
  assert.equal(deps.store.get('annotation', createdId).subject, 'Created');
});

test('real server response observation retains audit counts, trace identity and hydrated wire bytes in both profiles', async (t) => {
  for (const observed of [{}, { webApiReadResponse: 'jsonnet-indented', webApiWriteResponse: 'portal-classic' }]) {
    const source = await makeTemporaryDirectory(path.join(os.tmpdir(), 'webapi-response-integration-'));
    ownedFixture(t).remove(() => fs.rm(source, { recursive: true, force: true }));
    await fs.writeFile(
      path.join(source, 'website.yml'),
      'adx_websiteid: invented-response-site\nadx_name: Invented response integration\n',
    );
    await fs.writeFile(
      path.join(source, 'sitesetting.yml'),
      '- adx_name: Webapi/annotation/enabled\n  adx_value: "true"\n- adx_name: Webapi/annotation/fields\n  adx_value: "annotationid,subject,documentbody"\n',
    );
    const deps = fixture(observed),
      bytes = 'U3RvcmVkIGJ5dGVz';
    deps.store.state.tables.annotation[0].documentbody = bytes;
    const app = await createSimulator({
      sourceDir: source,
      watch: false,
      trace: { level: 'full' },
      observed: { ...observed, evidence: 'Invented response integration fixture' },
      initial: deps.store.state,
    });
    ownedFixture(t).add(() => app.close());
    const stored = app.store.state.tables.annotation[0];
    assert.equal(stored.documentbody, null);
    assert.match(stored.__blobkey, /^annotations\//);
    const events = [],
      originalRead = app.store.readOperation.bind(app.store);
    app.store.readOperation = async (fn) => {
      events.push('begin');
      const result = await originalRead(fn);
      events.push('commit');
      return result;
    };
    const read = await fetch(app.url + '/_api/annotations?$select=subject,documentbody');
    assert.equal(read.status, 200);
    const raw = await read.text(),
      body = JSON.parse(raw);
    assert.equal(body.value[0].documentbody, bytes);
    assert.deepEqual(events, ['begin', 'commit']);
    assert.equal(
      raw,
      JSON.stringify(body, null, observed.webApiReadResponse ? 2 : undefined).replaceAll(
        '\n',
        observed.webApiReadResponse ? '\r\n' : '\n',
      ),
    );
    const readTree = await endedTree(app.trace, read.headers.get('x-trace-id'));
    assert.deepEqual(readTree.spans.find((span) => span.kind === 'webapi').output, { status: 200, rowCount: 1 });
    const auditPage = await (
      await fetch(app.url + '/_sim/api/audit?pageSize=100', { headers: { 'x-sim-csrf': app.csrf } })
    ).json();
    const audit = auditPage.items.find((entry) => entry.id === read.headers.get('x-sim-trace-id'));
    assert.equal(audit.rowCount, 1);
    const createdId = '10000000-0000-4000-8000-000000000002';
    const created = await fetch(app.url + '/_api/annotations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', __requestverificationtoken: app.csrf },
      body: JSON.stringify({ annotationid: createdId, subject: 'Created response' }),
    });
    assert.equal(created.status, 204, await created.text());
    assert.equal(
      created.headers.get('content-type'),
      observed.webApiWriteResponse ? null : 'application/json; charset=utf-8',
    );
    const createTree = await endedTree(app.trace, created.headers.get('x-trace-id'));
    const span = createTree.spans.find((row) => row.kind === 'webapi');
    assert.equal(span.recordId, createdId);
    assert.deepEqual(span.output, { status: 204, id: createdId });
    assert.equal(
      app.store.state.tables.annotation.find((row) => row.annotationid === createdId).subject,
      'Created response',
    );
  }
});
