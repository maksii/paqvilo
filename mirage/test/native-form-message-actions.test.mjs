// @test-kind unproven: local model of the Basic Form Dynamics 365 actions (Learn power-pages/configure/basic-forms lists them; the message order, the Update and Create checks and the application-user execution follow the open-source legacy EntityActionController); no hosted capture of these actions
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { signInHeaders } from '../testing.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';
import { sourceFixture } from './fixtures/source-site.mjs';

const id = (n) => `54300000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SITE = id(1),
  CONTACT = id(2),
  DEAL_FORM = id(3),
  QUOTE_FORM = id(4),
  ORDER_FORM = id(5),
  DEAL = id(10),
  WON_DEAL = id(11),
  QUOTE = id(12),
  ORDER = id(13);
const lookup = (target) => ({ dataverseType: 'lookup', targets: [target] });
const money = { dataverseType: 'money' };
const states = (pairs) => ({
  dataverseType: 'state',
  states: pairs.map(([value, defaultStatus]) => ({ value, defaultStatus })),
});
const statuses = (pairs) => ({ dataverseType: 'status', statuses: pairs.map(([value, state]) => ({ value, state })) });
const table = (entitySet, idColumn, fields) => ({
  entitySet,
  idColumn,
  nameColumn: 'name',
  fields: { name: { dataverseType: 'nvarchar' }, ...fields },
});

async function fixture(t, { forms = {}, permissions } = {}) {
  const form = (formId, name, entity, actions) =>
    [
      `adx_entityformid: ${formId}`,
      `adx_name: ${name}`,
      `adx_entityname: ${entity}`,
      'adx_mode: 100000001',
      'adx_entitysourcetype: 756150001',
      'adx_recordidquerystringparametername: row',
      'adx_settings: |-',
      `  ${JSON.stringify({ Actions: actions })}`,
    ].join('\n');
  const { root } = await sourceFixture(t, {
    prefix: 'form-message-actions-',
    files: {
      'portal/website.yml': `adx_websiteid: ${SITE}\nadx_name: Invented sales`,
      'portal/Home.webpage.yml':
        'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: template',
      'portal/Main.pagetemplate.yml': 'adx_pagetemplateid: template\nadx_webtemplateid: main',
      'portal/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
      'portal/Main.webtemplate.source.html': '{% entityform name: request.params.form %}',
      'portal/Deal.basicform.yml': form(DEAL_FORM, 'Deal', 'opportunity', forms.deal ?? []),
      'portal/Quote.basicform.yml': form(QUOTE_FORM, 'Quote', 'quote', forms.quote ?? []),
      'portal/Order.basicform.yml': form(ORDER_FORM, 'Order', 'salesorder', forms.order ?? []),
    },
  });
  const app = await createSimulator({
    sourceDir: path.join(root, 'portal'),
    projectRoot: root,
    watch: false,
    port: 0,
    dataverse: { enabled: true, tls: false, tds: { enabled: false } },
    initial: {
      version: 1,
      mappings: {
        contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' },
        opportunity: table('opportunities', 'opportunityid', {
          estimatedvalue: money,
          actualvalue: money,
          statecode: states([
            [0, 1],
            [1, 3],
            [2, 4],
          ]),
          statuscode: statuses([
            [1, 0],
            [3, 1],
            [4, 2],
          ]),
        }),
        opportunityproduct: table('opportunityproducts', 'opportunityproductid', {
          opportunityid: lookup('opportunity'),
          extendedamount: money,
        }),
        quote: table('quotes', 'quoteid', {
          opportunityid: lookup('opportunity'),
          totalamount: money,
          statecode: states([
            [0, 1],
            [1, 2],
            [2, 4],
          ]),
          statuscode: statuses([
            [1, 0],
            [2, 1],
            [4, 2],
          ]),
        }),
        quotedetail: table('quotedetails', 'quotedetailid', { quoteid: lookup('quote'), extendedamount: money }),
        quoteclose: {
          entitySet: 'quotecloses',
          idColumn: 'activityid',
          nameColumn: 'subject',
          fields: { subject: { dataverseType: 'nvarchar' }, quoteid: lookup('quote') },
        },
        salesorder: table('salesorders', 'salesorderid', { quoteid: lookup('quote'), totalamount: money }),
        salesorderdetail: table('salesorderdetails', 'salesorderdetailid', {
          salesorderid: lookup('salesorder'),
          extendedamount: money,
        }),
        invoice: table('invoices', 'invoiceid', { salesorderid: lookup('salesorder'), totalamount: money }),
        invoicedetail: table('invoicedetails', 'invoicedetailid', {
          invoiceid: lookup('invoice'),
          extendedamount: money,
        }),
      },
      permissions: permissions ?? [
        ...['opportunity', 'quote', 'salesorder'].map((entity) => ({
          id: `edit-${entity}`,
          entity,
          scope: 'global',
          roles: ['Seller'],
          operations: ['read', 'update', 'create'],
        })),
        { id: 'create-invoice', entity: 'invoice', scope: 'global', roles: ['Seller'], operations: ['create'] },
        ...['opportunity', 'quote'].map((entity) => ({
          id: `read-${entity}`,
          entity,
          scope: 'global',
          roles: ['Viewer'],
          operations: ['read', 'update'],
        })),
      ],
      tables: {
        contact: [{ contactid: CONTACT, fullname: 'Invented seller' }],
        opportunity: [
          { opportunityid: DEAL, name: 'Invented deal', estimatedvalue: 80, statecode: 0, statuscode: 1 },
          { opportunityid: WON_DEAL, name: 'Invented won deal', estimatedvalue: 80, statecode: 1, statuscode: 3 },
        ],
        opportunityproduct: [
          { opportunityproductid: id(20), name: 'Product', opportunityid: DEAL, extendedamount: 30 },
          { opportunityproductid: id(21), name: 'Won product', opportunityid: WON_DEAL, extendedamount: 25 },
        ],
        quote: [{ quoteid: QUOTE, name: 'Invented quote', totalamount: 12, statecode: 0, statuscode: 1 }],
        quotedetail: [{ quotedetailid: id(22), name: 'Quote line', quoteid: QUOTE, extendedamount: 12 }],
        quoteclose: [],
        salesorder: [{ salesorderid: ORDER, name: 'Invented order', totalamount: 9, statecode: 0, statuscode: 1 }],
        salesorderdetail: [{ salesorderdetailid: id(23), name: 'Order line', salesorderid: ORDER, extendedamount: 9 }],
        invoice: [],
        invoicedetail: [],
      },
      settings: { permissionMode: 'enforce' },
      simulator: {
        permissionSource: 'configured',
        componentSchemas: {
          [DEAL_FORM]: { entity: 'opportunity', fields: [{ name: 'name', type: 'text' }] },
          [QUOTE_FORM]: { entity: 'quote', fields: [{ name: 'name', type: 'text' }] },
          [ORDER_FORM]: { entity: 'salesorder', fields: [{ name: 'name', type: 'text' }] },
        },
      },
    },
  });
  ownedFixture(t).add(() => app.close());
  const seller = signInHeaders(app, CONTACT, { roles: ['Seller'] });
  const viewer = signInHeaders(app, CONTACT, { roles: ['Viewer'] });
  const post = (formId, action, recordId, session = seller) =>
    fetch(`${app.url}/__sim/forms/entityform/${formId}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', __RequestVerificationToken: app.portalToken, ...session },
      body: JSON.stringify({ action, actionIndex: 0, recordId, values: {}, query: { row: recordId } }),
    });
  const page = async (form, row, session = seller) =>
    (await fetch(`${app.url}/?form=${form}&row=${row}`, { headers: session })).text();
  const rows = (logical) => app.store.tableRows(logical);
  const parentOf = (row, column) => String(row[column]?.id ?? row[column] ?? '').toLowerCase();
  return { app, post, page, rows, parentOf, viewer };
}

