// One capability registry per host (organization-host.mjs): status() / state() carry its legacy summary and its report,
// GET /_sim/api/preflight and simulator.preflight() answer the live preflight, and strict acceptance refuses a required
// capability below behaviour before any browser starts.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { assertAcceptanceCapabilities, runAcceptance } from '../acceptance.mjs';
import { ownedFixture, drainFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { composeHostDescription } from '../lib/organization-host.mjs';
import { fixedClock } from '../testing.mjs';

async function standalone(t, options = {}) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'host-capabilities-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const solution = path.join(root, 'solution');
  await fs.mkdir(path.join(solution, 'Other'), { recursive: true });
  await fs.writeFile(
    path.join(solution, 'Other', 'Solution.xml'),
    '<ImportExportXml><SolutionManifest><UniqueName>InventedCapabilities</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
  );
  const sim = await createSimulator({
    runtime: { kind: 'dataverse-api' },
    solutionRoots: [solution],
    projectRoot: root,
    port: 0,
    watch: false,
    simulation: { level: 'dry-run' },
    dataverse: { enabled: true, tls: false, tds: { enabled: false } },
    ...options,
  });
  ownedFixture(t).add(() => sim.close());
  return sim;
}

// The portal tests only read, so they share one host; it is closed before its directory is removed, after the file.
const sharedClosers = [],
  sharedRemovers = [];
after(async () => {
  await drainFixture(sharedClosers);
  await drainFixture(sharedRemovers);
});
let sharedPortal;
const portal = () => (sharedPortal ??= startPortal());
async function startPortal() {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'portal-capabilities-'));
  sharedRemovers.push(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(dir, 'website.yml'),
    'adx_websiteid: 8c3d9b2a-7c3e-4a5b-9d6e-1a2b3c4d5e91\nadx_name: Invented Capabilities',
  );
  await fs.writeFile(
    path.join(dir, 'Home.webpage.yml'),
    'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true',
  );
  const sim = await createSimulator({
    sourceDir: dir,
    stateFile: path.join(dir, 'state.json'),
    port: 0,
    watch: false,
    initial: {
      version: 1,
      mappings: {},
      tables: {},
      permissions: [],
      simulator: { mode: 'local', pageMode: 'local', live: { allowWrites: false }, endpoints: [] },
    },
  });
  sharedClosers.push(() => sim.close());
  return sim;
}

const operationLevel = (report, module, operation) =>
  report.modules.find((record) => record.name === module)?.operations.find((entry) => entry.name === operation)?.level;

function assertCoreSeams(report) {
  for (const name of ['store', 'scheduler', 'loopback-network', 'providers.messaging'])
    assert.ok(
      report.modules.some((record) => record.name === name && record.level === 'behaviour'),
      name,
    );
  assert.deepEqual(
    report.diagnostics.filter((entry) => entry.code === 'CAPABILITY_REQUIRES_UNREGISTERED'),
    [],
  );
}

test('offline host descriptions resolve installed core seams and retain absent provider diagnostics', async (t) => {
  const host = await composeHostDescription({
    runtime: { kind: 'dataverse-api' },
    config: { providers: { messaging: { missing: { kind: 'pack:absent/bus' } } } },
  });
  t.after(() => host.close());
  const report = await host.preflight();
  assertCoreSeams(report);
  assert.equal(host.registry.get('provider:messaging/missing').level, 'inventory');
  assert.equal(report.requirements.find((row) => row.id === 'provider:messaging/missing')?.status, 'missing');
});

test('standalone status carries the registry summary and report; preflight answers over HTTP and on the handle', async (t) => {
  const sim = await standalone(t);
  const status = sim.status();
  assert.equal(status.capabilities.organization, true);
  assert.equal(status.capabilities.modelDriven, false);
  assert.equal(status.capabilities.dataverseApi, true);
  assert.equal(status.capabilities.portalRendering, false);
  assert.equal(status.capabilities.canvas, 'behaviour');
  assert.equal(status.capabilities.codeApps, 'contract');
  const names = new Set(status.capabilityReport.modules.map((record) => record.name));
  for (const name of [
    'dataverseApi',
    'dataverse-storage-routing',
    'provider:storage/local',
    'message-bus:local',
    'outbox:local',
  ])
    assert.ok(names.has(name), name);
  // The organization wired the hierarchy operators and scheduled the rollup job, so both report behaviour.
  assert.equal(operationLevel(status.capabilityReport, 'dataverse-hierarchy', 'query:under'), 'behaviour');
  assert.equal(operationLevel(status.capabilityReport, 'dataverse-rollup', 'MassRecalculation'), 'behaviour');

  const response = await fetch(`${sim.url}/_sim/api/preflight?requires=dataverse-hierarchy/query:*`);
  const report = await response.json();
  assert.equal(response.status, 200);
  assert.equal(report.kind, 'paqvilo.mirage.preflight');
  assert.equal(report.runtime.kind, 'dataverse-api');
  assert.equal(report.runtime.capabilities.dataverseApi, true);
  assert.deepEqual(report.scope.requires, ['dataverse-hierarchy/query:*']);
  assert.equal(report.summary.blocking, 0);
  const direct = await sim.preflight();
  assertCoreSeams(direct);
  assert.equal(direct.kind, 'paqvilo.mirage.preflight');
  assert.ok(direct.modules.some((record) => record.name === 'provider:storage/local' && record.level === 'behaviour'));
});

