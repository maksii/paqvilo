// @test-kind contract: server logic is attributed to a page only through its call route, its Liquid tag or an observed call, never through a word that happens to match its name
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSourceInspector } from '../lense/source-inspection.mjs';
import { inspectionFixture } from './source-inspection-fixture.mjs';

function writeServerLogic(fx, name) {
  const dir = path.join(fx.portal, 'server-logic');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.serverlogic.yml`),
    `adx_serverlogicid: ${name.toLowerCase()}-logic\nadx_name: ${name}`,
  );
  fs.writeFileSync(path.join(dir, `${name}.js`), 'function get() {}');
}

function writeHomeCopy(fx, copy) {
  fs.writeFileSync(path.join(fx.portal, 'web-pages/home/Home.webpage.copy.html'), copy);
}

function serverLogicRows(report) {
  return report.logic
    .filter((row) => row.kind === 'server-logic')
    .map((row) => ({ name: row.name, evidence: row.evidence }));
}

test('a page that only mentions a server logic name as ordinary text is not attributed to it', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  writeServerLogic(fx, 'orders');
  writeHomeCopy(fx, '<p>Orders are listed below.</p><div class="orders">{{ page.title }}</div>');
  const { report } = await createSourceInspector({ sourceDir: fx.portal }).inspect('/');
  assert.deepEqual(serverLogicRows(report), []);
});

test('a page whose source calls the server logic route is attributed with static-reference evidence', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  writeServerLogic(fx, 'orders');
  writeHomeCopy(fx, `<script>fetch('/_api/serverlogics/orders?$top=1');</script>`);
  const { report } = await createSourceInspector({ sourceDir: fx.portal }).inspect('/');
  assert.deepEqual(serverLogicRows(report), [{ name: 'orders', evidence: 'static-reference' }]);
});

test('a Liquid serverlogic tag that names the server logic is attributed with static-reference evidence', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  writeServerLogic(fx, 'orders');
  writeHomeCopy(fx, `<p>{% serverlogic name: 'orders' %}</p>`);
  const { report } = await createSourceInspector({ sourceDir: fx.portal }).inspect('/');
  assert.deepEqual(serverLogicRows(report), [{ name: 'orders', evidence: 'static-reference' }]);
});

test('a route that only extends the server logic name is not attributed to it', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  writeServerLogic(fx, 'orders');
  writeHomeCopy(fx, `<script>fetch('/_api/serverlogics/orders_archive');</script>`);
  const { report } = await createSourceInspector({ sourceDir: fx.portal }).inspect('/');
  assert.deepEqual(serverLogicRows(report), []);
});

test('a server logic call seen in the browser is attributed with observed-request evidence', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  writeServerLogic(fx, 'orders');
  writeHomeCopy(fx, '<p>No script references the operation.</p>');
  const rendered = { serverLogicPaths: ['/_api/serverlogics/orders'] };
  const { report } = await createSourceInspector({ sourceDir: fx.portal }).inspect('/', rendered);
  assert.deepEqual(serverLogicRows(report), [{ name: 'orders', evidence: 'observed-request' }]);
});

test('a server logic route is not reported as an entity set named after its route segment', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  writeServerLogic(fx, 'orders');
  writeHomeCopy(fx, `<script>fetch('/_api/serverlogics/orders?$top=1');</script>`);
  const { report } = await createSourceInspector({ sourceDir: fx.portal }).inspect('/');
  assert.deepEqual(serverLogicRows(report), [{ name: 'orders', evidence: 'static-reference' }]);
  assert.deepEqual(
    report.apiReferences.filter((row) => row.name === 'serverlogics'),
    [],
  );
  assert.deepEqual(
    (report.tables ?? []).filter((row) => row.entitySet === 'serverlogics' || row.logicalName === 'serverlogics'),
    [],
  );
});

test('a Web API table route is still reported as an entity set reference', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  writeHomeCopy(fx, `<script>fetch('/_api/accounts?$top=1');</script>`);
  const { report } = await createSourceInspector({ sourceDir: fx.portal }).inspect('/');
  assert.deepEqual(
    report.apiReferences.map((row) => row.name),
    ['accounts'],
  );
});