test('Generate Quote runs its Dataverse message on the form record', async (t) => {
  const { post, page, rows, parentOf } = await fixture(t, {
    forms: { deal: [{ Type: 'GenerateQuoteFromOpportunityAction' }] },
  });
  assert.match(await page('Deal', DEAL), /data-pp-form-action="generate-quote"[^>]*>Generate Quote<\/button>/);
  const generated = await post(DEAL_FORM, 'generate-quote', DEAL);
  assert.equal(generated.status, 200, await generated.text());
  const quote = rows('quote').find((row) => parentOf(row, 'opportunityid') === DEAL);
  assert.ok(quote, 'a quote of the opportunity');
  assert.deepEqual(
    rows('quotedetail')
      .filter((row) => parentOf(row, 'quoteid') === String(quote.quoteid).toLowerCase())
      .map((row) => [row.name, row.extendedamount]),
    [['Product', 30]],
  );
});

test('Calculate Value writes the won opportunity value', async (t) => {
  const { post, rows } = await fixture(t, { forms: { deal: [{ Type: 'CalculateOpportunityAction' }] } });
  const open = await post(DEAL_FORM, 'calculate-opportunity', DEAL);
  assert.equal(open.status, 400, 'only a won opportunity has an actual value');
  const won = await post(DEAL_FORM, 'calculate-opportunity', WON_DEAL);
  assert.equal(won.status, 200, await won.text());
  assert.equal(rows('opportunity').find((row) => row.opportunityid === WON_DEAL).actualvalue, 25);
});

