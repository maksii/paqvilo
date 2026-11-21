// @test-kind contract: mirage verify names the option of a missing or malformed input before it parses anything
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyParity } from '../verify.mjs';
// The reference tools' shared connection message (mirage/lib/live.mjs).
const CDP_CONNECT_FAILURE =
  'Could not connect to the loopback browser debugging endpoint. Confirm its port and availability.';

test('verifyParity names the missing --origin option instead of reporting an invalid URL', async () => {
  await assert.rejects(verifyParity({ localUrl: 'http://127.0.0.1:1', outputDir: 'x' }), /--origin is required/);
});

test('verifyParity names the option of a malformed URL input', async () => {
  await assert.rejects(
    verifyParity({
      localUrl: 'not a url',
      origin: 'https://portal.invalid',
      cdpUrl: 'http://127.0.0.1:9',
      outputDir: 'x',
    }),
    /--local must be an absolute URL/,
  );
});

// @test-kind contract: a refused --cdp endpoint is the reference tools' shared one-line message, without ANSI codes or a call log
test('a browser connection failure is reported as the shared plain connection message', async (t) => {
  const http = await import('node:http');
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { makeTemporaryDirectory } = await import('../testing/owned-fixture.mjs');
  const outputDir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-verify-'));
  t.after(() => fs.rm(outputDir, { recursive: true, force: true }));
  // The local runtime answers its state; the debugging endpoint is a loopback server that is not a browser.
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(req.url.startsWith('/__sim/api/state') ? '{}' : '{"not":"a browser"}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const report = await verifyParity({ localUrl: origin, origin: 'https://portal.invalid', cdpUrl: origin, outputDir });
  assert.equal(report.passed, false);
  const escape = String.fromCodePoint(27);
  for (const difference of report.differences) {
    assert.ok(!difference.includes(escape) && !difference.includes('\n'), difference);
  }
  assert.equal(report.differences.at(-1), CDP_CONNECT_FAILURE, JSON.stringify(report.differences));
  assert.equal(report.artifacts.error, undefined);
  const written = await fs.readFile(report.artifacts.report, 'utf8');
  assert.ok(!written.includes(escape) && !written.includes('connectOverCDP'), written);
});

test('an unreachable --local origin is named in the report instead of "fetch failed"', async (t) => {
  const http = await import('node:http');
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { makeTemporaryDirectory } = await import('../testing/owned-fixture.mjs');
  const outputDir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-verify-'));
  t.after(() => fs.rm(outputDir, { recursive: true, force: true }));
  // A loopback port that was just released: nothing answers there.
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await new Promise((resolve) => server.close(resolve));
  const report = await verifyParity({ localUrl: origin, origin: 'https://portal.invalid', cdpUrl: origin, outputDir });
  assert.equal(report.passed, false);
  assert.deepEqual(report.differences, [
    `Nothing answers at the --local origin ${origin}; start Mirage there or pass the origin it prints.`,
  ]);
});
