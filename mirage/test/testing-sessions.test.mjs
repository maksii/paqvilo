import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSimulator } from '../server.mjs';
import { createPortalSession, runSessionMatrix, connectRuntime } from '../testing.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const guid = (index) => `10000000-0000-0000-0000-${String(index).padStart(12, '0')}`;
async function fixture(t, { liveBridge, template } = {}) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'mirage-many-visitors-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const sources = {
    'website.yml': 'adx_name: Concurrent fixture\nadx_websiteid: site',
    'webrole.yml': '- adx_webroleid: reader\n  adx_name: Reader',
    'web-pages/home/Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
    'page-templates/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
    'web-templates/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'web-templates/Main.webtemplate.source.html':
      '<actor>{{user.id}}</actor>{% fetchxml own %}<fetch><entity name="widget"><attribute name="widgetid"></attribute></entity></fetch>{% endfetchxml %}<records>{% for row in own.results.entities %}{{row.widgetid}}{% endfor %}</records>',
    'sitesetting.yml':
      '- adx_sitesettingid: enabled\n  adx_name: Webapi/widget/enabled\n  adx_value: "true"\n- adx_sitesettingid: fields\n  adx_name: Webapi/widget/fields\n  adx_value: widgetid,name,owner',
  };
  if (template) sources['web-templates/Main.webtemplate.source.html'] = template;
  for (const [file, value] of Object.entries(sources)) {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await fs.writeFile(path.join(dir, file), value);
  }
  const contacts = Array.from({ length: 10 }, (_, index) => ({
    contactid: guid(index + 1),
    fullname: 'Visitor ' + index,
    statecode: 0,
  }));
  const app = await createSimulator({
    sourceDir: dir,
    stateFile: path.join(dir, 'state.json'),
    port: 0,
    watch: false,
    liveBridge,
    initial: {
      version: 1,
      mappings: {
        contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' },
        widget: { entitySet: 'widgets', idColumn: 'widgetid', nameColumn: 'name' },
      },
      tables: {
        contact: contacts,
        widget: contacts.map((contact, index) => ({
          widgetid: guid(index + 101),
          name: 'Owned ' + index,
          owner: { id: contact.contactid, logical_name: 'contact' },
        })),
      },
      permissions: [
        {
          id: 'own',
          entity: 'widget',
          scope: 'contact',
          field: 'owner',
          roles: ['Reader'],
          operations: ['read', 'update'],
        },
      ],
      settings: { permissionMode: 'enforce' },
      simulator: {
        mode: 'local',
        pageMode: 'local',
        permissionSource: 'configured',
        identity: { roles: [] },
        contactRoles: contacts.map((contact) => ({ contactId: contact.contactid, roleId: 'reader' })),
        endpoints: [],
      },
    },
  });
  ownedFixture(t).add(() => app.close());
  return { app, contacts };
}
test('ten cookie-isolated visitors read and write through real portal handlers without identity leakage', async (t) => {
  const { app, contacts } = await fixture(t),
    runtime = await connectRuntime({ origin: app.url }),
    sessions = await Promise.all(
      contacts.map((contact) => runtime.createSession({ id: contact.contactid, contactId: contact.contactid })),
    );
  t.after(() => sessions.forEach((session) => session.close()));
  const cases = [
    {
      id: 'liquid',
      run: async (session, { index }) => {
        const expected = guid(Number(session.id.slice(-12)) + 100),
          response = await session.request('/');
        assert.equal(response.status, 200);
        const html = await response.text();
        assert.match(html, new RegExp(`<actor>${session.id}</actor>`));
        assert.match(html, new RegExp(`<records>${expected}</records>`));
        return { actor: session.id, record: expected, index };
      },
    },
    {
      id: 'read',
      run: async (session) => {
        const response = await session.json('/_api/widgets?$select=widgetid,name');
        assert.equal(response.status, 200);
        assert.deepEqual(
          response.body.value.map((row) => row.widgetid),
          [guid(Number(session.id.slice(-12)) + 100)],
        );
        return { actor: session.id, count: response.body.value.length };
      },
    },
    {
      id: 'update',
      run: async (session) => {
        const expected = guid(Number(session.id.slice(-12)) + 100),
          response = await session.json(`/_api/widgets(${expected})`, {
            method: 'PATCH',
            body: { name: 'Changed ' + session.id },
          });
        assert.equal(response.status, 204);
        return { actor: session.id, status: response.status };
      },
    },
  ];
  const report = await runSessionMatrix({ sessions, cases, concurrency: 10 });
  assert.equal(report.completed, 30, JSON.stringify(report.results.filter((row) => row.state !== 'completed')));
  assert.equal(report.failed, 0);
  assert.equal(report.peakConcurrency, 10);
  assert.deepEqual(
    report.results.slice(0, 10).map((row) => row.sessionId),
    contacts.map((contact) => contact.contactid),
  );
  assert.deepEqual(
    app.store.tableRows('widget').map((row) => row.name),
    contacts.map((contact) => 'Changed ' + contact.contactid),
  );
  const denied = await sessions[0].json(`/_api/widgets(${guid(102)})`, {
    method: 'PATCH',
    body: { name: 'Cross visitor' },
  });
  assert.equal(denied.status, 403);
  assert.equal(app.store.tableRows('widget')[1].name, 'Changed ' + contacts[1].contactid);
  const description = await sessions[0].session();
  assert.equal(description.contactId, contacts[0].contactid);
  assert.equal(Object.hasOwn(description, 'cookie'), false);
  assert.doesNotMatch(JSON.stringify(sessions[0]), /cookie|csrf/);
  const readEvidence = await sessions[1].json('/_api/widgets?$select=widgetid');
  assert.ok(readEvidence.traceId);
  const audit = await runtime.audit({ correlationId: readEvidence.traceId, contactId: contacts[1].contactid });
  assert.ok(audit.items.length);
  assert.ok(audit.items.every((item) => item.identity.contactId === contacts[1].contactid));
  assert.deepEqual(
    (await runtime.exportAudit({ correlationId: readEvidence.traceId, contactId: contacts[1].contactid })).items,
    audit.items,
  );
  assert.ok(Array.isArray((await runtime.diagnostics()).diagnostics));
  await sessions[0].signOut();
  assert.equal((await sessions[1].session()).contactId, contacts[1].contactid);
  assert.equal((await sessions[0].session()).signedIn, false);
  await assert.rejects(sessions[1].request('/_sim/api/state'), /administration/);
  await assert.rejects(sessions[1].request('https://example.invalid'), /relative/);
  await assert.rejects(sessions[1].request('/', { headers: { cookie: 'other' } }), /owned/);
  app.store.state.simulator.mode = 'live';
  await assert.rejects(createPortalSession({ origin: app.url }), /local Mirage/);
  assert.equal((await sessions[1].request('/')).status, 409);
});
test('local-only visitor refuses outbound reads when mode changes during its render', async (t) => {
  let liveCalls = 0;
  const liveBridge = {
    origin: 'https://example.invalid',
    configure() {},
    status: () => ({ connected: true }),
    close: async () => {},
    request: async () => {
      liveCalls++;
      throw Error('Outbound request reached');
    },
    fetchXml: async () => {
      liveCalls++;
      throw Error('Outbound FetchXML reached');
    },
  };
  const query = '<fetch><entity name="widget"><attribute name="widgetid"></attribute></entity></fetch>',
    template = `{% fetchxml first %}${query}{% endfetchxml %}{% fetchxml second %}${query}{% endfetchxml %}`;
  const { app, contacts } = await fixture(t, { liveBridge, template }),
    visitor = await createPortalSession({ origin: app.url, contactId: contacts[0].contactid });
  t.after(() => visitor.close());
  let changed = false;
  app.store.setPluginPipeline(({ stage }) => {
    if (stage === 40) {
      changed = true;
      app.store.state.simulator.mode = 'live';
    }
  });
  const response = await visitor.request('/');
  await response.text();
  assert.equal(changed, true);
  assert.equal(liveCalls, 0);
  assert.ok(app.store.state.simulator.mode === 'live');
});