test('Create Order activates and wins a draft quote, then converts it; Create Invoice converts the order', async (t) => {
  const { post, rows, parentOf } = await fixture(t, {
    forms: { quote: [{ Type: 'ConvertQuoteToOrderAction' }], order: [{ Type: 'ConvertOrderToInvoiceAction' }] },
  });
  const ordered = await post(QUOTE_FORM, 'convert-quote', QUOTE);
  assert.equal(ordered.status, 200, await ordered.text());
  const quote = rows('quote').find((row) => row.quoteid === QUOTE);
  assert.deepEqual([quote.statecode, quote.statuscode], [2, 4]);
  assert.match(rows('quoteclose')[0].subject, /^Quote Closed from Web \d\d\/\d\d\/\d{4} \d\d:\d\d:\d\d$/);
  const order = rows('salesorder').find((row) => parentOf(row, 'quoteid') === QUOTE);
  assert.equal(order.totalamount, 12);
  assert.deepEqual(
    rows('salesorderdetail')
      .filter((row) => parentOf(row, 'salesorderid') === String(order.salesorderid).toLowerCase())
      .map((row) => row.name),
    ['Quote line'],
  );
  const invoiced = await post(ORDER_FORM, 'convert-order', ORDER);
  assert.equal(invoiced.status, 200, await invoiced.text());
  const invoice = rows('invoice').find((row) => parentOf(row, 'salesorderid') === ORDER);
  assert.equal(invoice.totalamount, 9);
  assert.deepEqual(
    rows('invoicedetail').map((row) => row.name),
    ['Order line'],
  );
});

// @test-kind security: a Dynamics 365 action needs the exported action, Update on the record and Create on the new record's table, and a refusal writes nothing
test('message actions refuse a visitor without the record or target-table rights', async (t) => {
  const { post, page, rows, viewer } = await fixture(t, {
    forms: { deal: [{ Type: 'GenerateQuoteFromOpportunityAction' }], quote: [{ Type: 'ConvertQuoteToOrderAction' }] },
  });
  // The viewer may update opportunities and quotes but create neither quotes nor orders.
  assert.equal((await post(DEAL_FORM, 'generate-quote', DEAL, viewer)).status, 403);
  assert.equal((await post(QUOTE_FORM, 'convert-quote', QUOTE, viewer)).status, 403);
  // An action the form does not export is refused.
  assert.equal((await post(DEAL_FORM, 'calculate-opportunity', WON_DEAL)).status, 403);
  assert.equal(rows('quote').length, 1);
  assert.equal(rows('salesorder').length, 1);
  assert.equal(rows('quote')[0].statecode, 0);
  assert.doesNotMatch(await page('Deal', DEAL, {}), /generate-quote-link/);
});

// @test-kind security: a Dynamics 365 action refuses a record in a state its messages do not accept, before any message or write
test('message actions refuse a won quote, a canceled order and a closed opportunity', async (t) => {
  const { app, post, rows } = await fixture(t, {
    forms: {
      deal: [{ Type: 'GenerateQuoteFromOpportunityAction' }],
      quote: [{ Type: 'ConvertQuoteToOrderAction' }],
      order: [{ Type: 'ConvertOrderToInvoiceAction' }],
    },
  });
  const refusal = async (response) => {
    assert.equal(response.status, 400);
    const answer = await response.json();
    return answer.error?.code;
  };
  Object.assign(
    rows('quote').find((row) => row.quoteid === QUOTE),
    { statecode: 2, statuscode: 4 },
  );
  Object.assign(
    rows('salesorder').find((row) => row.salesorderid === ORDER),
    { statecode: 2, statuscode: 4 },
  );
  assert.equal(await refusal(await post(QUOTE_FORM, 'convert-quote', QUOTE)), 'InvalidStateTransition');
  assert.equal(await refusal(await post(ORDER_FORM, 'convert-order', ORDER)), 'InvalidStateTransition');
  assert.equal(await refusal(await post(DEAL_FORM, 'generate-quote', WON_DEAL)), 'InvalidStateTransition');
  assert.deepEqual(
    [rows('quoteclose').length, rows('salesorder').length, rows('invoice').length, rows('quote').length],
    [0, 1, 0, 1],
  );
  assert.equal(app.store.tableRows('quote')[0].statecode, 2, 'the quote is not reactivated');
});
