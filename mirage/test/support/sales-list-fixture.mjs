// Invented sales list fixture for the lead, quote and opportunity grid record action tests (Node and browser).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../../server.mjs';
import { emptyState } from '../../lib/data.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../../testing/owned-fixture.mjs';

const G = (n) => `dddddddd-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
export const SALES = {
  SITE: G(1),
  CONTACT: G(2),
  LEAD: G(10),
  QUALIFIED_LEAD: G(11),
  QUOTE: G(12),
  ACTIVE_QUOTE: G(13),
  WON_DEAL: G(14),
  OPEN_DEAL: G(15),
  DOLLAR: G(16),
};
const states = (pairs) => ({
  dataverseType: 'state',
  states: pairs.map(([value, defaultStatus]) => ({ value, defaultStatus })),
});
const statuses = (pairs) => ({ dataverseType: 'status', statuses: pairs.map(([value, state]) => ({ value, state })) });
const lookup = (target) => ({ dataverseType: 'lookup', targets: [target] });
const text = { dataverseType: 'nvarchar' };

/**
 * Lists of leads (/), quotes (/quotes/) and opportunities (/deals/), each with `actions[table]` as its item actions, and
 * a lead edit form (/lead/?id=<lead>) with `actions.form` as its form actions.
 */
export async function startSalesLists(t, actions) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'grid-sales-actions-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const list = (name, entity, n) => [
    `adx_entitylistid: ${G(n)}`,
    `adx_name: ${name}`,
    `adx_entityname: ${entity}`,
    'adx_settings: |-',
    `  ${JSON.stringify({ ItemActions: actions[entity] ?? [] })}`,
  ];
  const page = (name, partial, template, root = false) =>
    `adx_webpageid: ${name}\nadx_name: ${name}\nadx_partialurl: ${partial}\n${root ? 'adx_isroot: true' : 'adx_parentpageid: home'}\nadx_pagetemplateid: ${template}`;
  const files = {
    'website.yml': `adx_websiteid: ${SALES.SITE}\nadx_name: Invented sales\n`,
    'Home.webpage.yml': page('home', '/', 'leads', true),
    'Quotes.webpage.yml': page('quotes', 'quotes', 'quotes'),
    'Deals.webpage.yml': page('deals', 'deals', 'deals'),
    'Lead.webpage.yml': page('lead', 'lead', 'leadform'),
    'LeadForm.pagetemplate.yml': 'adx_pagetemplateid: leadform\nadx_webtemplateid: leadform',
    'LeadForm.webtemplate.yml': 'adx_webtemplateid: leadform\nadx_name: Lead form',
    'LeadForm.webtemplate.source.html': '{% entityform name: "Lead" %}',
    'Lead.basicform.yml': [
      `adx_entityformid: ${G(6)}`,
      'adx_name: Lead',
      'adx_entityname: lead',
      'adx_mode: 100000001',
      'adx_entitysourcetype: 756150001',
      'adx_recordidquerystringparametername: id',
      'adx_settings: |-',
      `  ${JSON.stringify({ Actions: actions.form ?? [] })}`,
    ].join('\n'),
    ...Object.fromEntries(
      [
        ['leads', 'Leads'],
        ['quotes', 'Quotes'],
        ['deals', 'Deals'],
      ].flatMap(([id, name]) => [
        [`${name}.pagetemplate.yml`, `adx_pagetemplateid: ${id}\nadx_webtemplateid: ${id}`],
        [`${name}.webtemplate.yml`, `adx_webtemplateid: ${id}\nadx_name: ${name}`],
        [`${name}.webtemplate.source.html`, `{% include 'entity_list' key: '${name}' %}`],
      ]),
    ),
    'Leads.list.yml': list('Leads', 'lead', 3).join('\n'),
    'Quotes.list.yml': list('Quotes', 'quote', 4).join('\n'),
    'Deals.list.yml': list('Deals', 'opportunity', 5).join('\n'),
  };
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(dir, name), content);
  const state = emptyState();
  const table = (entitySet, idColumn, fields) => ({
    entitySet,
    idColumn,
    nameColumn: 'name',
    userConfigured: true,
    fields: { name: text, ...fields },
    relationships: {},
  });
  state.mappings.lead = table('leads', 'leadid', {
    subject: text,
    companyname: text,
    lastname: text,
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
  });
  state.mappings.account = table('accounts', 'accountid', { originatingleadid: lookup('lead') });
  state.mappings.contact = table('contacts', 'contactid', { lastname: text, originatingleadid: lookup('lead') });
  state.mappings.opportunity = table('opportunities', 'opportunityid', {
    originatingleadid: lookup('lead'),
    transactioncurrencyid: lookup('transactioncurrency'),
    adx_partnercreated: { dataverseType: 'bit' },
    statecode: states([
      [0, 1],
      [1, 3],
      [2, 4],
    ]),
    // The partner portal's Accepted (100000003) status of the Open state, which ReopenOpportunity sets.
    statuscode: statuses([
      [1, 0],
      [100000003, 0],
      [3, 1],
      [4, 2],
    ]),
  });
  state.mappings.quote = table('quotes', 'quoteid', {
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
  });
  state.mappings.transactioncurrency = table('transactioncurrencies', 'transactioncurrencyid', {
    currencyname: text,
    exchangerate: { dataverseType: 'decimal' },
  });
  state.settings.permissionMode = 'enforce';
  const grant = (entity, operations, roles = ['Agent']) => ({
    id: `${entity}-${roles.join('-')}`,
    entity,
    scope: 'global',
    roles,
    operations,
  });
  state.permissions = [
    grant('lead', ['read', 'update']),
    grant('lead', ['read'], ['Reader']),
    grant('account', ['create']),
    grant('contact', ['create']),
    grant('opportunity', ['read', 'update', 'create']),
    grant('quote', ['read', 'update']),
  ];
  state.tables.contact = [{ contactid: SALES.CONTACT, name: 'Invented agent' }];
  state.tables.lead = [
    {
      leadid: SALES.LEAD,
      name: 'Invented lead',
      subject: 'Invented interest',
      companyname: 'Invented Company',
      lastname: 'Lead',
      statecode: 0,
      statuscode: 1,
    },
    { leadid: SALES.QUALIFIED_LEAD, name: 'Qualified lead', lastname: 'Done', statecode: 1, statuscode: 3 },
  ];
  state.tables.account = [];
  state.tables.opportunity = [
    { opportunityid: SALES.WON_DEAL, name: 'Won deal', statecode: 1, statuscode: 3 },
    { opportunityid: SALES.OPEN_DEAL, name: 'Open deal', statecode: 0, statuscode: 1 },
  ];
  state.tables.quote = [
    { quoteid: SALES.QUOTE, name: 'Draft quote', statecode: 0, statuscode: 1 },
    { quoteid: SALES.ACTIVE_QUOTE, name: 'Active quote', statecode: 1, statuscode: 2 },
  ];
  state.tables.transactioncurrency = [
    { transactioncurrencyid: SALES.DOLLAR, name: 'US Dollar', currencyname: 'US Dollar', exchangerate: 1 },
  ];
  state.simulator = {
    componentSchemas: {
      Leads: { entity: 'lead', fields: [{ name: 'name', label: 'Lead' }] },
      [G(6)]: { entity: 'lead', fields: [{ name: 'name', label: 'Lead', type: 'text' }] },
      Quotes: { entity: 'quote', fields: [{ name: 'name', label: 'Quote' }] },
      Deals: { entity: 'opportunity', fields: [{ name: 'name', label: 'Deal' }] },
    },
  };
  const app = await createSimulator({
    sourceDir: dir,
    projectRoot: dir,
    watch: false,
    port: 0,
    initial: state,
    dataverse: { enabled: true, tls: false, tds: { enabled: false } },
  });
  ownedFixture(t).add(() => app.close());
  return app;
}
