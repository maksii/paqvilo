// @test-kind compatibility: an original DLL compiled against the official Microsoft.Xrm.Sdk and Microsoft.Crm.Sdk.Proxy casts typed message responses, catches FaultException<OrganizationServiceFault> and resolves the documented plug-in services; no native capture of these calls yet
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { createOrganizationRuntime } from '../lib/dataverse-organization.mjs';
import { dispatchSdkCall, prepareClrRuntime } from '../lib/plugin-clr.mjs';
import { pluginCatalogue, runPluginPhase } from '../lib/exported-plugins.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import childProcess from 'node:child_process';
import { createTraceStore } from '../lib/trace-store.mjs';
import { once } from 'node:events';
import { ORDINARY_CLR_TIMEOUT_MS } from './fixtures/clr-budget.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';

const objectId = '71000000-0000-0000-0000-000000000001';
// The response class follows the request class, as the recorded native sdkSurface scenario shows: WhoAmIRequest answers
// Microsoft.Crm.Sdk.Messages.WhoAmIResponse, new OrganizationRequest("WhoAmI") the base Microsoft.Xrm.Sdk.OrganizationResponse.
const SOURCE = `using System;using System.ServiceModel;using Microsoft.Xrm.Sdk;using Microsoft.Xrm.Sdk.Messages;using Microsoft.Xrm.Sdk.Metadata;using Microsoft.Xrm.Sdk.PluginTelemetry;using Microsoft.Crm.Sdk.Messages;
namespace Invented {public sealed class Probe:IPlugin {
static void Check(bool ok,string what){if(!ok)throw new InvalidPluginExecutionException("Probe failed: "+what);}
public void Execute(IServiceProvider p){
var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));if((string)((Entity)c.InputParameters["Target"])["x_name"]!="probe")return;
var trace=(ITracingService)p.GetService(typeof(ITracingService));
var s=((IOrganizationServiceFactory)p.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);
var who=(WhoAmIResponse)s.Execute(new WhoAmIRequest());Check(who.UserId==c.UserId,"typed WhoAmI");
var untyped=s.Execute(new OrganizationRequest("WhoAmI"));Check(untyped.GetType()==typeof(OrganizationResponse)&&untyped.Results.Contains("UserId"),"untyped WhoAmI answers "+untyped.GetType().FullName);
var version=(RetrieveVersionResponse)s.Execute(new RetrieveVersionRequest());Check(version.Version=="9.2.99.1","RetrieveVersion "+version.Version);
var entity=(RetrieveEntityResponse)s.Execute(new RetrieveEntityRequest{LogicalName="x_item",EntityFilters=EntityFilters.Entity});Check(entity.EntityMetadata.LogicalName=="x_item","RetrieveEntity metadata");
var batch=new ExecuteMultipleRequest{Requests=new OrganizationRequestCollection(),Settings=new ExecuteMultipleSettings{ContinueOnError=true,ReturnResponses=true}};
var child=new Entity("x_item");child["x_name"]="batched";batch.Requests.Add(new CreateRequest{Target=child});batch.Requests.Add(new DeleteRequest{Target=new EntityReference("x_item",new Guid("80000000-0000-0000-0000-000000000009"))});
var multiple=(ExecuteMultipleResponse)s.Execute(batch);Check(multiple.IsFaulted&&multiple.Responses.Count==2,"ExecuteMultiple items");
Check(multiple.Responses[0].Response is CreateResponse&&((CreateResponse)multiple.Responses[0].Response).id!=Guid.Empty,"ExecuteMultiple typed item response");
Check(multiple.Responses[1].Fault.ErrorCode==unchecked((int)0x80040217),"ExecuteMultiple item fault");
try{s.Retrieve("x_nope",Guid.NewGuid(),new Microsoft.Xrm.Sdk.Query.ColumnSet(true));Check(false,"unknown table read");}catch(FaultException<OrganizationServiceFault> fault){trace.Trace("fault {0:x8}",fault.Detail.ErrorCode);}
var logger=(ILogger)p.GetService(typeof(ILogger));logger.LogInformation("Probe {Name} logged","invented");
var variables=(IEnvironmentVariableService)p.GetService(typeof(IEnvironmentVariableService));Check(variables.RetrieveEnvironmentVariableValue("x_setting")=="current value","environment variable");Check(variables.RetrieveEnvironmentVariableValue("x_absent")==null,"absent environment variable");
var notifier=(IServiceEndpointNotificationService)p.GetService(typeof(IServiceEndpointNotificationService));notifier.Execute(new EntityReference("serviceendpoint",new Guid("76000000-0000-0000-0000-000000000001")),c);
try{notifier.Execute(new EntityReference("serviceendpoint",new Guid("76000000-0000-0000-0000-000000000002")),c);Check(false,"failing endpoint");}catch(FaultException<OrganizationServiceFault> fault){trace.Trace("endpoint fault {0:x8}",fault.Detail.ErrorCode);}
trace.Trace("probe completed");
}}}`;

