// @test-kind contract: Paqvilo invocation lifetime design: caller views detach, inputs cannot alias caller rows, scoped handles expire, rollback stays isolated
import test from 'node:test';
import assert from 'node:assert/strict';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import * as customApi from '../lib/dataverse-customapi.mjs';
import { createPowerFxEvaluator } from '../lib/canvas-power-fx.mjs';
import { localOrganizationService } from '../lib/local-organization-service.mjs';

const apiId = '10000000-0000-0000-0000-000000000001';
const boundId = '10000000-0000-0000-0000-000000000003';
const name = 'invented_Principal';
const extension = { name: 'dataverse-customapi', ...customApi };
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const tables = (bound = false) => ({
  child: bound ? [{ childid: boundId, title: 'Original bound row' }] : [],
  customapi: [
    {
      customapiid: apiId,
      uniquename: name,
      bindingtype: bound ? 1 : 0,
      ...(bound ? { boundentitylogicalname: 'child' } : {}),
      isfunction: false,
      allowedcustomprocessingsteptype: 0,
    },
  ],
  customapirequestparameter: [
    {
      customapirequestparameterid: apiId,
      customapiid: apiId,
      uniquename: 'Payload',
      type: 3,
      logicalentityname: 'systemuser',
      isoptional: true,
    },
  ],
  customapiresponseproperty: [
    { customapiresponsepropertyid: apiId, customapiid: apiId, uniquename: 'Answer', type: 10 },
  ],
});
const mappings = {
  child: {
    logicalName: 'child',
    entitySet: 'children',
    idColumn: 'childid',
    fields: { title: { dataverseType: 'nvarchar' } },
  },
};
const actor = (f) => f.store.tableRows('systemuser').find((row) => row.applicationid);
const expired = (fn) => assert.throws(fn, { code: 'LocalPluginExecutionExpired' });

for (const mode of ['synchronous', 'asynchronous', 'timeout'])
  test(`HTTP main caller descriptions remain detached and readable after ${mode}`, async (t) => {
    const release = deferred(),
      finished = deferred(),
      entered = deferred();
    t.after(() => release.resolve());
    let principal, retained;
    const handler = (ctx) => {
      retained = ctx.caller;
      assert.equal(retained.systemuserid, principal.systemuserid);
      assert.notEqual(retained, principal);
      retained.fullname = 'Edited informational name';
      retained.isdisabled = true;
      ctx.inputs.Payload.fullname = 'Edited detached input';
      assert.equal(ctx.api.principals.byId(principal.systemuserid).fullname, principal.fullname);
      assert.equal(ctx.api.principals.byId(principal.systemuserid).isdisabled, false);
      localOrganizationService(ctx.api.store, {
        userId: principal.systemuserid,
        evidence: 'Invented principal-view authorization',
        grants: [{ entity: 'child', operations: ['create'] }],
      }).create('child', { title: 'Authorized original principal' });
      const late = release.promise.then(() => {
        retained.fullname = 'Late name';
        retained.isdisabled = true;
        assert.equal(retained.fullname, 'Late name');
        assert.equal(retained.isdisabled, true);
        expired(() => ctx.api.store.tableRows('systemuser'));
        ctx.inputs.Payload.isdisabled = true;
        finished.resolve();
        return { outputs: { Answer: 'Completed' } };
      });
      entered.resolve();
      return mode === 'timeout'
        ? late
        : mode === 'asynchronous'
          ? Promise.resolve({ outputs: { Answer: 'Completed' } })
          : { outputs: { Answer: 'Completed' } };
    };
    const f = await contractModuleFixture(t, {
      mappings,
      tables: tables(),
      extension,
      options: { timeoutMs: 20, handlers: new Map([[name.toLowerCase(), { handler }]]) },
    });
    principal = actor(f);
    const originalName = principal.fullname;
    const pending = f.request('POST', '/' + name, {
      Payload: {
        '@odata.type': 'Microsoft.Dynamics.CRM.systemuser',
        systemuserid: principal.systemuserid,
        fullname: principal.fullname,
        isdisabled: false,
      },
    });
    await Promise.race([
      entered.promise,
      pending.then(async (response) => {
        throw new Error('Main did not enter: ' + (await response.text()));
      }),
    ]);
    const response = await pending;
    assert.equal(response.status, mode === 'timeout' ? 400 : 200);
    assert.equal(actor(f).fullname, originalName);
    assert.equal(actor(f).isdisabled, false);
    release.resolve();
    await finished.promise;
    retained.fullname = 'A separate late caller';
    assert.equal(retained.systemuserid, principal.systemuserid);
    assert.equal(actor(f).fullname, originalName);
    assert.equal(actor(f).isdisabled, false);
    assert.equal(f.store.tableRows('child').length, mode === 'timeout' ? 0 : 1);
  });

