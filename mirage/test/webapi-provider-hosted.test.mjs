// @test-kind observation: hosted session F1 follow-up 2026-11-27 (paqvilo-developer hosted-f1 summary-F1 "Follow-up", runs/a and runs/b nav-followup, -throw and -throw-cache), restated on the invented follow-up replay site of mirage/test/parity/hosted-f1-nav-fixture-site.mjs
// The provider-backed facts of the follow-up that the hosted-f1-nav replay suites cannot state: whether the provider was
// called, the read cache a site can be observed with, and the diagnostic for columns a hosted site would expose.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { signInHeaders } from '../testing/session.mjs';
import { makeTemporaryDirectory, ownedFixture, removeFixtureDirectory } from '../testing/owned-fixture.mjs';
import { F1_CONTACT, F1_ROLE } from './parity/hosted-f1-fixture-site.mjs';
import { writeHostedF1NavSite } from './parity/hosted-f1-nav-fixture-site.mjs';

async function navSite(t, { observed, clock } = {}) {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'webapi-provider-hosted-'));
  ownedFixture(t).remove(() => removeFixtureDirectory(directory));
  const switchFile = path.join(directory, 'switch.txt');
  await fs.writeFile(switchFile, 'healthy');
  const options = await writeHostedF1NavSite(directory, { switchFile });
  const app = await createSimulator({ ...options, ...(observed ? { observed } : {}), ...(clock ? { clock } : {}) });
  ownedFixture(t).add(() => app.close());
  const { cookie } = signInHeaders(app, F1_CONTACT, { roles: [F1_ROLE] });
  const read = async (address) => {
    const response = await fetch(new URL(address, app.url), { headers: { accept: 'application/json', cookie } });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const calls = async () => Number(await fs.readFile(path.join(directory, 'calls.json'), 'utf8'));
  const setProvider = (mode) => fs.writeFile(switchFile, mode);
  return { app, read, calls, setProvider };
}

test('filters into the provider-backed table and its lookup $expand never call the provider', async (t) => {
  const { read, calls, setProvider } = await navSite(t);
  for (const mode of ['healthy', 'throwing']) {
    await setProvider(mode);
    const before = await calls();
    for (const filter of [
      "pqf1_vrow/pqf1_code eq 'x'",
      "pqf1_root_pqf1_root_pqf1_vrow/any(e:e/pqf1_code eq 'x')",
      "pqf1_root_pqf1_root_pqf1_vrow/all(e:e/pqf1_code eq 'x')",
    ]) {
      const answer = await read(`/_api/pqf1_roots?$select=pqf1_name&$filter=${encodeURIComponent(filter)}`);
      assert.equal(answer.status, 500, filter);
      assert.equal(answer.body.error.cdscode, '0x80044150');
    }
    const lookup = await read('/_api/pqf1_roots?$select=pqf1_name&$expand=pqf1_vrow($select=pqf1_code)');
    assert.equal(lookup.status, 200, mode);
    assert.deepEqual(
      lookup.body.value.map((row) => row.pqf1_vrow),
      [null, null],
    );
    assert.equal(await calls(), before, `${mode}: no provider call`);
  }
});

// @test-kind security+observation: Mirage keeps Webapi/<table>/fields on provider rows although the hosted site returned every provider column (runs/a and runs/b nav-followup baseline-vrows, keyed-vrow), and reports the columns the live site would expose
test('provider rows keep the column list and report the columns a hosted site would expose', async (t) => {
  const { app, read } = await navSite(t);
  const answer = await read('/_api/pqf1_vrows?$select=pqf1_name,pqf1_code');
  assert.equal(answer.status, 200);
  for (const row of answer.body.value) {
    assert.equal(Object.hasOwn(row, 'pqf1_amount'), false, 'a column outside the list never leaves the server');
    assert.equal(Object.hasOwn(row, '_pqf1_root_value'), false, 'an unlisted wire lookup never leaves the server');
  }
  const diagnostic = app.state().diagnostics.find((entry) => entry.code === 'WEBAPI_PROVIDER_COLUMNS_HOSTED_EXPOSED');
  assert.ok(diagnostic, 'the hosted exposure is reported');
  assert.equal(diagnostic.severity, 'warning');
  assert.equal(diagnostic.table, 'pqf1_vrow');
  assert.ok(diagnostic.columns.includes('pqf1_amount'));
});

// @test-kind contract: observed.webApiReadCache is off by default and, when observed, keyed by the visitor and the exact request; the lifetime window and the uncached errors are the follow-up's (runs/a and runs/b nav-followup-throw-cache against nav-followup and nav-followup-throw)
test('an observed read cache answers a repeated identical read without the provider, and only then', async (t) => {
  const plain = await navSite(t);
  assert.equal((await plain.read('/_api/pqf1_vrows?$select=pqf1_name')).status, 200);
  await plain.setProvider('throwing');
  assert.equal((await plain.read('/_api/pqf1_vrows?$select=pqf1_name')).status, 400, 'no cache unless observed');

  let now = Date.parse('2026-11-27T06:00:00Z');
  const cached = await navSite(t, {
    observed: { webApiReadCache: { seconds: 300 }, evidence: 'invented site observed with the follow-up read cache' },
    clock: () => now,
  });
  // A second visitor, added before any cached read: a local write starts the cache afresh.
  const OTHER = '0f100000-0000-4000-8000-00000000c002';
  await cached.app.store.transact(() => {
    cached.app.store.state.tables.contact.push({ contactid: OTHER, fullname: 'Other Reader' });
  });
  const route = '/_api/pqf1_vrows?$select=pqf1_name';
  const first = await cached.read(route);
  assert.equal(first.status, 200);
  const before = await cached.calls();
  await cached.setProvider('throwing');
  now += 299_000;
  assert.deepEqual(await cached.read(route), first, 'the identical read is answered from the cache');
  assert.equal(await cached.calls(), before, 'without calling the provider');
  assert.equal((await cached.read(`${route}&$orderby=pqf1_name`)).status, 400, 'another request reads afresh');
  assert.equal((await cached.read(`${route}&$orderby=pqf1_name`)).status, 400, 'an error is not cached');
  now += 2_000;
  assert.equal((await cached.read(route)).status, 400, 'an expired entry reads afresh');
  // Another visitor never reads this visitor's entry.
  await cached.setProvider('healthy');
  assert.equal((await cached.read(route)).status, 200);
  await cached.setProvider('throwing');
  const { cookie } = signInHeaders(cached.app, OTHER, { roles: [F1_ROLE] });
  const visitor = await fetch(new URL(route, cached.app.url), { headers: { accept: 'application/json', cookie } });
  assert.equal(visitor.status, 400, 'another visitor reads afresh');
  assert.equal((await cached.read(route)).status, 200, 'the first visitor still reads its entry');
  // A permission change moves the data revision, so the next read is fresh.
  const revision = cached.app.store.dataRevision();
  await cached.app.store.transact(() => {
    cached.app.store.state.permissions = cached.app.store.state.permissions.map((grant) => ({ ...grant }));
  });
  assert.notEqual(cached.app.store.dataRevision(), revision, 'a permission edit moves the data revision');
  assert.equal((await cached.read(route)).status, 400, 'a permission change reads afresh');
  // A lifetime outside the observed window is refused where observations enter (lib/project-config.mjs); the handler
  // ignores one that reaches it another way (readCache checks the window again).
  await assert.rejects(
    navSite(t, { observed: { webApiReadCache: { seconds: 60 }, evidence: 'invented out-of-window lifetime' } }),
    /webApiReadCache must be \{ seconds \} with an integer from 195 to 414/,
  );
});
