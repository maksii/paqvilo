// @test-kind parity: native dataverse-recorder crud corpus 'Update 40 impersonated': UserId is the impersonated user, InitiatingUserId the caller
// Native corpus (dataverse-recorder crud, 'Probe: Update 40 impersonated'): a step registered with an impersonating
// user runs with UserId = that user while InitiatingUserId stays the caller. A trusted CLR runtime executes it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';
import { clrContext } from '../lib/plugin-clr.mjs';
import { DataStore } from '../lib/data.mjs';

const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const caller = id(97),
  impersonated = id(96);
const step = {
  id: id(95),
  enabled: true,
  entity: 'x_item',
  message: 'Update',
  stage: 40,
  rank: 1,
  mode: 0,
  supportedDeployment: 0,
  typeName: 'Invented.Impersonated',
  assemblyId: 'invented',
  filteringAttributes: [],
  images: [],
  impersonatingUserId: impersonated,
};
const runtime = {
  descriptor: {
    typeName: step.typeName,
    serviceProfile: { userId: caller, evidence: 'Invented caller', grants: [] },
    context: { executionUserId: caller, initiatingUserId: caller, organizationId: caller, businessUnitId: caller },
  },
};

test('an impersonated step runs under a CLR runtime as the impersonated user', () => {
  // @parity-evidence: native registration probes (dev environment, plugin-registration-parity.test.mjs) admit an impersonating step and the crud corpus runs it as the impersonated user; native has no identity-adapter refusal, and every local handler sets UserId, so the merged registration admission (parity/reg) supersedes the earlier no-runtime refusal
  assert.equal(pluginCatalogue({ plugins: { steps: [step] } })[0].unsupported, null);
  const [item] = pluginCatalogue({ plugins: { steps: [step] }, runtimes: new Map([[step.id, runtime]]) });
  assert.equal(item.unsupported, null);
  const store = new DataStore({
    state: { mappings: { x_item: { idColumn: 'x_itemid', entitySet: 'x_items' } }, tables: { x_item: [] } },
  });
  const { context } = clrContext({
    runtime,
    store,
    step: item,
    entity: 'x_item',
    operation: 'update',
    stage: 40,
    target: {},
    record: { x_itemid: id(1) },
    previous: null,
    frame: {},
    depth: 1,
  });
  assert.equal(context.UserId.value, impersonated);
  assert.equal(context.InitiatingUserId.value, caller);
});