for (const synchronous of [true, false])
  test(`${synchronous ? 'Synchronous' : 'Asynchronous'} SDK main inputs and bound rows cannot alias their caller records`, async (t) => {
    let principal, retainedTarget;
    const f = await contractModuleFixture(t, {
      mappings,
      tables: tables(true),
      extension,
      options: {
        handlers: new Map([
          [
            name.toLowerCase(),
            {
              handler: (ctx) => {
                assert.equal(ctx.caller, null);
                retainedTarget = ctx.target.row;
                retainedTarget.title = 'Informational target edit';
                ctx.inputs.Payload.fullname = 'Informational input edit';
                ctx.inputs.Payload.isdisabled = true;
                assert.equal(ctx.api.store.tableRows('child')[0].title, 'Original bound row');
                assert.equal(ctx.api.principals.byId(principal.systemuserid).fullname, principal.fullname);
                localOrganizationService(ctx.api.store, {
                  userId: principal.systemuserid,
                  evidence: 'Invented synchronous principal',
                  grants: [{ entity: 'child', operations: ['create'] }],
                }).create('child', { title: 'Authorized synchronous write' });
                return { outputs: { Answer: 'Completed' } };
              },
            },
          ],
        ]),
      },
    });
    principal = actor(f);
    const originalName = principal.fullname;
    const profile = {
      userId: principal.systemuserid,
      evidence: 'Invented bound SDK caller',
      grants: [
        { message: name, operations: ['execute'] },
        { entity: 'child', operations: ['read'] },
      ],
    };
    const request = {
      principal: profile,
      name,
      target: { entity: 'child', id: boundId },
      parameters: synchronous
        ? {
            $type: 'ParameterCollection',
            values: {
              Payload: {
                $type: 'Entity',
                logicalName: 'systemuser',
                id: principal.systemuserid,
                attributes: principal,
              },
            },
          }
        : { Payload: principal },
    };
    const result = synchronous
      ? await f.store.transact(() => f.store.sdkMutation(() => f.api.records.executeMessageSyncInternal(request)), {
          isolated: true,
        })
      : await f.api.records.executeMessageInternal(request);
    assert.equal(result.body.Answer, 'Completed');
    retainedTarget.title = 'Late target edit';
    assert.equal(retainedTarget.childid, boundId);
    assert.equal(actor(f).fullname, originalName);
    assert.equal(actor(f).isdisabled, false);
    assert.equal(f.store.tableRows('child').find((row) => row.childid === boundId).title, 'Original bound row');
    assert.equal(f.store.tableRows('child').length, 2);
  });