test('portal state carries the registry summary; preflight answers over HTTP and on the handle', async () => {
  const sim = await portal();
  const state = sim.state();
  assert.equal(state.capabilities.powerPages, true);
  assert.equal(state.capabilities.portalRendering, true);
  assert.equal(state.capabilities.personas, true);
  assert.ok(
    state.capabilityReport.modules.some(
      (record) => record.name === 'portalRendering' && record.kind === 'host-surface',
    ),
  );
  const response = await fetch(`${sim.url}/__sim/api/preflight`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).runtime.kind, 'power-pages');
  assert.equal((await sim.preflight({ strict: true })).scope.strict, true);
  assertCoreSeams(await sim.preflight());
});

for (const persistent of [false, true])
  test(`${persistent ? 'persistent' : 'dry-run'} host supports first-send, scheduled delivery and outbox with explicit restart semantics`, async (t) => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'host-messaging-lifetime-'));
    ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
    const clock = fixedClock();
    const options = {
      clock,
      stateFile: path.join(root, 'state.json'),
      simulation: { level: persistent ? 'simulation' : 'dry-run' },
    };
    const sim = await standalone(t, options);
    const { bus } = sim.organization.providers.messaging;
    await bus.send('fixture', { first: true });
    const [message] = await bus.receive('fixture');
    assert.ok(message.lockToken);
    await bus.complete(message.lockToken);
    assert.equal(bus.peek('fixture').length, 0);
    await bus.send('fixture', { scheduled: true }, { scheduledEnqueueTime: clock.now() + 1000 });
    assert.deepEqual(await bus.receive('fixture'), []);
    clock.advance(1000);
    const [scheduled] = await bus.receive('fixture');
    assert.deepEqual(scheduled.body, { scheduled: true });
    await bus.complete(scheduled.lockToken);
    await bus.send('fixture', { retained: true });
    await sim.organization.providers.outbox.capture({
      channel: 'email',
      to: ['fixture@example.invalid'],
      body: 'local capture',
    });
    const captured = await (await fetch(`${sim.url}/_sim/api/outbox`)).json();
    assert.equal(captured.entries.length, 1);
    await sim.close();
    const restarted = await standalone(t, options);
    assert.equal(restarted.organization.providers.messaging.bus.peek('fixture').length, persistent ? 1 : 0);
    const after = await (await fetch(`${restarted.url}/_sim/api/outbox`)).json();
    assert.equal(after.entries.length, persistent ? 1 : 0);
    if (!persistent) await assert.rejects(fs.stat(options.stateFile), { code: 'ENOENT' });
  });

test('strict acceptance refuses a required capability that is not executable before any browser starts', async (t) => {
  const sim = await portal();
  const outputDir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'acceptance-requires-'));
  t.after(() => fs.rm(outputDir, { recursive: true, force: true }));
  await assert.rejects(
    runAcceptance({
      localUrl: sim.url,
      outputDir,
      flows: [{ name: 'Invented', steps: [{ action: 'navigate', path: '/' }] }],
      requires: ['x-invented-capability'],
      strict: true,
    }),
    (error) => error.code === 'CapabilityUnavailable' && /x-invented-capability is not registered/.test(error.message),
  );
  assert.equal(
    await assertAcceptanceCapabilities({
      localUrl: sim.url,
      requires: ['dataverse-hierarchy/resolve:*', 'portalRendering'],
    }),
    true,
  );
  await assert.rejects(
    assertAcceptanceCapabilities({ localUrl: sim.url, requires: ['codeApps'] }),
    (error) => error.code === 'CapabilityUnavailable' && /codeApps is contract/.test(error.message),
  );
  assert.equal(await assertAcceptanceCapabilities({ localUrl: sim.url, requires: ['canvas'] }), true);
});