test('documented identity scopes preserve cookie precedence and configured fallback after sign-out', async (t) => {
  const { app, contacts } = await fixture(t, { template: '<actor>{{user.id}}</actor>' });
  app.store.state.simulator.identity = { contactId: contacts[0].contactid, roles: [], roleSource: 'memberships' };
  const actor = async (headers) =>
    (await (await fetch(app.url, { headers })).text()).match(/<actor>(.*?)<\/actor>/)?.[1];
  assert.equal(await actor(), '');
  for (const scope of ['configured', 'all-requests']) {
    app.store.state.simulator.identityScope = scope;
    assert.equal(await actor(), contacts[0].contactid);
    const session = app.signIn(contacts[1].contactid);
    assert.equal(await actor({ cookie: session.cookieHeader }), contacts[1].contactid);
    const signedOut = await fetch(`${app.url}/_sim/api/session/sign-out`, {
      method: 'POST',
      headers: { cookie: session.cookieHeader, 'x-sim-csrf': app.csrf, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(signedOut.status, 200);
    assert.equal(await actor({ cookie: signedOut.headers.get('set-cookie').split(';', 1)[0] }), '');
    assert.equal(await actor(), contacts[0].contactid);
  }
  app.store.state.simulator.identityScope = 'sessions';
  assert.equal(await actor(), '');
});

test('runtime experiment controls change local policy and keep concurrent instances independent', async (t) => {
  // The two independent runtimes start concurrently; each owns its directory and closes before it is removed.
  const [left, right] = await Promise.all([fixture(t), fixture(t)]),
    [runtime, other] = await Promise.all([
      connectRuntime({ origin: left.app.url }),
      connectRuntime({ origin: right.app.url }),
    ]);
  const visitor = await runtime.createSession({ contactId: left.contacts[0].contactid }),
    otherVisitor = await other.createSession({ contactId: right.contacts[0].contactid });
  t.after(() => {
    visitor.close();
    otherVisitor.close();
  });
  await runtime.setSiteSetting('Webapi/widget/enabled', 'False');
  assert.equal((await visitor.json('/_api/widgets?$select=widgetid')).status, 404);
  assert.equal((await otherVisitor.json('/_api/widgets?$select=widgetid')).status, 200);
  await runtime.resetSiteSetting('Webapi/widget/enabled');
  assert.equal((await visitor.json('/_api/widgets?$select=widgetid')).status, 200);
  await runtime.setPlatformSettings({ QueryLinkEntityLimit: 30 });
  assert.equal((await runtime.platformSettings()).find((item) => item.key === 'QueryLinkEntityLimit').value, 30);
  assert.equal((await other.platformSettings()).find((item) => item.key === 'QueryLinkEntityLimit').value, 15);
  await runtime.resetPlatformSetting('QueryLinkEntityLimit');
  const preset = {
    id: 'parallel-case',
    name: 'Parallel case',
    platformOverrides: { QueryLinkEntityLimit: 25 },
    portalOverrides: {
      settings: { 'Webapi/widget/enabled': 'False' },
      snippets: { 'Banner/Text': 'Local experiment' },
    },
  };
  await runtime.saveExperiment(preset);
  assert.equal((await runtime.experiments('parallel-case')).name, preset.name);
  assert.ok((await runtime.experiments()).some((item) => item.id === preset.id));
  await runtime.applyExperiment(preset.id);
  assert.equal((await visitor.json('/_api/widgets?$select=widgetid')).status, 404);
  assert.equal((await runtime.platformSettings()).find((item) => item.key === 'QueryLinkEntityLimit').value, 25);
  await runtime.resetSiteSetting('Webapi/widget/enabled');
  await runtime.resetSnippet('Banner/Text');
  await runtime.resetPlatformSetting('QueryLinkEntityLimit');
  await runtime.deleteExperiment(preset.id);
  assert.equal((await visitor.json('/_api/widgets?$select=widgetid')).status, 200);
  assert.equal(left.app.store.state.tables.widget.length, 10);
  assert.equal((await visitor.session()).contactId, left.contacts[0].contactid);
  assert.equal(right.app.store.state.tables.widget.length, 10);
});

test('session matrix bounds concurrency, cancels without retries and serializes durable result callbacks', async () => {
  const visitors = Array.from({ length: 10 }, (_, index) => ({ id: 'visitor' + index, request: () => {} })),
    controller = new AbortController();
  let calls = 0,
    recording = 0,
    peakRecording = 0;
  const report = await runSessionMatrix({
    sessions: visitors,
    cases: [
      {
        id: 'one',
        run: async (_session, { signal }) => {
          calls++;
          await new Promise((resolve) => setTimeout(resolve, 2));
          if (calls === 3) controller.abort();
          return signal.aborted;
        },
      },
    ],
    concurrency: 3,
    signal: controller.signal,
    onResult: async () => {
      recording++;
      peakRecording = Math.max(peakRecording, recording);
      await new Promise((resolve) => setTimeout(resolve, 1));
      recording--;
    },
  });
  assert.equal(calls, 3);
  assert.equal(report.started, 3);
  assert.equal(report.unstarted, 7);
  assert.equal(report.aborted, true);
  assert.equal(peakRecording, 1);
  await assert.rejects(
    runSessionMatrix({ sessions: [visitors[0], visitors[0]], cases: [{ id: 'x', run: () => {} }] }),
    /unique/,
  );
  await assert.rejects(
    runSessionMatrix({ sessions: visitors, cases: [{ id: 'x', run: () => {} }], maxCells: 2 }),
    /bound/,
  );
  let executed = 0;
  const failed = await runSessionMatrix({
    sessions: visitors,
    cases: [
      {
        id: 'x',
        run: () => {
          executed++;
          throw Object.assign(new Error('secret'), { code: 'ExpectedFault' });
        },
      },
    ],
    concurrency: 1,
    failFast: true,
  });
  assert.equal(executed, 1);
  assert.equal(failed.failed, 1);
  assert.equal(failed.unstarted, 9);
  assert.equal(failed.results[0].errorCode, 'ExpectedFault');
  assert.doesNotMatch(JSON.stringify(failed), /secret/);
});
test("parallel matrix preserves each visitor's dependent case order despite uneven latency", async () => {
  const visitors = Array.from({ length: 10 }, (_, index) => ({ id: String(index), request: () => {} })),
    active = new Set(),
    finished = new Map();
  const cases = Array.from({ length: 5 }, (_, caseIndex) => ({
    id: 'step' + caseIndex,
    run: async (visitor) => {
      assert.equal(active.has(visitor.id), false, 'A visitor cannot overlap its cases');
      assert.equal(finished.get(visitor.id) ?? 0, caseIndex, 'Cases retain declared dependency order');
      active.add(visitor.id);
      await new Promise((resolve) => setTimeout(resolve, Number(visitor.id) % 3));
      active.delete(visitor.id);
      finished.set(visitor.id, caseIndex + 1);
    },
  }));
  const report = await runSessionMatrix({ sessions: visitors, cases, concurrency: 32 });
  assert.equal(report.failed, 0);
  assert.equal(report.completed, 50);
  assert.equal(report.peakConcurrency, 10);
  assert.ok([...finished.values()].every((value) => value === 5));
});

test('visitor cookies persist with path/deletion scope and pending requests protect identity controls', async () => {
  const requests = [];
  let resolvePending;
  const fetchImpl = async (url, options) => {
    const pathname = new URL(url).pathname,
      headers = new Headers(options.headers);
    requests.push({ pathname, cookie: headers.get('cookie') });
    if (pathname === '/_sim/api/state')
      return Response.json({ csrf: 'fixture-csrf', config: { mode: 'local', pageMode: 'local' } });
    if (pathname === '/form/start') {
      const response = Response.json({ started: true });
      response.headers.append('set-cookie', 'fixture-visitor=visitor-one; Path=/; HttpOnly');
      response.headers.append('set-cookie', 'fixture-step=step-one; Path=/form');
      response.headers.append('set-cookie', 'foreign=ignored; Domain=example.invalid; Path=/');
      return response;
    }
    if (pathname === '/form/expire') {
      const response = Response.json({ expired: true });
      response.headers.append('set-cookie', 'fixture-step=; Path=/form; Max-Age=0');
      return response;
    }
    if (pathname === '/pending')
      return new Promise((resolve) => {
        resolvePending = () => resolve(Response.json({ complete: true }));
      });
    return Response.json({ cookie: headers.get('cookie') });
  };
  const visitor = await createPortalSession({ origin: 'http://127.0.0.1:8787', fetchImpl });
  await visitor.json('/form/start');
  assert.equal((await visitor.json('/form/check')).body.cookie, 'fixture-step=step-one; fixture-visitor=visitor-one');
  assert.equal((await visitor.json('/outside')).body.cookie, 'fixture-visitor=visitor-one');
  await visitor.json('/form/expire');
  assert.equal((await visitor.json('/form/check')).body.cookie, 'fixture-visitor=visitor-one');
  const pending = visitor.request('/pending');
  await Promise.resolve();
  assert.throws(
    () => visitor.close(),
    (error) => error.code === 'PortalSessionBusy',
  );
  await assert.rejects(visitor.signOut(), (error) => error.code === 'PortalSessionBusy');
  resolvePending();
  await pending;
  visitor.close();
  assert.throws(
    () => visitor.session(),
    (error) => error.code === 'PortalSessionClosed',
  );
  assert.ok(requests.every((request) => !request.cookie?.includes('foreign')));
});
