// @test-kind parity: native recorder captures 2026-10-30 mergeAccount (native and native-r2): Web API Merge of two accounts as an original CLR observer sees it
// @parity-evidence: native mergeAccount (native and native-r2) Merge InputParameters tag; the fixture's merge helper can send the request tag as ?tag= (no existing assertion changed)
// An original CLR observer registered on Merge and the Updates it runs logs what each execution sees: images by
// message property, the Updates' Targets and the parent chain. Invented loopback accounts and identities only.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';
import { prepareClrRuntime } from '../lib/plugin-clr.mjs';
import { createScheduler } from '../lib/runtime-clock.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';
import { ORDINARY_CLR_TIMEOUT_MS } from './fixtures/clr-budget.mjs';

const uuid = (prefix, n) => `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const caller = uuid(1, 1),
  target = uuid(2, 1),
  subordinate = uuid(2, 2);

let prepared, root, log;
after(() => root && fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
// One line per execution: message|stage|mode|depth|parent chain|input keys|Target|pre images|post images|preC|postC.
// An image is alias=id:name; a Target Entity lists its attributes sorted as key=value.
async function observer() {
  prepared ??= (async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-merge-'));
    log = path.join(root, 'seen.txt');
    const source = path.join(root, 'Observer.cs');
    await fs.writeFile(
      source,
      `using System;using System.IO;using System.Linq;using System.Collections.Generic;using Microsoft.Xrm.Sdk;namespace Invented{public sealed class Observer:IPlugin{
static string V(object o){if(o==null)return "null";var os=o as OptionSetValue;if(os!=null)return os.Value.ToString();var er=o as EntityReference;if(er!=null)return er.Id.ToString();var e=o as Entity;if(e!=null)return "{"+string.Join(",",e.Attributes.Where(a=>!a.Key.StartsWith("modified")).OrderBy(a=>a.Key,StringComparer.Ordinal).Select(a=>a.Key+"="+V(a.Value)))+"}";if(o is bool)return ((bool)o)?"true":"false";return o.ToString();}
static string I(EntityImageCollection images){return string.Join(",",images.Select(i=>i.Key+"="+i.Value.Id+":"+(i.Value.Contains("name")?i.Value["name"]:"-")));}
static string C(EntityImageCollection[] sets){return string.Join("/",sets.Select(I));}
static string Chain(IPluginExecutionContext c){var parts=new List<string>();for(var p=c.ParentContext;p!=null;p=p.ParentContext)parts.Add(p.MessageName+"/"+p.Stage+"/d"+p.Depth);return string.Join("<",parts);}
public void Execute(IServiceProvider p){var c=(IPluginExecutionContext4)p.GetService(typeof(IPluginExecutionContext));
File.AppendAllText(@"${log.replaceAll('"', '""')}",string.Join("|",c.MessageName,c.Stage,c.Mode,c.Depth,Chain(c),string.Join(",",c.InputParameters.Keys),c.InputParameters.Contains("Target")?V(c.InputParameters["Target"]):"-",c.InputParameters.Contains("UpdateContent")?V(c.InputParameters["UpdateContent"]):"-",I(c.PreEntityImages),I(c.PostEntityImages),C(c.PreEntityImagesCollection),C(c.PostEntityImagesCollection),c.PrimaryEntityName,c.UserId)+Environment.NewLine);}}}`,
    );
    const sdk = clrSdk();
    compileClr(source, path.join(root, 'Observer.dll'), { references: [sdk] });
    return prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: 'Observer.dll',
      typeName: 'Invented.Observer',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
      serviceProfile: { userId: caller, evidence: 'Invented Merge observer', grants: [] },
      context: { initiatingUserId: caller, organizationId: caller, businessUnitId: caller },
    });
  })();
  return prepared;
}

const step = (n, message, stage, { entity = 'account', mode = 0, images = [], rank = 1 } = {}) => ({
  id: uuid(3, n),
  name: `Invented observer ${n}`,
  enabled: true,
  entity,
  message,
  stage,
  rank,
  mode,
  supportedDeployment: 0,
  assemblyId: 'invented',
  typeName: 'Invented.Observer',
  filteringAttributes: [],
  images,
});

