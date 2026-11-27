// @test-kind unproven: local model of the legacy grid's Qualify, Activate Quote and Reopen Opportunity item actions (Adxstudio ViewConfiguration.SetSpecialMessageActions adds them to the item action links, LinkActionType 10, 19 and 25, entity-grid.js row links, PortalAreaRegistration routes action-qualify-lead, action-activate-quote and reopen-opportunity, EntityActionController); no hosted capture of these list actions
import test from 'node:test';
import assert from 'node:assert/strict';
import { signInHeaders } from '../testing/session.mjs';
import { SALES, startSalesLists } from './support/sales-list-fixture.mjs';

const ACTIONS = {
  lead: [{ Type: 'QualifyLeadAction', ShowModal: 1 }],
  quote: [{ Type: 'ActivateQuoteAction' }],
  opportunity: [{ Type: 'ReopenOpportunityAction' }],
};

async function fixture(t, actions = ACTIONS) {
  const app = await startSalesLists(t, actions);
  const agent = signInHeaders(app, SALES.CONTACT, { roles: ['Agent'] });
  const reader = signInHeaders(app, SALES.CONTACT, { roles: ['Reader'] });
  const page = async (route) => {
    const html = await (await fetch(app.url + route, { headers: agent })).text();
    const encoded = /data-view-layouts="([^"]+)"/.exec(html)?.[1];
    const [layout] = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    return { html, links: layout.Configuration.ItemActionLinks.map((link) => [link.Type, link.Label, link.URL?.Path]) };
  };
  const post = (route, logical, id, session = agent) =>
    fetch(`${app.url}/_services/${route}/${SALES.SITE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', __RequestVerificationToken: app.csrf, ...session },
      body: JSON.stringify({ entityReference: { LogicalName: logical, Id: id } }),
    });
  const row = (table, id) => app.store.tableRows(table).find((item) => item[`${table}id`] === id);
  return { app, page, post, row, reader };
}

test('a lead list offers Qualify with its confirmation dialog and qualifies the lead through QualifyLead', async (t) => {
  const { app, page, post, row, reader } = await fixture(t);
  const { html, links } = await page('/');
  assert.deepEqual(links, [
    [
      10,
      "<span class='fa fa-check fa-fw' aria-hidden='true'></span> Qualify",
      `/_services/action-qualify-lead/${SALES.SITE}`,
    ],
  ]);
  assert.match(html, /class="modal fade modal-qualify"[^>]*data-pp-action-index="grid"/);
  assert.match(html, /<p>Are you sure you want to qualify this lead as an opportunity\?<\/p>/);
  assert.equal((await post('action-qualify-lead', 'lead', SALES.LEAD, reader)).status, 403);
  assert.equal(app.store.tableRows('account').length, 0);
  const qualified = await post('action-qualify-lead', 'lead', SALES.LEAD);
  assert.equal(qualified.status, 204, await qualified.text());
  assert.deepEqual([row('lead', SALES.LEAD).statecode, row('lead', SALES.LEAD).statuscode], [1, 3]);
  assert.equal(app.store.tableRows('account')[0].name, 'Invented Company');
  const opportunity = app.store
    .tableRows('opportunity')
    .find((item) => String(item.originatingleadid?.id ?? '').toLowerCase() === SALES.LEAD);
  assert.equal(String(opportunity.transactioncurrencyid?.id).toLowerCase(), SALES.DOLLAR);
  // A qualified lead is refused before any write.
  const again = await post('action-qualify-lead', 'lead', SALES.QUALIFIED_LEAD);
  assert.equal(again.status, 400);
  assert.equal(app.store.tableRows('account').length, 1);
});

test('a Qualify action without ShowModal draws no confirmation dialog', async (t) => {
  const { page } = await fixture(t, { ...ACTIONS, lead: [{ Type: 'QualifyLeadAction' }] });
  assert.doesNotMatch((await page('/')).html, /modal-qualify/);
});

test('quote and opportunity lists offer Activate Quote and Reopen through their legacy routes', async (t) => {
  const { page, post, row } = await fixture(t);
  assert.deepEqual((await page('/quotes/')).links, [
    [
      19,
      "<span class='fa fa-check-square-o fa-fw' aria-hidden='true'></span> Activate Quote",
      `/_services/action-activate-quote/${SALES.SITE}`,
    ],
  ]);
  assert.deepEqual((await page('/deals/')).links, [
    [
      25,
      "<span class='fa fa-reply fa-fw' aria-hidden='true'></span> Reopen",
      `/_services/reopen-opportunity/${SALES.SITE}`,
    ],
  ]);
  assert.equal((await post('action-activate-quote', 'quote', SALES.QUOTE)).status, 204);
  assert.deepEqual([row('quote', SALES.QUOTE).statecode, row('quote', SALES.QUOTE).statuscode], [1, 2]);
  assert.equal((await post('action-activate-quote', 'quote', SALES.ACTIVE_QUOTE)).status, 400);
  assert.equal((await post('reopen-opportunity', 'opportunity', SALES.OPEN_DEAL)).status, 400);
  assert.equal((await post('reopen-opportunity', 'opportunity', SALES.WON_DEAL)).status, 204);
  assert.deepEqual(
    [row('opportunity', SALES.WON_DEAL).statecode, row('opportunity', SALES.WON_DEAL).statuscode],
    [0, 100000003],
  );
});
