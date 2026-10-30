import test from 'node:test';
import assert from 'node:assert/strict';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { workflowExtension } from '../lib/dataverse-workflows.mjs';
import { registerAddon } from '../lib/dataverse-addon-common.mjs';
import { committedJobs } from '../lib/committed-work.mjs';
import { localOrganizationService } from '../lib/local-organization-service.mjs';
import { invokeTrustedHandler } from '../lib/trusted-handler-invocation.mjs';
import { DataStore, emptyState } from '../lib/data.mjs';

const workflowId = '10000000-0000-4000-8000-000000000001';
const targetId = '10000000-0000-4000-8000-000000000002';
const effectId = '10000000-0000-4000-8000-000000000003';
const mappings = {
  child: {
    logicalName: 'child',
    entitySet: 'children',
    idColumn: 'childid',
    fields: {
      title: { dataverseType: 'nvarchar' },
    },
  },
};
const actor = (f) => f.store.tableRows('systemuser').find((row) => row.applicationid);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const expired = (fn) => assert.throws(fn, { code: 'LocalPluginExecutionExpired' });

test('a live working target retains store identity equivalence and expires after invocation', async () => {
  const state = emptyState();
  state.mappings.child = mappings.child;
  state.tables.child = [{ childid: 'abcdef00-0000-4000-8000-000000000001', title: 'Before' }];
  const store = new DataStore({ state });
  const row = store.tableRows('child')[0];
  let retained;
  await invokeTrustedHandler(
    { store },
    (ctx) => {
      retained = ctx.target.row;
      ctx.target.row.title = 'Changed';
    },
    { target: { logicalName: 'child', id: row.childid.toUpperCase(), row } },
    { workingTarget: true },
  );
  assert.equal(store.tableRows('child')[0].title, 'Changed');
  expired(() => {
    retained.title = 'Late';
  });
});

for (const mode of ['on-demand', 'real-time trigger', 'background trigger'])
  for (const failure of [false, true])
    test(
      `classic ${mode} detaches information and fences retained capabilities after ${failure ? 'failure' : 'success'}`,
      { timeout: 30000 },
      async (t) => {
        const entered = deferred(),
          release = deferred();
        t.after(() => release.resolve());
        let retained, retainedRows, sdk, original, callerId;
        const f = await contractModuleFixture(t, {
          mappings,
          tables: { child: [{ childid: targetId, title: 'Original target' }] },
          extension: workflowExtension({
            facts: [
              {
                id: workflowId,
                name: 'Invented lifetime',
                category: 0,
                type: 1,
                mode: mode === 'background trigger' ? 0 : 1,
                scope: 4,
                ondemand: mode === 'on-demand',
                triggeroncreate: mode !== 'on-demand',
                primaryentity: 'child',
                state: 1,
                xaml: '<Activity />',
                clientdata: null,
              },
            ],
            handlers: new Map([
              [
                workflowId,
                async (ctx) => {
                  retained = ctx;
                  callerId = ctx.caller.systemuserid;
                  assert.notEqual(ctx.caller, original);
                  ctx.caller.fullname = 'Informational caller';
                  ctx.caller.isdisabled = true;
                  ctx.workflow.activeworkflowid.id = targetId;
                  ctx.target.row.title = 'Target view edit';
                  retainedRows = ctx.api.store.tableRows('child');
                  retainedRows.push({ childid: effectId, title: 'Active API effect' });
                  sdk = localOrganizationService(ctx.api.store, {
                    userId: original.systemuserid,
                    evidence: 'Invented workflow scoped service',
                    grants: [{ entity: 'child', operations: ['create'] }],
                  });
                  entered.resolve();
                  await release.promise;
                  if (failure) throw new Error('Controlled workflow rollback');
                  return { message: 'Completed' };
                },
              ],
            ]),
          }),
        });
        original = actor(f);
        const originalName = original.fullname;
        const pending =
          mode === 'on-demand'
            ? f.request('POST', `/workflows(${workflowId})/Microsoft.Dynamics.CRM.ExecuteWorkflow`, {
                EntityId: targetId,
              })
            : f.request('POST', '/children', { title: 'Triggering row' });
        await entered.promise;
        release.resolve();
        const response = await pending;
        if (mode === 'background trigger') {
          assert.equal(response.status, 201);
          await committedJobs(f.store).drain();
          const jobs = f.store.tableRows('asyncoperation').filter((row) => row.operationtype === 10);
          assert.equal(jobs.length, 1);
          assert.equal(jobs[0].statuscode, failure ? 31 : 30);
        } else assert.equal(response.status >= 400, failure, await response.text());
        assert.equal(actor(f).fullname, originalName);
        assert.equal(actor(f).isdisabled, false);
        assert.notEqual(
          f.store.tableRows('workflow').find((row) => row.workflowid === workflowId).activeworkflowid.id,
          targetId,
        );
        assert.equal(
          f.store.tableRows('child').some((row) => row.childid === effectId),
          !failure,
        );
        if (!failure) {
          const target = f.store.tableRows('child').find((row) => row.childid === retained.target.id);
          assert.equal(
            target.title,
            mode === 'real-time trigger'
              ? 'Target view edit'
              : mode === 'background trigger'
                ? 'Triggering row'
                : 'Original target',
          );
        }
        retained.caller.fullname = 'Late passive caller edit';
        retained.workflow.activeworkflowid.id = targetId;
        assert.equal(retained.caller.systemuserid, callerId);
        assert.ok(f.store.tableRows('systemuser').some((row) => row.systemuserid === callerId));
        expired(() => retained.api.store.tableRows('systemuser'));
        expired(() => retainedRows.push({ childid: targetId, title: 'Late row' }));
        expired(() => sdk.create('child', { title: 'Late service write' }));
        assert.equal(actor(f).fullname, originalName);
        assert.equal(actor(f).isdisabled, false);
      },
    );