// A Web API organization over two invented accounts with every registration bound to the observer.
async function mergeFixture(t, steps, { fields = {} } = {}) {
  const f = await contractModuleFixture(t, {
    mappings: {
      account: {
        logicalName: 'account',
        entitySet: 'accounts',
        idColumn: 'accountid',
        nameColumn: 'name',
        ownership: 'UserOwned',
        fields: {
          name: { dataverseType: 'nvarchar' },
          telephone1: { dataverseType: 'nvarchar' },
          statecode: { dataverseType: 'state' },
          statuscode: { dataverseType: 'status' },
          ...fields,
        },
      },
    },
    tables: {
      account: [
        { accountid: target, name: 'Invented target', statecode: 0, statuscode: 1 },
        { accountid: subordinate, name: 'Invented subordinate', statecode: 0, statuscode: 1 },
      ],
    },
    extension: { name: 'merge-probe', install: () => {} },
  });
  const runtime = await observer();
  await fs.writeFile(log, '');
  const scheduler = createScheduler({ clock: f.store.clock, manual: true }),
    runtimes = new Map(steps.map((entry) => [entry.id, runtime])),
    descriptors = new Map(steps.map((entry) => [entry.id, runtime.descriptor])),
    items = pluginCatalogue({
      plugins: { steps },
      runtimes,
      descriptors,
      overrides: Object.fromEntries(steps.map((entry) => ['plugin-step:' + entry.id, { mode: 'clr' }])),
    });
  const backend = await createOrganizationBackend({
    store: f.store,
    items: () => items,
    runtimes,
    descriptors,
    scheduler,
  });
  t.after(() => backend.close());
  const merge = async (body = {}, { tag } = {}) => {
    const answer = await f.request('POST', '/Merge' + (tag === undefined ? '' : `?tag=${encodeURIComponent(tag)}`), {
      Target: { '@odata.type': 'Microsoft.Dynamics.CRM.account', accountid: target },
      Subordinate: { '@odata.type': 'Microsoft.Dynamics.CRM.account', accountid: subordinate },
      UpdateContent: { '@odata.type': 'Microsoft.Dynamics.CRM.account' },
      PerformParentingChecks: false,
      ...body,
    });
    assert.equal(answer.status, 204, await answer.text());
    await scheduler.runDue();
    await backend.asyncPluginRunner.drain();
    return (await fs.readFile(log, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [message, stage, mode, depth, chain, inputs, targetValue, updateContent, pre, post, preC, postC, entity] =
          line.split('|');
        return {
          message,
          stage: Number(stage),
          mode: Number(mode),
          depth: Number(depth),
          chain,
          inputs,
          target: targetValue,
          updateContent,
          pre,
          post,
          preC,
          postC,
          entity,
        };
      });
  };
  return { ...f, merge };
}

const images = [
  { alias: 'target', type: 0, messagePropertyName: 'Target', attributes: [] },
  { alias: 'sub', type: 0, messagePropertyName: 'SubordinateId', attributes: [] },
];
const imageOf = (id, name) => `${id}:${name}`;
// Image enumeration order is not compared (native: [sub, target] at stage 20, [target, sub] at 40).
const sorted = (entries) => entries.split(',').sort().join(',');

