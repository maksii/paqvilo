import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { pluginCatalogue, parsePluginDocument, pluginUnsupported } from '../lib/exported-plugins.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { overlayRegisteredSteps } from '../lib/dataverse-plugin-registration.mjs';
import { dispatchSdkCall, prepareClrRuntime, closeClrHostPool } from '../lib/plugin-clr.mjs';
import { handleSoap } from '../lib/dataverse-soap.mjs';
import { envelope, encodeValue } from '../lib/dataverse-soap-xml.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';
import { ORDINARY_CLR_TIMEOUT_MS } from './fixtures/clr-budget.mjs';

const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const mappings = Object.fromEntries(
  ['widget', 'gadget'].map((entity) => [
    entity,
    {
      logicalName: entity,
      entitySet: entity + 's',
      idColumn: entity + 'id',
      fields: { name: { dataverseType: 'nvarchar' }, memo: { dataverseType: 'nvarchar' } },
    },
  ]),
);
const extension = { name: 'invented-global-write-probe', install: () => {} };
const administrator = (f) =>
  f.store
    .tableRows('systemuser')
    .find((row) => f.api.principals.roles(row).some((role) => role.name === 'System Administrator'));
function definition(n, message, stage, extra = {}) {
  return {
    id: id(n),
    name: 'Global',
    enabled: true,
    entity: null,
    unfiltered: true,
    messageFilterId: null,
    message,
    stage,
    rank: 1,
    mode: 0,
    supportedDeployment: 0,
    filteringAttributes: [],
    images: [],
    typeName: 'Invented.Probe',
    assemblyId: id(90),
    ...extra,
  };
}
async function soap(f, operation, entity, targetId) {
  const target =
    operation === 'Update'
      ? {
          type: 'Entity',
          logicalName: entity,
          id: targetId,
          attributes: new Map([['name', { type: 'string', value: 'Before' }]]),
        }
      : { type: 'EntityReference', logicalName: entity, id: targetId };
  const bodyText = envelope(
    `<svc:Execute><svc:request i:type="a:OrganizationRequest"><a:Parameters><a:KeyValuePairOfstringanyType><b:key>Target</b:key>${encodeValue('b:value', target)}</a:KeyValuePairOfstringanyType></a:Parameters><a:RequestName>${operation}</a:RequestName></svc:request></svc:Execute>`,
  );
  const user = administrator(f);
  return handleSoap(
    {
      method: 'POST',
      bodyText,
      headers: {},
      origin: f.server.origin,
      user,
      caller: user,
      identity: { admin: true, systemUserId: user.systemuserid, id: user.systemuserid },
    },
    f.api,
  );
}

