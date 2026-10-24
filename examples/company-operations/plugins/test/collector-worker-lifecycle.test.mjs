import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ownedFixture } from '../../../../mirage/testing/owned-fixture.mjs';

const worker = fileURLToPath(new URL('../collector/worker.mjs', import.meta.url));
const operation = '10000000-0000-4000-8000-000000000001';
const span = '10000000-0000-4000-8000-000000000002';
const receiptId = operation + '/' + 'a'.repeat(64);
const sha = (value) => createHash('sha256').update(value).digest('hex');

test(
  'actual worker reports a denied evidence write safely, retains its receipt and resumes in a new process',
  { timeout: 15000 },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-collector-worker-'));
    ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true }));
    const payload = JSON.stringify({
      schemaVersion: 1,
      operationId: operation,
      spanId: span,
      artifact: 'Context',
      captureTime: '2026-01-01T00:00:00Z',
      context: { MessageName: 'RetrieveMultiple', Stage: 20, Mode: 0 },
      inventedPrivateMarker: 'INVENTED_PAYLOAD_NOT_FOR_DIAGNOSTICS',
      text: 'x'.repeat(128100),
    });
    const envelope = {
      schemaVersion: 1,
      operationId: operation,
      eventKey: 'a'.repeat(64),
      payload,
      payloadHash: sha(payload),
    };
    const receiptFile = path.join(directory, 'receipt.json');
    await fs.writeFile(receiptFile, JSON.stringify(envelope));
    const originalReceiptHash = sha(await fs.readFile(receiptFile));
    const events = new Map();
    let writes = 0,
      summaries = 0,
      requests = 0,
      denySecondWrite = true,
      summary;
    const response = (res, status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body == null ? undefined : JSON.stringify(body));
    };
    const server = http.createServer(async (req, res) => {
      requests++;
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://loopback');
      if (url.pathname === '/identity')
        return response(res, 200, {
          access_token: 'INVENTED_IDENTITY_NOT_FOR_DIAGNOSTICS',
        });
      if (url.pathname === '/blob') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(await fs.readFile(receiptFile));
        return;
      }
      if (url.pathname === `/api/data/v9.2/pqvd_testoperations(${operation})`) {
        if (req.method === 'GET')
          return response(res, 200, {
            pqvd_testoperationid: operation,
            _pqvd_runid_value: span,
          });
        assert.equal(req.method, 'PATCH');
        summaries++;
        summary = JSON.parse(bytes);
        return response(res, 204);
      }
      const event = /^\/api\/data\/v9\.2\/pqvd_pluginevents\(([a-f0-9-]{36})\)$/.exec(url.pathname);
      if (event && req.method === 'GET') return response(res, events.has(event[1]) ? 200 : 404, events.get(event[1]));
      if (url.pathname === '/api/data/v9.2/pqvd_pluginevents' && req.method === 'POST') {
        writes++;
        if (denySecondWrite && writes === 2)
          return response(res, 403, {
            error: { message: 'INVENTED_PROVIDER_SECRET' },
          });
        const row = JSON.parse(bytes);
        assert.ok(!events.has(row.pqvd_plugineventid));
        events.set(row.pqvd_plugineventid, row);
        return response(res, 204);
      }
      response(res, 404);
    });
    ownedFixture(t).add(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const adapter = path.join(directory, 'adapter.mjs');
    await fs.writeFile(
      adapter,
      `
    const original=globalThis.fetch;
    globalThis.fetch=(input,options)=>{
      const url=new URL(input);
      if(url.origin==='https://inventedstorage.blob.core.windows.net'&&url.pathname==='/receipts/events/${receiptId}.json')return original(${JSON.stringify(origin + '/blob')},options);
      if(url.origin==='https://invented.dynamics.com')return original(${JSON.stringify(origin)}+url.pathname+url.search,options);
      if(url.origin===${JSON.stringify(origin)}&&url.pathname==='/identity')return original(url,options);
      throw new Error('Unqualified network target refused');
    };
  `,
    );
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'NODE_TEST_CONTEXT')),
      CO_COLLECTOR_TENANT: operation,
      CO_COLLECTOR_AUDIENCE: 'invented-local-worker',
      CO_COLLECTOR_BLOB_URL: 'https://inventedstorage.blob.core.windows.net/',
      CO_COLLECTOR_CONTAINER: 'receipts',
      CO_DATAVERSE_URL: 'https://invented.dynamics.com/',
      IDENTITY_ENDPOINT: origin + '/identity',
      IDENTITY_HEADER: 'INVENTED_HEADER_NOT_FOR_DIAGNOSTICS',
    };
    const execute = async (file = worker, args = [receiptId]) => {
      const child = spawn(process.execPath, ['--import', pathToFileURL(adapter).href, file, ...args], {
        env,
        windowsHide: true,
        signal: t.signal,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout = (stdout + chunk).slice(-8000);
      });
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-8000);
      });
      const closed = new Promise((resolve) => child.once('close', resolve));
      ownedFixture(t).add(async () => {
        if (!child.killed && child.exitCode === null && child.signalCode === null) assert.ok(child.kill());
        await closed;
      });
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      assert.doesNotMatch(
        stdout + stderr,
        /INVENTED_(?:PAYLOAD|PROVIDER|IDENTITY|HEADER)_|node:internal|UV_HANDLE_CLOSING/,
      );
      return { code, stdout, stderr };
    };
    const denied = await execute();
    assert.equal(denied.code, 1, denied.stderr);
    assert.equal(denied.stdout, '');
    assert.deepEqual(JSON.parse(denied.stderr), {
      error: 'CollectorWorkerFailed',
      code: 'DATAVERSE_HTTP_ERROR',
      status: 403,
    });
    assert.equal(events.size, 1);
    assert.equal(summaries, 0);
    assert.equal(sha(await fs.readFile(receiptFile)), originalReceiptHash);
    denySecondWrite = false;
    const resumed = await execute();
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(resumed.stderr, '');
    assert.deepEqual(JSON.parse(resumed.stdout), {
      state: 'Persisted',
      parts: 2,
    });
    const rows = [...events.values()].sort((a, b) => a.pqvd_partnumber - b.pqvd_partnumber);
    assert.equal(rows.map((row) => row.pqvd_payloadtext).join(''), payload);
    assert.ok(rows.every((row) => row.pqvd_payloadhash === sha(payload) && row.pqvd_partcount === 2));
    assert.equal(JSON.parse(summary.pqvd_serversummary).complete, false);
    const previousWrites = writes;
    const duplicate = await execute();
    assert.equal(duplicate.code, 0, duplicate.stderr);
    assert.equal(writes, previousWrites);
    assert.equal(sha(await fs.readFile(receiptFile)), originalReceiptHash);
    const beforeInvalid = requests;
    const invalid = await execute(worker, ['INVENTED_PAYLOAD_NOT_FOR_DIAGNOSTICS']);
    assert.equal(invalid.code, 1);
    assert.deepEqual(JSON.parse(invalid.stderr), {
      error: 'CollectorWorkerFailed',
      code: 'WORKER_FAILED',
      status: null,
    });
    assert.equal(requests, beforeInvalid, 'invalid receipt IDs are refused before network access');
    const importProbe = path.join(directory, 'import-worker.mjs');
    await fs.writeFile(
      importProbe,
      `await import(${JSON.stringify(pathToFileURL(worker).href)}); console.log(JSON.stringify({imported:true}));`,
    );
    const imported = await execute(importProbe);
    assert.equal(imported.code, 0, imported.stderr);
    assert.deepEqual(JSON.parse(imported.stdout), { imported: true });
    assert.equal(requests, beforeInvalid, 'importing the worker never executes an unrelated process argument');
  },
);