test(
  'Merge images registered on SubordinateId hold the subordinate row before the merge',
  { skip: CLR_SKIP },
  async (t) => {
    const f = await mergeFixture(t, [
      step(1, 'Merge', 20, { images }),
      step(2, 'Merge', 40, { images }),
      step(3, 'Merge', 40, { mode: 1 }),
    ]);
    const seen = await f.merge();
    const at = (stage, mode = 0) =>
      seen.find((entry) => entry.message === 'Merge' && entry.stage === stage && entry.mode === mode);
    const expected = sorted(
      `target=${imageOf(target, 'Invented target')},sub=${imageOf(subordinate, 'Invented subordinate')}`,
    );
    // native mergeAccount 'Probe: Merge account 20 images' / '40 images': sub is the subordinate row (its id and
    // name), target the Target row, both as they were before the merge; the same entries fill PreEntityImagesCollection.
    for (const stage of [20, 40]) {
      assert.equal(sorted(at(stage).pre), expected, `Merge/${stage} PreEntityImages`);
      assert.equal(sorted(at(stage).preC), expected, `Merge/${stage} PreEntityImagesCollection`);
    }
    // native mergeAccount: the queued Merge job's preC holds the same sub and target entries.
    assert.equal(sorted(at(40, 1).preC), expected);
  },
);

// @test-kind parity: native recorder captures 2026-10-30 mergeAccount (native and native-r2): the subordinate is written by two Updates under Merge/30 at the Merge's depth, {statecode 1, statuscode 2} then {masterid = target, merged true}, the target is not written for a type-only UpdateContent, and the subordinate reads back 200 merged, inactive, with the target as master
test(
  'Merge deactivates the subordinate, then marks it merged into the target, and the subordinate reads back',
  { skip: CLR_SKIP },
  async (t) => {
    const f = await mergeFixture(
      t,
      [
        step(1, 'Update', 20),
        step(2, 'Update', 40),
        step(3, 'Retrieve', 20),
        step(4, 'Retrieve', 40),
        step(5, 'Merge', 20),
      ],
      // A standard table's thin stand-in column (no targets, no relationship): masterid's target comes from metadata.
      { fields: { masterid: { dataverseType: 'lookup' }, merged: { dataverseType: 'bit' } } },
    );
    const seen = await f.merge();
    const updates = seen.filter((entry) => entry.message === 'Update');
    // native mergeAccount events 21-24 and 31-34: Update/20 and /40 < Merge/30/d1, each Target the subordinate.
    assert.deepEqual(
      updates.map((entry) => `${entry.stage}/d${entry.depth}<${entry.chain}`),
      ['20/d1<Merge/30/d1', '40/d1<Merge/30/d1', '20/d1<Merge/30/d1', '40/d1<Merge/30/d1'],
    );
    const deactivated = `{accountid=${subordinate},statecode=1,statuscode=2}`,
      marked = `{accountid=${subordinate},masterid=${target},merged=true}`;
    assert.deepEqual(
      updates.map((entry) => entry.target),
      [deactivated, deactivated, marked, marked],
    );
    const read = await f.request(
      'GET',
      `/accounts(${subordinate})?$select=name,statecode,statuscode,_masterid_value,merged`,
    );
    assert.equal(read.status, 200, await read.clone().text());
    const row = await read.json();
    assert.deepEqual([row.merged, row.statecode, row.statuscode, row._masterid_value], [true, 1, 2, target]);
  },
);

// @test-kind parity: native recorder captures 2026-10-30 mergeAccount (native and native-r2): a Web API Merge with a type-only UpdateContent passes UpdateContent null, with the inputs in the native order Target, SubordinateId, PerformParentingChecks, tag, UpdateContent at stages 10, 20, 40 and in the asynchronous job
test(
  'Merge passes a null UpdateContent for a type-only request, with the inputs in the native order',
  { skip: CLR_SKIP },
  async (t) => {
    const f = await mergeFixture(t, [
      step(1, 'Merge', 10),
      step(2, 'Merge', 20),
      step(3, 'Merge', 40),
      step(4, 'Merge', 40, { mode: 1 }),
    ]);
    const seen = (await f.merge({}, { tag: 'invented-tag' })).filter((entry) => entry.message === 'Merge');
    // native mergeAccount: Merge/10, /20, /40 and the async /40 job each see the same input order, UpdateContent null.
    assert.equal(seen.length, 4);
    for (const entry of seen) {
      assert.equal(entry.inputs, 'Target,SubordinateId,PerformParentingChecks,tag,UpdateContent');
      assert.equal(entry.updateContent, 'null');
    }
  },
);
