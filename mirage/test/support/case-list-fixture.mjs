// Invented incident list fixture for the grid record action tests (Node and browser).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../../server.mjs';
import { emptyState } from '../../lib/data.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../../testing/owned-fixture.mjs';

export const G = (n) => `cccccccc-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
export const CASES = {};
const SITE = G(1),
  LIST = G(2),
  CONTACT = G(3),
  OPEN = G(4),
  OTHER = G(5),
  DEAL = G(6),
  TASK = G(7);
const states = (pairs) => ({
  dataverseType: 'state',
  states: pairs.map(([value, defaultStatus]) => ({ value, defaultStatus })),
});
const statuses = (pairs) => ({ dataverseType: 'status', statuses: pairs.map(([value, state]) => ({ value, state })) });
const lookup = (target) => ({ dataverseType: 'lookup', targets: [target] });

Object.assign(CASES, { SITE, LIST, CONTACT, OPEN, OTHER, DEAL, TASK });
const DEFAULT_SETTINGS = {
  ItemActions: [{ Type: 'ResolveCaseAction' }, { Type: 'CrmEntityFormView-CancelCaseAction', ActionIndex: 2 }],
};

/** A list of invented cases with `settings`, two open cases, an open task of the second and an opportunity. */
export async function startCaseList(t, settings = DEFAULT_SETTINGS) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'grid-record-actions-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const files = {
    'website.yml': `adx_websiteid: ${SITE}\nadx_name: Invented cases\n`,
    'Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: template',
    'Main.pagetemplate.yml': 'adx_pagetemplateid: template\nadx_webtemplateid: main',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html': "{% include 'entity_list' key: 'Cases' %}",
    'Cases.list.yml': [
      `adx_entitylistid: ${LIST}`,
      'adx_name: Cases',
      'adx_entityname: incident',
      'adx_settings: |-',
      `  ${JSON.stringify(settings)}`,
    ].join('\n'),
  };
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(dir, name), content);
  const state = emptyState();
  const table = (entitySet, idColumn, fields) => ({
    entitySet,
    idColumn,
    nameColumn: 'title',
    userConfigured: true,
    fields,
    relationships: {},
  });
  state.mappings.incident = table('incidents', 'incidentid', {
    title: { dataverseType: 'nvarchar' },
    statecode: states([
      [0, 1],
      [1, 5],
      [2, 6],
    ]),
    statuscode: statuses([
      [1, 0],
      [5, 1],
      [6, 2],
    ]),
  });
  state.mappings.incidentresolution = table('incidentresolutions', 'activityid', {
    subject: { dataverseType: 'nvarchar' },
    description: { dataverseType: 'nvarchar' },
    incidentid: lookup('incident'),
  });
  state.mappings.task = table('tasks', 'activityid', {
    subject: { dataverseType: 'nvarchar' },
    statecode: states([
      [0, 2],
      [1, 5],
      [2, 6],
    ]),
    statuscode: statuses([
      [2, 0],
      [5, 1],
      [6, 2],
    ]),
  });
  state.mappings.opportunity = table('opportunities', 'opportunityid', { title: { dataverseType: 'nvarchar' } });
  state.mappings.quote = table('quotes', 'quoteid', {
    title: { dataverseType: 'nvarchar' },
    opportunityid: lookup('opportunity'),
  });
  state.settings.permissionMode = 'enforce';
  state.permissions = [
    { id: 'cases', entity: 'incident', scope: 'global', roles: ['Agent'], operations: ['read', 'update'] },
    { id: 'case-reader', entity: 'incident', scope: 'global', roles: ['Reader'], operations: ['read'] },
    { id: 'deals', entity: 'opportunity', scope: 'global', roles: ['Agent'], operations: ['read', 'update'] },
    { id: 'quotes', entity: 'quote', scope: 'global', roles: ['Agent'], operations: ['create'] },
  ];
  state.tables.contact = [{ contactid: CONTACT, fullname: 'Invented agent' }];
  state.tables.incident = [
    { incidentid: OPEN, title: 'Open case', statecode: 0, statuscode: 1 },
    { incidentid: OTHER, title: 'Other case', statecode: 0, statuscode: 1 },
  ];
  state.tables.incidentresolution = [];
  state.tables.task = [
    {
      activityid: TASK,
      subject: 'Follow up',
      regardingobjectid: { id: OTHER, logical_name: 'incident' },
      statecode: 0,
      statuscode: 2,
    },
  ];
  state.tables.opportunity = [{ opportunityid: DEAL, title: 'Invented deal', statecode: 0, statuscode: 1 }];
  state.tables.quote = [];
  state.simulator = { componentSchemas: { Cases: { entity: 'incident', fields: [{ name: 'title', label: 'Case' }] } } };
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
