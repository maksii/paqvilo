import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore } from '../lib/data.mjs';
import { CRM_FUNCTIONS } from '../lib/dataverse-conditions.mjs';
import { odataToSdkQuery, sameSdkQuery } from '../lib/plugin-query.mjs';
import { queryExpressionToFetch } from '../lib/plugin-sdk-query.mjs';
import { prepareClrRuntime, closeClrHostPool } from '../lib/plugin-clr.mjs';
import { attachClrSteps } from './fixtures/plugin-pipeline.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { ORDINARY_CLR_TIMEOUT_MS } from './fixtures/clr-budget.mjs';

const id = (number) => `20000000-0000-0000-0000-${String(number).padStart(12, '0')}`;
const identity = {
  contactId: id(20),
  roles: ['Reader'],
  systemUserId: id(30),
  dataverse: {
    userId: id(30),
    businessUnitId: id(40),
    teamIds: [id(31)],
    userHierarchy: () => new Set([id(32)]),
    hierarchy: (_table, _attribute, _record, mode) => new Set(mode === 'under' ? [id(2)] : [id(1), id(2)]),
  },
};
function fixture() {
  return new DataStore({
    clock: { now: () => Date.parse('2026-10-29T12:00:00Z') },
    state: {
      mappings: {
        widget: {
          entitySet: 'widgets',
          idColumn: 'widgetid',
          fields: {
            title: { type: 'string' },
            count: { type: 'integer' },
            choices: { type: 'multiselectpicklist' },
            stamp: { type: 'datetime' },
            ownerid: { type: 'uniqueidentifier' },
            bu: { type: 'uniqueidentifier' },
            language: { type: 'integer' },
            contactid: { type: 'uniqueidentifier' },
          },
        },
      },
      tables: {
        widget: [
          {
            widgetid: id(1),
            title: 'Low',
            count: 1,
            choices: [1],
            stamp: '2026-10-28T12:00:00Z',
            ownerid: id(30),
            bu: id(40),
            language: 1033,
            contactid: id(20),
          },
          {
            widgetid: id(2),
            title: 'Middle',
            count: 5,
            choices: [2],
            stamp: '2026-10-29T12:00:00Z',
            ownerid: id(31),
            bu: id(41),
            language: 1031,
            contactid: id(20),
          },
          {
            widgetid: id(3),
            title: 'High',
            count: 10,
            choices: [],
            stamp: '2026-10-30T12:00:00Z',
            ownerid: id(32),
            bu: id(40),
            language: 1033,
            contactid: id(20),
          },
          {
            widgetid: id(4),
            title: 'Null',
            count: null,
            choices: null,
            stamp: null,
            ownerid: null,
            bu: null,
            language: null,
            contactid: id(20),
          },
          {
            widgetid: id(5),
            title: 'Denied',
            count: 1,
            choices: [1],
            stamp: '2025-01-01T00:00:00Z',
            ownerid: id(30),
            bu: id(40),
            language: 1033,
            contactid: id(21),
          },
        ],
      },
      permissions: [
        { entity: 'widget', scope: 'contact', field: 'contactid', roles: ['Reader'], operations: ['read'] },
      ],
      plugins: [],
      settings: { permissionMode: 'enforce' },
    },
  });
}
function condition(name, spec) {
  let property = 'stamp',
    values = ['1'];
  if (['In', 'NotIn', 'Between', 'NotBetween'].includes(name)) {
    property = 'count';
    values = name.includes('Between') ? ['2', '8'] : ['1', '5'];
  } else if (name.includes('ContainValues')) {
    property = 'choices';
    values = ['1'];
  } else if (name.includes('BusinessId')) property = 'bu';
  else if (name.includes('UserLanguage')) property = 'language';
  else if (name.startsWith('EqualUser') || name === 'NotEqualUserId') property = 'ownerid';
  else if (['Above', 'AboveOrEqual', 'Under', 'UnderOrEqual', 'NotUnder'].includes(name)) {
    property = 'widgetid';
    values = [id(1)];
  } else if (['On', 'OnOrAfter', 'OnOrBefore'].includes(name)) values = ['2026-10-29'];
  else if (name === 'InFiscalYear') values = ['2026'];
  else if (spec.values === 'pair') values = ['1', '2026'];
  const parameters = [`PropertyName='${property}'`];
  if (spec.values === 'list') parameters.push(`PropertyValues=[${values.map((item) => `'${item}'`).join(',')}]`);
  else if (spec.values === 'one') parameters.push(`PropertyValue='${values[0]}'`);
  else if (spec.values === 'pair') parameters.push(`PropertyValue1='${values[0]}',PropertyValue2='${values[1]}'`);
  return `Microsoft.Dynamics.CRM.${name}(${parameters.join(',')})`;
}
const params = (filter) => ({ $filter: filter, $select: 'title,count', $count: 'true', $orderby: 'title', $top: '10' });
const attempt = (store, query) => {
  try {
    return store.query('widgets', query, identity);
  } catch (error) {
    return { error: { code: error.code, status: error.status, message: error.message } };
  }
};

