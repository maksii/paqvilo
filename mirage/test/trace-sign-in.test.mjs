// Sign-in in the trace (docs/design/tracing.md, D-R3-3, D-R3-4, D-R3-5, D-R3-8, D-R3-12): a local sign-in names the
// signed-in contact on its root (display name from first and last name when the contact has no full name) with a signIn
// event; a refused sign-in names its refusal; an external sign-in through the local identity provider records the
// provider's metadata and token calls as http-out spans whose identity-provider roots join the sign-in trace, writes the
// registered contact and its external identity through the traced record pipeline and names the contact. Invented data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { endedTree } from './support/trace-scenario.mjs';
import { client, signInThrough, simulator } from './support/external-sign-in.mjs';

const ADA = '5a000000-0000-4000-8000-000000000031';
const portalFiles = {
  'website.yml': 'adx_websiteid: site\nadx_name: Invented sign-in portal',
  'Home.webpage.yml':
    'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: main',
  'Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_name: Main\nadx_webtemplateid: main',
  'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
  'Main.webtemplate.source.html': '<main>{% if user %}{{ user.fullname }}{% else %}anonymous{% endif %}</main>',
};

async function localPortal(t) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'trace-sign-in-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(portalFiles)) await fs.writeFile(path.join(root, name), text);
  const sim = await createSimulator({
    sourceDir: root,
    stateFile: path.join(root, 'state.json'),
    port: 0,
    watch: false,
    trace: { level: 'full' },
    initial: {
      version: 1,
      mappings: { contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' } },
      // The contact has no fullname column value: the trace names it from its first and last name (DV-C-9).
      tables: { contact: [{ contactid: ADA, firstname: 'Ada', lastname: 'Member', statecode: 0 }] },
      permissions: [],
      settings: { permissionMode: 'permissive' },
      simulator: { mode: 'local', pageMode: 'local', live: { allowWrites: false }, endpoints: [] },
    },
  });
  ownedFixture(t).add(() => sim.close());
  return sim;
}

test('a local sign-in names the signed-in contact on its root with a signIn event; a refused one names the refusal', async (t) => {
  const sim = await localPortal(t);
  const signIn = (contactId) =>
    fetch(sim.url + '/SignIn', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
      body: new URLSearchParams({ contactId, ReturnUrl: '/', __RequestVerificationToken: sim.csrf }),
    });
  const posted = await signIn(ADA);
  assert.equal(posted.status, 302, await posted.text());
  const root = (await endedTree(sim.trace, posted.headers.get('x-trace-id'))).root;
  assert.deepEqual([root.actor.kind, root.actor.id, root.actor.name], ['contact', ADA, 'Ada Member']);
  const event = root.events.find((item) => item.type === 'signIn');
  assert.deepEqual([event?.attributes.provider, event?.attributes.contactId], ['local', ADA]);
  // The form post is the root's input at level full, its anti-forgery token hidden.
  assert.deepEqual(root.input.body, { contactId: ADA, ReturnUrl: '/', __RequestVerificationToken: '[redacted]' });
  // The signed-in browser's later requests carry the contact's display name too.
  const cookie = posted.headers.getSetCookie()[0].split(';')[0];
  const page = await fetch(sim.url + '/', { headers: { cookie } });
  assert.match(await page.text(), /Ada Member|<main>/);
  const pageRoot = (await endedTree(sim.trace, page.headers.get('x-trace-id'))).root;
  assert.deepEqual([pageRoot.actor.id, pageRoot.actor.name], [ADA, 'Ada Member']);

  const refused = await signIn('5a000000-0000-4000-8000-000000000099');
  assert.equal(refused.status, 400);
  await refused.text();
  const refusedRoot = (await endedTree(sim.trace, refused.headers.get('x-trace-id'))).root;
  assert.deepEqual(
    [refusedRoot.status, refusedRoot.actor.kind, refusedRoot.error?.code, refusedRoot.error?.status],
    ['error', 'anonymous', 'SignInRefused', 400],
  );
  assert.match(refusedRoot.error.message, /Choose an active local persona/);
  assert.equal(
    refusedRoot.events.some((item) => item.type === 'signIn'),
    false,
  );
});

test('an external sign-in traces the provider calls, its identity-provider roots, the registration writes and the contact', async (t) => {
  const { app, idp } = await simulator(t, undefined, undefined, { trace: { level: 'full' } });
  const browser = client(app);
  const done = await signInThrough(browser, idp, {
    returnUrl: '/',
    newUser: { given_name: 'Dana', family_name: 'New', email: 'dana@example.test' },
  });
  assert.equal(done.status, 302);
  assert.equal(done.headers.get('x-sim-route'), 'external-sign-in-registration');
  const contact = app.store.tableRows('contact').find((row) => row.emailaddress1 === 'dana@example.test');
  const callback = await endedTree(app.trace, done.headers.get('x-trace-id'));
  // The callback root names the registered contact and the provider.
  assert.deepEqual([callback.root.actor.kind, callback.root.actor.id], ['contact', contact.contactid]);
  assert.equal(callback.root.actor.name, 'Dana New');
  const event = callback.root.events.find((item) => item.type === 'signIn');
  assert.equal(event?.attributes.contactId, contact.contactid);
  assert.ok(event.attributes.provider, 'the signIn event names the provider');
  // The registration writes run through the record pipeline: Dataverse create spans under the callback root.
  const creates = callback.spans
    .filter((span) => span.kind === 'dataverse' && span.operation === 'create')
    .map((span) => span.entity)
    .sort();
  assert.deepEqual(creates, ['adx_externalidentity', 'contact']);
  // The provider's back-channel calls are http-out spans; each identity-provider root they reach joins under its span.
  const calls = app.trace.spans({ kind: 'http-out', module: 'identity', pageSize: 200 }).items;
  assert.ok(
    calls.some((span) => span.operation === 'metadata'),
    calls.map((span) => span.name).join(', '),
  );
  const providerRoots = app.trace.spans({ host: 'identity-provider', kind: 'http', pageSize: 200 }).items;
  assert.ok(providerRoots.length > 0, 'the local identity provider opens roots');
  for (const call of calls) {
    const served = providerRoots.find((span) => span.parentSpanId === call.spanId);
    assert.ok(served, `the provider request of ${call.name} joins under it`);
    assert.equal(served.traceId, call.traceId);
  }
  // The registration's audit entries name the callback's trace (D-M-4).
  const registrations = (await (await fetch(`${app.url}/_sim/api/audit?kind=registration`)).json()).items;
  assert.ok(registrations.length > 0);
  assert.ok(
    registrations.every((entry) => entry.traceId === callback.trace.traceId && entry.spanId),
    JSON.stringify(registrations.map((entry) => [entry.traceId, entry.spanId])),
  );
  // No token or secret value reaches the trace.
  const exported = JSON.stringify(app.trace.export({}));
  for (const needle of ['id_token=', '"access_token":"ey', 'client_secret='])
    assert.equal(exported.includes(needle), false, needle);
});