for (const mode of ['success', 'timeout', 'automated'])
  test(`Power Fx caller information detaches while existing scoped handles expire after ${mode}`, async (t) => {
    const release = deferred(),
      finished = deferred(),
      entered = deferred();
    t.after(() => release.resolve());
    let f, principal, retainedUser, retainedCaller, retainedIdentity, retainedApi, retainedHierarchy;
    const readPrincipals = [];
    const evaluate = (_expression, { host }) => {
      retainedUser = host.caller.user;
      retainedCaller = host.caller.caller;
      assert.equal(retainedUser.systemuserid, principal.systemuserid);
      assert.equal(retainedCaller.systemuserid, principal.systemuserid);
      retainedUser.fullname = 'Informational Fx name';
      retainedUser.isdisabled = true;
      retainedCaller.fullname = 'Informational Fx caller';
      retainedCaller.isdisabled = true;
      retainedUser.systemuserid = '10000000-0000-0000-0000-000000000099';
      assert.equal(typeof host.caller.identity.dataverse.hierarchy, 'function');
      retainedIdentity = host.caller.identity;
      retainedHierarchy = [retainedIdentity.dataverse.hierarchy, retainedIdentity.dataverse.userHierarchy];
      retainedApi = host.caller.api;
      host.caller.identity.id = '10000000-0000-0000-0000-000000000099';
      host.dataSource('children').adapter.read();
      assert.ok(readPrincipals.length > 0);
      assert.equal(
        readPrincipals.every((id) => id === principal.systemuserid),
        true,
      );
      assert.equal(host.dataSource('children').adapter.dataSourceInfo('CreatePermission'), true);
      if (mode !== 'automated') host.dataSource('children').adapter.create({ title: 'Authorized Fx original caller' });
      assert.equal(f.store.tableRows('systemuser').find((row) => row.applicationid).isdisabled, false);
      const late = release.promise.then(() => {
        if (mode === 'automated') {
          expired(() => {
            retainedUser.fullname = 'Late Fx name';
          });
          expired(() => {
            retainedCaller.isdisabled = true;
          });
        } else {
          retainedUser.fullname = 'Late Fx name';
          retainedCaller.isdisabled = true;
          assert.equal(retainedUser.fullname, 'Late Fx name');
          assert.equal(retainedCaller.isdisabled, true);
        }
        if (retainedApi) expired(() => retainedApi.store.tableRows('systemuser'));
        for (const service of retainedHierarchy) expired(() => service());
        finished.resolve();
        return { value: { Answer: 'Completed' } };
      });
      entered.resolve();
      return mode === 'timeout'
        ? late
        : { value: mode === 'automated' ? { title: 'Computed title' } : { Answer: 'Completed' } };
    };
    const evaluator = createPowerFxEvaluator({
      adapter: { evaluate: mode === 'timeout' ? async (...args) => evaluate(...args) : evaluate },
    });
    const seeded = tables();
    seeded.fxexpression = [
      {
        fxexpressionid: apiId,
        expression: 'CallerView',
        statecode: 0,
        ...(mode === 'automated'
          ? { messagename: 'Create', entitylogicalname: 'child', name: 'Invented automation' }
          : {}),
      },
    ];
    if (mode !== 'automated') seeded.customapi[0].fxexpressionid = apiId;
    f = await contractModuleFixture(t, {
      mappings,
      tables: seeded,
      extension,
      providers: { powerFx: evaluator },
      options: { timeoutMs: 20 },
    });
    principal = actor(f);
    const query = f.store.query;
    f.store.query = function (entity, params, identity, ...rest) {
      if (this.resolveMapping(entity).logicalName === 'child') readPrincipals.push(identity.id);
      return query.call(this, entity, params, identity, ...rest);
    };
    const originalName = principal.fullname;
    const pending =
      mode === 'automated' ? f.request('POST', '/children', { title: 'Requested' }) : f.request('POST', '/' + name, {});
    await Promise.race([
      entered.promise,
      pending.then(async (response) => {
        throw new Error('Fx did not enter: ' + (await response.text()));
      }),
    ]);
    const response = await pending;
    assert.equal(response.status, mode === 'timeout' ? 400 : mode === 'automated' ? 201 : 200);
    release.resolve();
    await finished.promise;
    if (mode === 'automated')
      expired(() => {
        retainedUser.isdisabled = true;
      });
    else {
      retainedUser.isdisabled = true;
      assert.equal(retainedUser.systemuserid, '10000000-0000-0000-0000-000000000099');
    }
    retainedIdentity.id = '10000000-0000-0000-0000-000000000098';
    if (retainedApi) expired(() => retainedApi.store.tableRows('systemuser'));
    for (const service of retainedHierarchy) expired(() => service());
    assert.equal(actor(f).fullname, originalName);
    assert.equal(actor(f).isdisabled, false);
    assert.equal(f.store.tableRows('child').length, mode === 'timeout' ? 0 : 1);
  });

test('principal lookup helpers keep active mutations inside the isolated operation rollback', async (t) => {
  let principal;
  const f = await contractModuleFixture(t, {
    mappings,
    tables: tables(),
    extension,
    options: {
      handlers: new Map([
        [
          name.toLowerCase(),
          {
            handler: (ctx) => {
              const resolved = ctx.api.principals.resolve({ appid: principal.applicationid });
              assert.equal(resolved.user.systemuserid, principal.systemuserid);
              resolved.user.isdisabled = true;
              assert.equal(ctx.api.principals.byId(principal.systemuserid).isdisabled, true);
              ctx.api.principals.byApplicationId(principal.applicationid).fullname = 'Working graph mutation';
              assert.equal(
                ctx.api.store.tableRows('systemuser').find((row) => row.applicationid).fullname,
                'Working graph mutation',
              );
              assert.notEqual(principal.fullname, 'Working graph mutation');
              throw new Error('Controlled principal-helper rollback');
            },
          },
        ],
      ]),
    },
  });
  principal = actor(f);
  const originalName = principal.fullname;
  assert.equal((await f.request('POST', '/' + name, {})).status, 400);
  assert.equal(actor(f).fullname, originalName);
  assert.equal(actor(f).isdisabled, false);
});