test('no-op read observers preserve negation across every admitted CRM function including null values and source permissions', () => {
  const store = fixture();
  const queries = Object.entries(CRM_FUNCTIONS).map(([name, spec]) => params(`not ${condition(name, spec)}`));
  queries.push(
    params(`not (Microsoft.Dynamics.CRM.Between(PropertyName='count',PropertyValues=['2','8']) or title eq 'Low')`),
  );
  const expected = queries.map((query) => attempt(store, query));
  assert.deepEqual(
    expected[Object.keys(CRM_FUNCTIONS).indexOf('Between')].value.map((row) => row.title),
    ['High', 'Low'],
  );
  store.setPluginPipeline(
    () => {},
    (context) => context.operation === 'retrievemultiple',
  );
  assert.deepEqual(
    queries.map((query) => attempt(store, query)),
    expected,
  );
  // Executing the represented QueryExpression must also preserve null truth,
  // not just taking the unchanged-original-query shortcut.
  for (const name of ['Between', 'NotBetween', 'ContainValues', 'DoesNotContainValues', 'Today', 'EqualUserTeams']) {
    const query = params(`not ${condition(name, CRM_FUNCTIONS[name])}`),
      baseline = expected[Object.keys(CRM_FUNCTIONS).indexOf(name)];
    const sdk = odataToSdkQuery('widget', query, store);
    const result = store.fetchXml(queryExpressionToFetch(sdk, store), identity, { skipPluginRead: true });
    assert.deepEqual(
      result.entities.map((row) => row.title),
      baseline.value.map((row) => row.title),
      name,
    );
  }
});

test('optional ColumnSet wire discriminators do not turn a CLR no-op into an execution query rewrite', () => {
  const original = odataToSdkQuery(
    'widget',
    params("not Microsoft.Dynamics.CRM.Between(PropertyName='count',PropertyValues=['2','8'])"),
    fixture(),
  );
  const roundtrip = structuredClone(original);
  roundtrip.columnSet.$type = 'ColumnSet';
  assert.equal(sameSdkQuery(original, roundtrip), true);
  roundtrip.$type = 'QueryByAttribute';
  assert.equal(sameSdkQuery(original, roundtrip), false);
});

test(
  'an original CLR no-op preserves negated CRM filters, transport counts and scoped rows',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paq-crm-negation-'));
    let runtime, backend;
    t.after(async () => {
      await backend?.close();
      if (runtime) closeClrHostPool({ runtime });
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
    });
    const sdk = clrSdk(),
      source = path.join(root, 'NoOp.cs'),
      assembly = path.join(root, 'NoOp.dll');
    await fs.writeFile(
      source,
      'using System;using Microsoft.Xrm.Sdk;using Microsoft.Xrm.Sdk.Query;namespace Invented { public sealed class NoOp:IPlugin { public void Execute(IServiceProvider p) { var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext)); if(!(c.InputParameters["Query"] is QueryExpression))throw new Exception("Query type lost"); } } }',
    );
    compileClr(source, assembly, { references: [sdk] });
    runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: 'NoOp.dll',
      typeName: 'Invented.NoOp',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
      persistentHost: true,
      context: { initiatingUserId: id(30), organizationId: id(30), businessUnitId: id(40) },
      serviceProfile: {
        userId: id(30),
        evidence: 'Invented source-bound negation observer',
        grants: [{ entity: 'widget', operations: ['read'] }],
      },
    });
    const store = fixture(),
      queries = [
        'Between',
        'NotBetween',
        'In',
        'NotIn',
        'ContainValues',
        'DoesNotContainValues',
        'EqualUserId',
        'NotEqualUserId',
        'Today',
        'ThisFiscalYear',
        'EqualUserTeams',
        'Under',
        'NotUnder',
      ].map((name) => params(`not ${condition(name, CRM_FUNCTIONS[name])}`));
    const expected = queries.map((query) => attempt(store, query));
    ({ backend } = await attachClrSteps(t, {
      store,
      runtime,
      steps: [10, 20, 40].map((stage) => ({
        id: id(stage),
        enabled: true,
        entity: 'widget',
        message: 'RetrieveMultiple',
        stage,
        rank: 1,
        mode: 0,
        supportedDeployment: 0,
        filteringAttributes: [],
        images: [],
        typeName: 'Invented.NoOp',
        assemblyId: 'invented',
      })),
    }));
    assert.deepEqual(
      queries.map((query) => attempt(store, query)),
      expected,
    );
    assert.ok(expected.every((answer) => !answer.error));
  },
);
