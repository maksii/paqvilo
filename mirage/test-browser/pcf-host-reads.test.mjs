// @test-kind observation: webAPI read results and headers and the list data set's aggregation, grouping and party list values of the Power Pages code component hosts, live captures paqvilo-developer pcf-parity summary-F sections 1, 4 and 7 (runs fa and fb, wa-field-ny and wa-dataset-ny, activity-list-ny; runs fc and fd for the aggregation and grouping members; paqvilo3 2026-11-26), replayed on invented loopback pages
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { sharedBrowser, loopbackServer } from './shared-browser.mjs';

const ROW = 'd0000000-0000-4000-8000-000000000001';

const browser = sharedBrowser({ headless: true });

// A loopback page with the host runtime, an invented Web API row and an invented grid service answer.
async function hostPage(t) {
  const host = await fs.readFile(new URL('../lib/code-components-client.js', import.meta.url), 'utf8');
  const requests = [];
  const { origin } = await loopbackServer(t, (request, response) => {
    if (request.url === '/host.js') {
      response.setHeader('Content-Type', 'text/javascript');
      return response.end(host);
    }
    if (request.url.startsWith('/_api/') || request.url === '/grid') {
      requests.push({ method: request.method, url: request.url, headers: request.headers });
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/grid')
        return response.end(
          JSON.stringify({
            MoreRecords: false,
            ItemCount: 1,
            Records: [
              {
                Id: ROW,
                EntityName: 'tst_task',
                Attributes: [
                  { Name: 'tst_subject', Type: 'System.String', Value: 'Invented task', FormattedValue: '' },
                  {
                    Name: 'tst_to',
                    Type: 'Microsoft.Xrm.Sdk.EntityCollection',
                    Value: { Entities: [{ Id: ROW }], MoreRecords: false, EntityName: 'activityparty' },
                    FormattedValue: '',
                    DisplayValue: { Entities: [], EntityName: 'activityparty' },
                  },
                ],
              },
            ],
          }),
        );
      return response.end(JSON.stringify({ '@odata.etag': 'W/"1"', tst_rowid: ROW, tst_title: 'Invented row' }));
    }
    response.setHeader('Content-Type', 'text/html');
    response.end('<html><body><script src="/host.js"></script></body></html>');
  });
  const page = await browser.page(t),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin);
  await page.evaluate(() => {
    window.shell = {
      getTokenDeferred: () => ({
        done(callback) {
          callback('fixture-token');
          return this;
        },
        fail() {
          return this;
        },
      }),
    };
    window.contexts = {};
    window.ComponentFramework.registerControl(
      'Synthetic.Reader',
      class {
        init(context, notify, state, container) {
          window.contexts[container.dataset.key] = context;
        }
        updateView(context) {
          window.contexts.updated = [...context.updatedProperties];
        }
        destroy() {}
      },
    );
    window.mountReader = async (key, spec) => {
      const target = document.createElement('div');
      target.dataset.key = key;
      document.body.append(target);
      await window.__paqviloPcf.mount(
        {
          id: key,
          constructor: 'Synthetic.Reader',
          resources: [],
          strings: {},
          args: {},
          identity: { id: null, roles: [] },
          mappings: { tst_row: { entitySet: 'tst_rows', idColumn: 'tst_rowid' } },
          properties: [],
          ...spec,
        },
        target,
      );
    };
  });
  return { page, errors, requests };
}

test('retrieveRecord resolves { data, entityType, values: undefined } and a read sends accept */* with the token', async (t) => {
  const { page, errors, requests } = await hostPage(t);
  const result = await page.evaluate(async (row) => {
    await window.mountReader('reader', { host: 'liquid' });
    const value = await window.contexts.reader.webAPI.retrieveRecord('tst_row', row, '?$select=tst_title');
    return { keys: Object.keys(value), data: value.data, entityType: value.entityType, values: 'values' in value };
  }, ROW);
  assert.deepEqual(result, {
    keys: ['data', 'entityType', 'values'],
    data: { '@odata.etag': 'W/"1"', tst_rowid: ROW, tst_title: 'Invented row' },
    entityType: 'tst_row',
    values: true,
  });
  assert.equal(await page.evaluate(() => window.contexts.reader.webAPI.retrieveRecord('tst_row', 'x')), undefined);
  const [read] = requests;
  assert.equal(requests.length, 1);
  assert.deepEqual(
    [read.method, read.headers.accept, read.headers['content-type'], read.headers.__requestverificationtoken],
    ['GET', '*/*', 'application/json', 'fixture-token'],
  );
  assert.equal(read.headers['pcf-entity-logical-name'], 'tst_row');
  assert.equal(read.headers.prefer, undefined);
  assert.deepEqual(errors, []);
});

test('a list data set has aggregation and grouping answering [], and a party list column reads null and ""', async (t) => {
  const { page, errors } = await hostPage(t);
  const result = await page.evaluate(async (row) => {
    await window.mountReader('list', {
      host: 'list',
      datasets: [
        {
          name: 'records',
          transport: 'grid',
          kind: 'list',
          service: '/grid',
          secure: 'invented',
          entity: 'tst_task',
          entitySet: 'tst_tasks',
          idColumn: 'tst_taskid',
          nameColumn: 'tst_subject',
          viewId: 'd0000000-0000-4000-8000-000000000009',
          viewName: 'Tasks',
          columns: [
            {
              name: 'tst_subject',
              displayName: 'Subject',
              dataType: 'SingleLine.Text',
              alias: 'tst_subject',
              order: 1,
            },
            { name: 'tst_to', displayName: 'To', dataType: 'partylist', alias: 'tst_to', order: 2 },
          ],
          sorting: [],
          links: [],
          tables: {},
          fields: {},
        },
      ],
    });
    const dataset = window.contexts.list.parameters.records;
    const record = dataset.records[row];
    // The capture shows these members exist (summary-F section 4, runs fc and fd); their arity is not captured.
    const members = (object) => Object.fromEntries(Object.entries(object).map(([name, value]) => [name, typeof value]));
    return {
      updated: window.contexts.updated,
      aggregation: members(dataset.aggregation),
      grouping: members(dataset.grouping),
      aggregations: dataset.aggregation.getAggregations(),
      groupBys: dataset.grouping.getGroupBys(),
      party: [record.getValue('tst_to'), record.getFormattedValue('tst_to')],
      subject: record.getValue('tst_subject'),
    };
  }, ROW);
  assert.deepEqual(result, {
    updated: ['dataset', 'Items', 'records'],
    aggregation: {
      getAggregations: 'function',
      addAggregation: 'function',
      removeAggregation: 'function',
      clear: 'function',
    },
    grouping: {
      getGroupBys: 'function',
      addGroupBy: 'function',
      removeGroupBy: 'function',
      clear: 'function',
    },
    aggregations: [],
    groupBys: [],
    party: [null, ''],
    subject: 'Invented task',
  });
  assert.deepEqual(errors, []);
});