test(
  'original CLR PK filters and global Update/Delete bindings execute across HTTP, SOAP and SDK on distinct schemas',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-primary-global-'));
    let backend;
    t.after(async () => {
      await backend?.close();
      await closeClrHostPool();
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
    });
    const sdk = clrSdk(),
      source = path.join(root, 'Probe.cs'),
      assembly = path.join(root, 'Probe.dll');
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;namespace Invented {public sealed class Probe:IPlugin {public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));if(c.PrimaryEntityName!="widget"&&c.PrimaryEntityName!="gadget")return;var target=c.InputParameters["Target"];var entity=target as Entity;var reference=target as EntityReference;var logical=entity!=null?entity.LogicalName:reference.LogicalName;var key=entity!=null?entity.Id:reference.Id;if(logical!=c.PrimaryEntityName||key!=c.PrimaryEntityId)throw new Exception("Global binding lost actual row identity");if(c.OwningExtension.Name=="Absent")throw new Exception("Absent filter executed");if(c.OwningExtension.Name=="PK"&&!entity.Contains(logical+"id"))throw new Exception("Implicit primary attribute absent");((ITracingService)p.GetService(typeof(ITracingService))).Trace("{0}|{1}|{2}|{3}",c.MessageName,logical,c.Stage,c.OwningExtension.Name);}}}`,
    );
    compileClr(source, assembly, { references: [sdk] });
    const f = await contractModuleFixture(t, { mappings, tables: { widget: [], gadget: [] }, extension });
    const request = f.request;
    f.request = (method, route, body, headers) => request(method, route, body, { connection: 'close', ...headers });
    const user = administrator(f).systemuserid;
    const profile = {
      userId: user,
      evidence: 'Invented global write caller',
      grants: ['widget', 'gadget'].map((entity) => ({ entity, operations: ['read', 'update', 'delete'] })),
    };
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: 'Probe.dll',
      typeName: 'Invented.Probe',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
      persistentHost: true,
      serviceProfile: profile,
      context: { executionUserId: user, initiatingUserId: user, organizationId: user, businessUnitId: user },
    });
    const steps = ['widget', 'gadget'].flatMap((entity, index) =>
      [10, 20, 40].flatMap((stage, offset) => [
        definition(10 + index * 10 + offset, 'Update', stage, {
          entity,
          unfiltered: false,
          name: 'PK',
          filteringAttributes: [entity + 'id'],
        }),
        definition(30 + index * 10 + offset, 'Update', stage, {
          entity,
          unfiltered: false,
          name: 'Absent',
          filteringAttributes: ['memo'],
        }),
      ]),
    );
    steps.push(
      definition(60, 'Update', 20),
      ...[10, 20, 40].map((stage, index) => definition(61 + index, 'Delete', stage)),
    );
    const runtimes = new Map(steps.map((step) => [step.id, runtime])),
      descriptors = new Map(steps.map((step) => [step.id, runtime.descriptor]));
    const items = pluginCatalogue({
      plugins: { steps },
      runtimes,
      descriptors,
      overrides: Object.fromEntries(steps.map((step) => ['plugin-step:' + step.id, { mode: 'clr' }])),
    });
    assert.ok(items.every((item) => item.unsupported === null));
    const seen = [];
    backend = await createOrganizationBackend({
      store: f.store,
      items: () => items,
      runtimes,
      descriptors,
      diagnostic: (entry) => {
        if (entry.code === 'PLUGIN_CLR_TRACE') seen.push(entry.message);
      },
    });
    for (const transport of ['HTTP', 'SOAP', 'SDK'])
      for (const entity of ['widget', 'gadget']) {
        const targetId = id(entity === 'widget' ? 1 : 2);
        f.store.state.tables[entity] = [{ [entity + 'id']: targetId, name: 'Before' }];
        for (const operation of ['Update', 'Delete']) {
          seen.length = 0;
          if (transport === 'HTTP') {
            const response = await f.request(
              operation === 'Update' ? 'PATCH' : 'DELETE',
              `/${entity}s(${targetId})`,
              operation === 'Update' ? { name: 'Before' } : undefined,
              operation === 'Update' ? { 'if-match': '*' } : {},
            );
            assert.equal(response.status, operation === 'Update' ? 200 : 204, await response.text());
          } else if (transport === 'SOAP') {
            const response = await soap(f, operation, entity, targetId);
            assert.equal(response.status, 200, response.body);
          } else {
            const args =
              operation === 'Update'
                ? [{ $type: 'Entity', logicalName: entity, id: targetId, attributes: { name: 'Before' } }]
                : [entity, { $type: 'Guid', value: targetId }];
            await f.store.transact(() =>
              dispatchSdkCall({
                store: f.store,
                profile,
                message: { method: operation, userId: user, arguments: args },
              }),
            );
          }
          const expected =
            operation === 'Update'
              ? [10, 20, 40].map((stage) => `Update|${entity}|${stage}|PK`).concat(`Update|${entity}|20|Global`)
              : [10, 20, 40].map((stage) => `Delete|${entity}|${stage}|Global`);
          assert.deepEqual([...seen].sort(), expected.sort(), `${transport} ${entity} ${operation}`);
        }
      }
  },
);

// Native accepts and runs global Create steps, and accepts an image on a global Update (registration probes); images
// project for the table the message fires on.
test('source and HTTP registrations retain explicit global Update/Delete bindings, with images and global Create', async (t) => {
  const f = await contractModuleFixture(t, {
    mappings,
    tables: {
      pluginassembly: [{ pluginassemblyid: id(90), name: 'Invented.Global' }],
      plugintype: [{ plugintypeid: id(91), typename: 'Invented.Probe', pluginassemblyid: id(90) }],
    },
    extension,
  });
  for (const message of ['Update', 'Delete']) {
    const row = f.store.tableRows('sdkmessage').find((item) => item.name === message);
    const response = await f.request('POST', '/sdkmessageprocessingsteps', {
      name: 'Global ' + message,
      stage: 20,
      rank: 1,
      mode: 0,
      supporteddeployment: 0,
      'sdkmessageid@odata.bind': `/sdkmessages(${row.sdkmessageid})`,
      'eventhandler_plugintype@odata.bind': `/plugintypes(${id(91)})`,
    });
    assert.equal(response.status, 201, await response.text());
    const exported = parsePluginDocument(
      `<ImportExportXml><SdkMessageProcessingStep SdkMessageProcessingStepId="${id(92)}" SdkMessageName="${message}" PrimaryEntity="none" Stage="20" Rank="1" Mode="0" SupportedDeployment="0" PluginTypeName="Invented.Probe" /></ImportExportXml>`,
    );
    assert.equal(exported.steps[0].unfiltered, true);
    assert.equal(exported.steps[0].entity, null);
  }
  const { steps } = overlayRegisteredSteps({ assemblies: [], types: [], steps: [] }, f.store);
  for (const message of ['Update', 'Delete']) {
    const step = steps.find((item) => item.message === message);
    assert.equal(step.unfiltered, true);
    assert.equal(step.entity, null);
    assert.equal(step.messageFilterId, null);
    assert.equal(step.unsupported, null);
    assert.equal(
      pluginUnsupported(
        { ...step, images: [{ name: 'Before', alias: 'Before', type: 0, attributes: [] }] },
        { images: true },
      ),
      null,
    );
  }
  assert.equal(pluginUnsupported(definition(99, 'Create', 20)), null, 'global Create is admitted');
});
