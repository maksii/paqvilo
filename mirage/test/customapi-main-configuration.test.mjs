// @test-kind parity: native customApi scenario, stage-30 main-operation events record constructor configuration unsecure null and secure null although the plug-in type is registered with step configuration elsewhere
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { install } from '../lib/dataverse-customapi.mjs';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';

const id = (n) => `41000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const name = 'invented_MainConfiguration';

// The original main-operation plug-in reports the constructor arguments it received. The trusted descriptor carries constructor
// text (as a test or harness runtime may), which native never passes to a custom API main operation.
test(
  'an original CLR custom API main operation is constructed with null configuration',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-main-configuration-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const sdk = clrSdk(),
      source = path.join(root, 'Main.cs'),
      assembly = path.join(root, 'Main.dll');
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;namespace Invented {
public sealed class Main:IPlugin{readonly string u,s;public Main(string unsecure,string secure){u=unsecure;s=secure;}
public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));c.OutputParameters["Reply"]=(u??"<null>")+"|"+(s??"<null>");}}}`,
    );
    compileClr(source, assembly, { references: [sdk] });
    const descriptor = {
      trust: 'execute-local-assembly',
      root,
      assembly: path.basename(assembly),
      typeName: 'Invented.Main',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      unsecureConfiguration: 'Descriptor unsecure',
      secureConfiguration: 'Descriptor secure',
      serviceProfile: { userId: id(1), evidence: 'Invented main configuration', grants: [] },
      context: {
        executionUserId: id(1),
        initiatingUserId: id(1),
        organizationId: id(1),
        businessUnitId: id(1),
        mainOperationStepId: id(2),
        mainOperationStepEvidence: 'Invented main configuration identity',
      },
    };
    const f = await contractModuleFixture(t, {
      tables: {
        customapi: [
          {
            customapiid: id(1),
            uniquename: name,
            bindingtype: 0,
            isfunction: false,
            allowedcustomprocessingsteptype: 2,
            plugintypeid: id(1),
          },
        ],
        customapiresponseproperty: [
          { customapiresponsepropertyid: id(3), customapiid: id(1), uniquename: 'Reply', type: 10 },
        ],
        plugintype: [{ plugintypeid: id(1), typename: 'Invented.Main', pluginassemblyid: id(1) }],
        pluginassembly: [{ pluginassemblyid: id(1), name: 'Main' }],
      },
      extension: {
        name: 'customapi',
        async install(api) {
          await install(api, { pluginRuntimes: new Map([[id(1), descriptor]]) }).ready;
        },
      },
    });
    const reply = await f.json(await f.request('POST', '/' + name, {}), 200);
    assert.equal(reply.Reply, '<null>|<null>');
  },
);
