// @test-kind contract: a navigate step whose page.goto answers no response reads the committed document's status, and names an unobservable one in one line
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runAcceptance } from '../acceptance.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { loopbackServer } from './shared-browser.mjs';

// /hidden removes its navigation timing entries, so nothing in the page records the status it was served with.
const PAGES = {
  '/': '<!doctype html><title>Home</title><main id="home">Home</main>',
  '/hidden':
    "<!doctype html><title>Hidden</title><main>Hidden</main><script>Object.defineProperty(performance, 'getEntriesByType', { value: () => [] });</script>",
};

function serve(req, res) {
  const { pathname } = new URL(req.url, 'http://fixture.invalid');
  if (pathname.startsWith('/__sim/api/')) {
    res.setHeader('content-type', 'application/json');
    return res.end(
      JSON.stringify(
        pathname.endsWith('/state')
          ? {
              config: { mode: 'local', pageMode: 'local', endpoints: [] },
              status: { sourceFingerprint: 'fixture', implementationFingerprint: 'fixture' },
            }
          : {},
      ),
    );
  }
  if (!PAGES[pathname]) return res.writeHead(404).end();
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(PAGES[pathname]);
}

test('a navigate step reads the committed document status when page.goto answers no response', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-acceptance-status-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { origin } = await loopbackServer(t, serve);
  // A same-document navigation is one for which page.goto answers null, as it does for a document another debugging
  // client served or replaced.
  const result = await runAcceptance({
    localUrl: origin,
    outputDir: root,
    flows: [
      {
        name: 'observable',
        steps: [
          { action: 'navigate', path: '/' },
          { action: 'navigate', path: '/#section' },
        ],
      },
      {
        name: 'unobservable',
        steps: [
          { action: 'navigate', path: '/hidden' },
          { action: 'navigate', path: '/hidden#section' },
        ],
      },
    ],
  });
  const [observable, unobservable] = result.flows;
  assert.equal(observable.passed, true, JSON.stringify(observable));
  assert.deepEqual(
    observable.steps.map((step) => step.status),
    [200, 200],
  );
  assert.equal(unobservable.passed, false);
  assert.equal(
    unobservable.error,
    'The document response of /hidden#section was not observable; another debugging client may be intercepting the tab (for a reference read, use a Lense session started with --no-overrides).',
  );
});
