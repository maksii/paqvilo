// The site hosted session F7 (2026-11-27, SharePoint document management, runs a and b) recorded its portal reads on, rebuilt
// from invented sources: the session's one-table schema (pqf7_case with document management enabled, which gives it the
// <table>_SharePointDocumentLocations and <table>_SharePointDocuments relationships), its table permissions (Global on the
// case, Global read on sharepointdocument and sharepointdocumentlocation, for Authenticated Users), the Web API settings of
// each recorded phase, and the synthetic rows: the session's six cases and, from its S1-loc phase on, its default SharePoint
// site, the pqf7_case library and one record location per case. The row ids and names are the session's own fixed synthetic
// ones (prefix f7f7f7f7-); the ids of the second run's last two locations, which no recorded answer lists, are invented.
// The signed-in contact is invented. The SharePoint integration is off (F7_OBSERVED). The site also serves the session's
// Liquid probe page /pqf7-liquid/ (its two {% fetchxml %} queries). Shared by the portal-webapi adapter for the hosted-f7-*
// suites and the F7 observation tests.
import fs from 'node:fs/promises';
import path from 'node:path';
import { attribute, primaryName, reference, system, writeSchemaSite } from './hosted-f1-fixture-site.mjs';

export const F7_CONTACT = '0f700000-0000-4000-8000-00000000c001';
export const F7_ROLE = 'Authenticated Users';
export const f7 = (n) => `f7f7f7f7-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** The record the replay reads: the recorded `<record>` placeholder, and its name. */
export const F7_RECORD = f7(1001);
export const F7_RECORD_NAME = 'f7 a view first';
/** The record's own document location (S1-loc). */
export const F7_RECORD_LOCATION = f7(509);

// The session's Web API settings (site.mjs) and the explicit lists of its fields phase (site-set-1795762266731.json,
// site-set-1795762270274.json, site-set-1795762273315.json).
export const F7_SETTINGS = {
  'Webapi/pqf7_case/enabled': 'true',
  'Webapi/pqf7_case/fields': 'pqf7_caseid,pqf7_name',
  'Webapi/sharepointdocument/enabled': 'true',
  'Webapi/sharepointdocument/fields': '*',
  'Webapi/sharepointdocumentlocation/enabled': 'true',
  'Webapi/sharepointdocumentlocation/fields': '*',
  'Webapi/error/innererror': 'true',
};
export const F7_PHASES = {
  s0: { locations: false, settings: {} },
  's1-loc-fields': {
    locations: true,
    settings: {
      'Webapi/sharepointdocumentlocation/fields': 'sharepointdocumentlocationid,name,relativeurl,regardingobjectid',
      'Webapi/sharepointdocument/fields': 'sharepointdocumentid,fullname,relativelocation,regardingobjectid',
      'Webapi/pqf7_case/fields':
        'pqf7_caseid,pqf7_name,pqf7_case_SharePointDocumentLocations,pqf7_case_SharePointDocuments',
    },
  },
};

const CASES = [
  [1001, 'f7 a view first', 509],
  [1002, 'f7 a upload first', 511],
  [1003, 'f7 a folder first', 512],
  [2001, 'f7 b view first', 519],
  [2002, 'f7 b upload first', 521],
  [2003, 'f7 b folder first', 522],
];
const SITE = f7(501),
  LIBRARY = f7(502);
const folderName = (n, name) => `${name}_${f7(n).replaceAll('-', '').toUpperCase()}`;

function rows(locations) {
  const tables = {
    contact: [{ contactid: F7_CONTACT, firstname: 'Invented', lastname: 'Visitor', fullname: 'Invented Visitor' }],
    pqf7_case: CASES.map(([n, name]) => ({ pqf7_caseid: f7(n), pqf7_name: name, statecode: 0, statuscode: 1 })),
  };
  if (!locations) return tables;
  tables.sharepointsite = [
    { sharepointsiteid: SITE, name: 'pqf7 lab site', isdefault: true, statecode: 0, statuscode: 1 },
  ];
  const active = { locationtype: 0, servicetype: 0, statecode: 0, statuscode: 1 };
  tables.sharepointdocumentlocation = [
    {
      sharepointdocumentlocationid: LIBRARY,
      name: 'pqf7_case',
      relativeurl: 'pqf7_case',
      parentsiteorlocation: reference(SITE, 'sharepointsite', 'pqf7 lab site'),
      ...active,
    },
    ...CASES.map(([n, name, location]) => ({
      sharepointdocumentlocationid: f7(location),
      name: 'Documents on pqf7 lab site',
      relativeurl: folderName(n, name),
      parentsiteorlocation: reference(LIBRARY, 'sharepointdocumentlocation', 'pqf7_case'),
      regardingobjectid: reference(f7(n), 'pqf7_case', name),
      ...active,
    })),
  ];
  return tables;
}

// The session's permissions (site.mjs COMPONENTS 21, 23 and 24); its child permission on document locations under the
// case permission serves the document control only and no replayed read.
const permissions = () => [
  {
    id: f7(21),
    entity: 'pqf7_case',
    scope: 'global',
    roles: [F7_ROLE],
    operations: ['read', 'update', 'create', 'delete', 'append', 'appendTo'],
  },
  { id: f7(23), entity: 'sharepointdocument', scope: 'global', roles: [F7_ROLE], operations: ['read'] },
  { id: f7(24), entity: 'sharepointdocumentlocation', scope: 'global', roles: [F7_ROLE], operations: ['read'] },
];

const TABLES = {
  pqf7_case: {
    set: 'pqf7_cases',
    activity: false,
    attributes: [...system('pqf7_case'), primaryName('pqf7_name'), attribute('pqf7_note', 'nvarchar')],
    extra: '<IsDocumentManagementEnabled>1</IsDocumentManagementEnabled>',
  },
};

/** Writes the site of one recorded phase into `directory` and returns the simulator options for it. */
export async function writeHostedF7Site(directory, phase) {
  const spec = F7_PHASES[phase];
  if (!spec) throw new Error(`unknown hosted-f7 phase ${phase}`);
  const options = await writeSchemaSite(directory, {
    tables: TABLES,
    relationships: [],
    settings: { ...F7_SETTINGS, ...spec.settings },
    name: 'pqf7 replay site',
    initial: {
      version: 1,
      mappings: {},
      tables: rows(spec.locations),
      permissions: permissions(),
      settings: { permissionMode: 'enforce' },
      simulator: { mode: 'local', pageMode: 'local', endpoints: [] },
    },
  });
  const page = f7(305),
    pageTemplate = f7(42),
    template = f7(41);
  const files = {
    'pqf7-liquid.webpage.yml': `adx_webpageid: ${page}\nadx_name: pqf7 liquid\nadx_partialurl: pqf7-liquid\nadx_pagetemplateid: ${pageTemplate}\n`,
    'pqf7-liquid.pagetemplate.yml': `adx_pagetemplateid: ${pageTemplate}\nadx_webtemplateid: ${template}\n`,
    'pqf7-liquid.webtemplate.yml': `adx_webtemplateid: ${template}\nadx_name: pqf7 liquid\n`,
    'pqf7-liquid.webtemplate.source.html': F7_LIQUID,
  };
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(options.sourceDir, name), body);
  return { ...options, observed: F7_OBSERVED };
}

// The session's Liquid probe template (its site.mjs `liquid`): document locations and documents of the record named by ?id=.
export const F7_LIQUID = [
  '{% assign id = request.params.id %}',
  '<pre id="pqf7-out">{"user":"{{ user.id }}","roles":"{{ user.roles | join: \',\' }}",',
  '"locations":[{% fetchxml loc %}<fetch top="20"><entity name="sharepointdocumentlocation"><attribute name="name"/><attribute name="relativeurl"/><attribute name="absoluteurl"/><attribute name="regardingobjectid"/><attribute name="parentsiteorlocation"/><attribute name="locationtype"/><attribute name="servicetype"/><attribute name="statecode"/><filter><condition attribute="regardingobjectid" operator="eq" value="{{ id }}"/></filter></entity></fetch>{% endfetchxml %}{% for e in loc.results.entities %}{"name":"{{ e.name | escape }}","relativeurl":"{{ e.relativeurl | escape }}","absoluteurl":"{{ e.absoluteurl | escape }}","parent":"{{ e.parentsiteorlocation.name | escape }}"}{% unless forloop.last %},{% endunless %}{% endfor %}],',
  '"locationsCount":"{{ loc.results.entities.size }}",',
  '"documents":[{% fetchxml docs %}<fetch><entity name="sharepointdocument"><attribute name="fullname"/><attribute name="relativelocation"/><attribute name="filetype"/><attribute name="documentid"/><attribute name="isfolder"/><filter><condition attribute="regardingobjectid" operator="eq" value="{{ id }}"/></filter></entity></fetch>{% endfetchxml %}{% for e in docs.results.entities %}{"fullname":"{{ e.fullname | escape }}","relativelocation":"{{ e.relativelocation | escape }}","isfolder":"{{ e.isfolder }}"}{% unless forloop.last %},{% endunless %}{% endfor %}],',
  '"documentsCount":"{{ docs.results.entities.size }}",',
  '"record":"{% assign r = entities.pqf7_case[id] %}{{ r.pqf7_name | escape }}"}</pre>',
].join('\n');

// The recorded site's observed choices: every Web API error carried innererror { code, message, type } (the session's
// Webapi/error/innererror; api-s0 and api-s1-loc-fields, 90040101 and 90040122 alike), and a failed Liquid FetchXML query
// printed the target-invocation error wherever its results were read (liquid-s0, liquid-s1-loc); the environment's SharePoint
// integration was off in every phase (summary-F7.md section 8: it needs a Global Administrator).
export const F7_OBSERVED = {
  sharePointIntegration: 'off',
  webApiInnerError: 'all-errors',
  liquidFetchExecution: 'lazy-query-drop',
  liquidFetchErrorMessage: 'target-invocation',
  evidence:
    'Hosted session F7 (2026-11-27), runs a and b: api-s0, api-s1-loc-fields, liquid-s0, liquid-s1-loc and the admin center SharePoint Integration setting (No).',
};
