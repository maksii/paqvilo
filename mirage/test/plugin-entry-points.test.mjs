// @test-kind parity: native dev-environment plug-in recorder corpus 2026-10-30 (customApi scenario: a bound custom API's target load runs no Retrieve pipeline)
// Web API entry points of named messages and bound operations. Invented tables, identities and messages only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';
import { install as installCustomApis } from '../lib/dataverse-customapi.mjs';

const row = '20000000-0000-0000-0000-0000000000c1';
const apiId = '40000000-0000-0000-0000-0000000000c1';
const step = (n, message, stage, extra = {}) => ({
  id: `30000000-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`,
  name: `Invented ${message} ${stage}`,
  enabled: true,
  entity: 'x_item',
  message,
  stage,
  rank: 1,
  mode: 0,
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
  typeName: 'Invented.Recorder',
  assemblyId: 'invented',
  ...extra,
});

async function fixture(t, steps) {
  const f = await contractModuleFixture(t, {
    mappings: {
      x_item: {
        logicalName: 'x_item',
        entitySet: 'x_items',
        idColumn: 'x_itemid',
        fields: { x_name: { dataverseType: 'nvarchar' }, x_code: { dataverseType: 'nvarchar' } },
        alternateKeys: [{ name: 'x_code_key', attributes: ['x_code'] }],
      },
    },
    tables: {
      x_item: [{ x_itemid: row, x_name: 'First', x_code: 'first' }],
      customapi: [
        {
          customapiid: apiId,
          uniquename: 'x_Bound',
          bindingtype: 1,
          boundentitylogicalname: 'x_item',
          isfunction: false,
          allowedcustomprocessingsteptype: 2,
        },
      ],
      customapirequestparameter: [
        { customapirequestparameterid: apiId, customapiid: apiId, uniquename: 'Text', type: 10, isoptional: true },
      ],
      customapiresponseproperty: [],
    },
    extension: {
      name: 'customapi',
      install: (api) =>
        installCustomApis(
          { ...api, change: (fn) => fn() },
          { handlers: new Map([['x_bound', { handler: () => ({}) }]]) },
        ).ready,
    },
  });
  const seen = [];
  const handlers = new Map([
    [
      'Invented.Recorder',
      ({ context }) => {
        seen.push({
          at: `${context.MessageName}/${context.Stage}`,
          inputs: structuredClone(context.InputParameters),
        });
      },
    ],
  ]);
  const items = pluginCatalogue({ plugins: { steps }, handlers });
  const backend = await createOrganizationBackend({ store: f.store, items: () => items, handlers });
  t.after(() => backend.close());
  return { ...f, seen, backend };
}

test('a bound custom API loads its target without running the Retrieve pipeline', async (t) => {
  const customApi = { name: 'x_Bound', bindingType: 1, allowedCustomProcessingStepType: 2 };
  const f = await fixture(t, [
    step(1, 'Retrieve', 10),
    step(2, 'Retrieve', 20),
    step(3, 'Retrieve', 40),
    step(4, 'x_Bound', 20, { customApi }),
  ]);
  const answer = await f.request('POST', `/x_items(${row})/Microsoft.Dynamics.CRM.x_Bound`, { Text: 'hello' });
  assert(answer.status < 300, await answer.text());
  assert.deepEqual(
    f.seen.map((entry) => entry.at),
    ['x_Bound/20'],
  );
});