async function batch(f, name) {
  const token = await (
    await fetch(`${f.server.origin}/${f.server.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: '77777777-7777-4777-8777-777777777777',
        client_secret: 'contract-module-secret',
        scope: `${f.server.origin}/.default`,
      }),
    })
  ).json();
  assert.equal(typeof token.access_token, 'string');
  const body = [
    '--batch_fixture',
    'Content-Type: multipart/mixed; boundary=changeset_fixture',
    '',
    '--changeset_fixture',
    'Content-Type: application/http',
    'Content-Transfer-Encoding: binary',
    'Content-ID: 1',
    '',
    `POST ${f.server.origin}/api/data/v9.2/${name} HTTP/1.1`,
    'Content-Type: application/json',
    '',
    '{"Meta":{"title":"Original input"}}',
    '--changeset_fixture--',
    '--batch_fixture--',
    '',
  ].join('\r\n');
  return fetch(`${f.server.origin}/api/data/v9.2/$batch`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token.access_token}`,
      'content-type': 'multipart/mixed; boundary=batch_fixture',
    },
    body,
  });
}

for (const mode of ['standalone success', 'changeset success', 'changeset failure'])
  test(
    `trusted addon ${mode} retains passive information without exposing committed aliases or stale APIs`,
    { timeout: 30000 },
    async (t) => {
      const entered = deferred(),
        release = deferred();
      t.after(() => release.resolve());
      let retained, original, rows;
      const name = 'invented_Override';
      const f = await contractModuleFixture(t, {
        mappings,
        tables: { child: [] },
        extension: {
          name: 'invented-lifetime',
          install(api) {
            registerAddon(api, {
              name,
              kind: 'action',
              binding: 'unbound',
              signature: {},
              fallback: () => new Error('Missing handler'),
            });
            api.addonHandlers = new Map([
              [
                name,
                {
                  handler: async (ctx) => {
                    retained = ctx;
                    assert.notEqual(ctx.caller, original);
                    assert.notEqual(ctx.user, original);
                    ctx.caller.fullname = 'Informational caller';
                    ctx.user.isdisabled = true;
                    ctx.args.Meta.title = 'Informational input';
                    rows = ctx.api.store.tableRows('child');
                    rows.push({ childid: effectId, title: 'Active addon effect' });
                    entered.resolve();
                    await release.promise;
                    if (mode === 'changeset failure') throw new Error('Controlled addon rollback');
                    return { Child: rows[0] };
                  },
                },
              ],
            ]);
          },
        },
      });
      original = actor(f);
      const originalName = original.fullname;
      const pending = mode.startsWith('changeset')
        ? batch(f, name)
        : f.request('POST', '/' + name, { Meta: { title: 'Original input' } });
      await entered.promise;
      release.resolve();
      const response = await pending;
      const body = await response.text();
      assert.equal(response.status >= 400, mode === 'changeset failure', body);
      if (mode !== 'changeset failure')
        assert.match(body, /Active addon effect/, 'returned guarded rows are detached before response serialization');
      assert.equal(f.store.tableRows('child').length, mode === 'changeset failure' ? 0 : 1);
      assert.equal(actor(f).fullname, originalName);
      assert.equal(actor(f).isdisabled, false);
      retained.caller.fullname = 'Late passive addon edit';
      retained.args.Meta.title = 'Late passive input';
      assert.equal(retained.caller.systemuserid, original.systemuserid);
      expired(() => retained.api.store.tableRows('systemuser'));
      expired(() => rows.push({ childid: targetId, title: 'Late addon row' }));
      assert.equal(actor(f).fullname, originalName);
    },
  );
