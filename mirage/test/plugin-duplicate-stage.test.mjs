import test from 'node:test';
import assert from 'node:assert/strict';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { install } from '../lib/dataverse-duplicates.mjs';
import { pluginCatalogue, runPluginPhase } from '../lib/exported-plugins.mjs';
import { handleSoap } from '../lib/dataverse-soap.mjs';
import { envelope, encodeValue } from '../lib/dataverse-soap-xml.mjs';

const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scenarios = [
  { name: 'baseline', input: 'Duplicate', status: 412 },
  { name: 'mutated10', input: 'Unique', stage: 10, value: 'Duplicate', status: 412 },
  { name: 'mutated20', input: 'Unique', stage: 20, value: 'Duplicate', status: 200 },
  { name: 'cleared10', input: 'Duplicate', stage: 10, value: null, status: 200 },
  { name: 'cleared20', input: 'Duplicate', stage: 20, value: null, status: 412 },
  { name: 'reject10', input: 'Duplicate', stage: 10, reject: true, status: 400 },
  { name: 'reject20', input: 'Duplicate', stage: 20, reject: true, status: 412 },
];
const errorCode = (xml) => Number(/<(?:\w+:)?ErrorCode>(-?\d+)</.exec(xml)?.[1]);

for (const transport of ['HTTP', 'SOAP'])
  test(`${transport} duplicate detection checks post-PreValidation Target before PreOperation for Create and Update`, async (t) => {
    const f = await contractModuleFixture(t, {
      mappings: {
        widget: {
          logicalName: 'widget',
          entitySet: 'widgets',
          idColumn: 'widgetid',
          fields: { name: { dataverseType: 'nvarchar' } },
        },
      },
      tables: { widget: [] },
      extension: { name: 'dataverse-duplicates', install },
    });
    f.store.state.tables.duplicaterule.push({
      duplicateruleid: id(91),
      baseentityname: 'widget',
      matchingentityname: 'widget',
      statuscode: 2,
      statecode: 1,
    });
    f.store.state.tables.duplicaterulecondition.push({
      duplicateruleconditionid: id(92),
      regardingobjectid: id(91),
      baseattributename: 'name',
      matchingattributename: 'name',
      operatorcode: 'ExactMatch',
      ignoreblankvalues: true,
    });
    const user = f.store
      .tableRows('systemuser')
      .find((row) => f.api.principals.roles(row).some((role) => role.name === 'System Administrator'));
    for (const operation of ['Create', 'Update'])
      for (const scenario of scenarios) {
        f.store.state.tables.widget = [
          { widgetid: id(1), name: 'Duplicate' },
          { widgetid: id(2), name: 'Before' },
        ];
        const seen = [],
          steps = [10, 20].map((stage) => ({
            id: id(stage),
            name: 'Invented duplicate stage',
            enabled: true,
            entity: 'widget',
            message: operation,
            stage,
            rank: 1,
            mode: 0,
            supportedDeployment: 0,
            typeName: 'Invented.DuplicateStage',
            assemblyId: 'invented',
            images: [],
            filteringAttributes: [],
          }));
        const handlers = new Map(
          steps.map((step) => [
            step.id,
            ({ stage, reject }) => {
              seen.push(stage);
              if (scenario.stage !== stage) return;
              if (scenario.reject) reject('Invented stage10 rejection');
              return { target: { name: scenario.value } };
            },
          ]),
        );
        const items = pluginCatalogue({ plugins: { steps }, handlers });
        f.store.setPluginPipeline((context) => runPluginPhase({ ...context, store: f.store, items, handlers }));
        let status, body;
        if (transport === 'HTTP') {
          const response = await f.request(
            operation === 'Create' ? 'POST' : 'PATCH',
            operation === 'Create' ? '/widgets' : `/widgets(${id(2)})`,
            { name: scenario.input },
            { 'MSCRM.SuppressDuplicateDetection': 'false', ...(operation === 'Update' ? { 'if-match': '*' } : {}) },
          );
          status = response.status;
          body = await response.text();
        } else {
          const value = {
            type: 'Entity',
            logicalName: 'widget',
            id: operation === 'Create' ? '00000000-0000-0000-0000-000000000000' : id(2),
            attributes: new Map([['name', { type: 'string', value: scenario.input }]]),
          };
          const parameters = [
            ['Target', value],
            ['SuppressDuplicateDetection', { type: 'boolean', value: false }],
          ]
            .map(
              ([key, item]) =>
                `<a:KeyValuePairOfstringanyType><b:key>${key}</b:key>${encodeValue('b:value', item)}</a:KeyValuePairOfstringanyType>`,
            )
            .join('');
          const response = await handleSoap(
            {
              method: 'POST',
              headers: {},
              bodyText: envelope(
                `<svc:Execute><svc:request i:type="a:OrganizationRequest"><a:Parameters>${parameters}</a:Parameters><a:RequestName>${operation}</a:RequestName></svc:request></svc:Execute>`,
              ),
              origin: f.server.origin,
              user,
              caller: user,
              identity: { admin: true, id: user.systemuserid },
            },
            f.api,
          );
          status = response.status;
          body = response.body;
        }
        const label = `${operation} ${scenario.name}`;
        const expected =
          transport === 'SOAP'
            ? scenario.status >= 400
              ? 500
              : 200
            : scenario.status === 200 && operation === 'Create'
              ? 201
              : scenario.status;
        assert.equal(status, expected, label + ': ' + body);
        if (scenario.status === 412) {
          assert.deepEqual(seen, [10], label + ': duplicate validation must stop before stage20');
          if (transport === 'SOAP') assert.equal(errorCode(body), Number.parseInt('80040333', 16) | 0);
          else assert.equal(JSON.parse(body).error.code, '0x80040333');
        } else if (scenario.status === 400) {
          assert.deepEqual(seen, [10]);
          assert.match(body, /Invented stage10 rejection/);
        } else {
          assert.deepEqual(seen, [10, 20]);
          const stored =
            operation === 'Create'
              ? f.store.tableRows('widget').at(-1)
              : f.store.tableRows('widget').find((row) => row.widgetid === id(2));
          assert.equal(stored.name, scenario.value, label);
        }
        if (scenario.status >= 400) {
          assert.equal(f.store.tableRows('widget').length, 2, label);
          assert.equal(f.store.tableRows('widget')[1].name, 'Before', label);
        }
      }
  });