// A loopback web hook receiver in its own process (the synchronous I/O bridge posts while this thread waits).
const RECEIVER = `import http from 'node:http';
const log = [];
http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    if (req.url === '/__log') { res.writeHead(200); res.end(JSON.stringify(log)); return; }
    log.push({ path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    res.writeHead(req.url.endsWith('/500') ? 500 : 200); res.end('');
  });
}).listen(0, '127.0.0.1', function () { process.send(this.address().port); });
`;
async function receiver(root) {
  const file = path.join(root, 'receiver.mjs');
  await fs.writeFile(file, RECEIVER);
  // The receiver reports its port over the IPC channel and stops when the test disconnects it.
  const child = childProcess.fork(file, [], { stdio: 'inherit' });
  const [port] = await Promise.race([
    once(child, 'message'),
    once(child, 'exit').then(([code]) => Promise.reject(new Error('receiver exited with ' + code))),
  ]);
  const origin = 'http://127.0.0.1:' + port;
  return {
    origin,
    log: () => fetch(origin + '/__log').then((response) => response.json()),
    stop: () => (child.exitCode === null && child.signalCode === null ? (child.kill(), once(child, 'exit')) : null),
  };
}

test(
  'an original DLL casts typed message responses, catches organization faults and uses the plug-in services',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-sdk-runtime-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const hook = await receiver(root);
    t.after(() => hook.stop());
    const sdk = clrSdk(),
      proxy = path.join(path.dirname(sdk), 'Microsoft.Crm.Sdk.Proxy.dll'),
      source = path.join(root, 'Probe.cs'),
      assembly = path.join(root, 'Probe.dll');
    await fs.writeFile(source, SOURCE);
    compileClr(source, assembly, {
      references: [sdk, proxy, 'System.ServiceModel.dll', 'System.Runtime.Serialization.dll'],
    });

    const state = emptyState();
    state.mappings.x_item = { entitySet: 'x_items', idColumn: 'x_itemid' };
    state.tables.x_item = [];
    const definition = '72000000-0000-0000-0000-000000000001';
    state.tables.environmentvariabledefinition = [
      {
        environmentvariabledefinitionid: definition,
        schemaname: 'x_setting',
        defaultvalue: 'default value',
        type: 100000000,
      },
    ];
    state.tables.serviceendpoint = [
      {
        serviceendpointid: '76000000-0000-0000-0000-000000000001',
        name: 'Invented hook',
        url: hook.origin + '/hook',
        authtype: 5,
        authvalue: '',
        contract: 8,
      },
      {
        serviceendpointid: '76000000-0000-0000-0000-000000000002',
        name: 'Invented failing hook',
        url: hook.origin + '/500',
        authtype: 5,
        authvalue: '',
        contract: 8,
      },
    ];
    state.tables.environmentvariablevalue = [
      {
        environmentvariablevalueid: '72000000-0000-0000-0000-000000000002',
        environmentvariabledefinitionid: definition,
        value: 'current value',
      },
    ];
    const store = await new DataStore({ state }).init();
    const organization = await createOrganizationRuntime({
      store,
      settings: dataverseSettings({
        enabled: true,
        version: '9.2.99.1',
        users: [
          { objectId, domainname: 'probe@invented.test', fullname: 'Invented probe', roles: ['System Administrator'] },
        ],
      }),
    });
    t.after(() => organization.close());
    const user = store.tableRows('systemuser').find((row) => row.fullname === 'Invented probe').systemuserid;
    const profile = {
      userId: user,
      evidence: 'Invented SDK runtime probe',
      grants: [{ entity: 'x_item', operations: ['read', 'create', 'update', 'delete'] }],
    };
    // No dependencies: the runtime supplies Microsoft.Crm.Sdk.Proxy from the SDK folder, as the sandbox does.
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: path.basename(assembly),
      typeName: 'Invented.Probe',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      serviceProfile: profile,
      context: { executionUserId: user, initiatingUserId: user, organizationId: user, businessUnitId: user },
      timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
    });
    assert.ok(runtime.files.some((file) => path.basename(file.path) === 'Microsoft.Crm.Sdk.Proxy.dll'));
    const step = {
        id: '73000000-0000-0000-0000-000000000001',
        name: 'Invented probe',
        assemblyId: 'invented-probe',
        enabled: true,
        entity: 'x_item',
        message: 'Create',
        stage: 10,
        rank: 1,
        mode: 0,
        supportedDeployment: 0,
        filteringAttributes: [],
        images: [],
        typeName: 'Invented.Probe',
      },
      runtimes = new Map([[step.id, runtime]]),
      notes = [];
    const items = pluginCatalogue({
      plugins: { steps: [step] },
      runtimes,
      overrides: { ['plugin-step:' + step.id]: { mode: 'clr' } },
    });
    store.setPluginPipeline((context) =>
      runPluginPhase({ ...context, store, runtimes, items, diagnostic: (note) => notes.push(note) }),
    );
    store.traces = createTraceStore({ settings: { level: 'summary' } });
    const request = store.traces.start({ kind: 'http', name: 'POST /invented', module: 'portal' });
    await store.traces.run(request, () =>
      dispatchSdkCall({
        store,
        profile,
        message: {
          method: 'Execute',
          userId: user,
          arguments: [
            {
              $type: 'OrganizationRequest',
              requestName: 'Create',
              parameters: {
                $type: 'ParameterCollection',
                values: {
                  Target: {
                    $type: 'Entity',
                    logicalName: 'x_item',
                    id: '00000000-0000-0000-0000-000000000000',
                    attributes: { x_name: 'probe' },
                  },
                },
              },
            },
          ],
        },
      }),
    );
    request.end();
    // Tracing: the step span carries the ILogger entries as telemetry events, and every SDK and service call is an sdk-call span.
    const { spans } = store.traces.tree(request.traceId);
    const stepSpan = spans.find((span) => span.kind === 'plugin-step');
    assert.deepEqual(
      stepSpan.events.filter((event) => event.type === 'telemetry').map((event) => event.message),
      ['Probe invented logged'],
    );
    const calls = spans
      .filter((span) => span.kind === 'sdk-call' && span.parentSpanId === stepSpan.spanId)
      .map((span) => span.name);
    for (const name of [
      'WhoAmI',
      'RetrieveEntity',
      'ExecuteMultiple',
      'IEnvironmentVariableService.RetrieveEnvironmentVariableValue',
      'IServiceEndpointNotificationService.Execute',
    ])
      assert.ok(calls.includes(name), name);
    const traces = notes.filter((note) => note.code === 'PLUGIN_CLR_TRACE').map((note) => note.message);
    // The unknown table reaches the plug-in as FaultException<OrganizationServiceFault> with the code the local Web API answers
    // for the same failure (0x8006088a); the native SDK code for an unknown table is not captured.
    assert.deepEqual(traces, ['fault 8006088a', 'endpoint fault 80040265', 'probe completed']);
    // IServiceEndpointNotificationService.Execute posted the plug-in's RemoteExecutionContext to the web hook.
    const posts = await hook.log();
    assert.deepEqual(
      posts.map((post) => post.path),
      ['/hook', '/500'],
    );
    assert.equal(posts[0].body.MessageName, 'Create');
    assert.equal(posts[0].body.PrimaryEntityName, 'x_item');
    assert.equal(posts[0].body.Stage, 10);
    assert.equal(posts[0].headers['x-ms-dynamics-request-name'], 'Create');
    assert.deepEqual(
      notes.filter((note) => note.code === 'PLUGIN_CLR_TELEMETRY').map(({ level, message }) => ({ level, message })),
      [{ level: 'Information', message: 'Probe invented logged' }],
    );
    // The PreValidation step's ExecuteMultiple Create committed with the probe row.
    assert.deepEqual(
      store
        .tableRows('x_item')
        .map((row) => row.x_name)
        .sort(),
      ['batched', 'probe'],
    );
  },
);
