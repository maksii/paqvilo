// @test-kind contract: a reload that loses a whole kind of portal source is accepted and reported as one warning naming what is gone
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { portalSourceLoss } from '../lib/portal-source-loss.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const records = (counts) =>
  Object.entries(counts).flatMap(([kind, count]) =>
    Array.from({ length: count }, (_, index) => ({ kind, id: `${kind}-${index}` })),
  );

test('kinds that are gone and a lost website record are listed once each; a smaller or unchanged kind is not', () => {
  const previous = {
    records: records({ website: 1, webpage: 3, webtemplate: 2, pagetemplate: 1, sitesetting: 4, invented: 2 }),
  };
  const next = { records: records({ webpage: 2, sitesetting: 1, webfile: 5 }) };
  const loss = portalSourceLoss(previous, next);
  assert.equal(loss.code, 'PORTAL_SOURCE_REMOVED');
  assert.equal(loss.severity, 'warning');
  assert.deepEqual(loss.removed, [
    { kind: 'website', name: 'the website record', count: 1 },
    { kind: 'webtemplate', name: 'web templates', count: 2 },
    { kind: 'pagetemplate', name: 'page templates', count: 1 },
    { kind: 'invented', name: 'invented', count: 2 },
  ]);
  assert.equal(
    loss.message,
    'This reload found none of these portal sources, which the previous revision had: the website record, web templates (2), page templates (1), invented (2). The portal is now served without them. If they were deleted or moved by mistake, put them back: the next reload reads them again.',
  );
  assert.equal(portalSourceLoss(previous, previous), null);
  assert.equal(portalSourceLoss(null, next), null);
  assert.equal(portalSourceLoss({ records: [] }, next), null);
});

test('a running portal whose web templates folder is deleted reports the loss on that reload and drops it when they are back', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-portal-source-loss-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'website.yml': 'adx_websiteid: invented\nadx_name: Source loss',
    'Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
    'Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
    'web-templates/main/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'web-templates/main/Main.webtemplate.source.html': '<!doctype html><html><body><h1>Invented</h1></body></html>',
  };
  for (const [file, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), body);
  }
  const app = await createSimulator({ sourceDir: root, watch: false });
  ownedFixture(t).add(() => app.close());
  const findings = async () =>
    (await (await fetch(`${app.url}/_sim/api/diagnostics`)).json()).diagnostics.filter(
      (item) => item.code === 'PORTAL_SOURCE_REMOVED',
    );
  assert.deepEqual(await findings(), []);
  await fs.rename(path.join(root, 'web-templates'), path.join(root, '..', `${path.basename(root)}-parked`));
  ownedFixture(t).remove(() =>
    fs.rm(path.join(root, '..', `${path.basename(root)}-parked`), { recursive: true, force: true }),
  );
  await app.reload();
  const [loss] = await findings();
  assert.deepEqual(loss.removed, [{ kind: 'webtemplate', name: 'web templates', count: 1 }]);
  assert.equal((await fetch(app.url)).status < 500, true, 'the portal still answers');
  await fs.rename(path.join(root, '..', `${path.basename(root)}-parked`), path.join(root, 'web-templates'));
  await app.reload();
  assert.deepEqual(await findings(), [], 'the next reload, with the templates back, drops the finding');
});
