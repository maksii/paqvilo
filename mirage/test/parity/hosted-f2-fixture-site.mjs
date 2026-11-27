// The invented schema of hosted session F2 (paqvilo-developer hosted-f2, provision.mjs, seed.mjs and
// site-components.mjs): an Enhanced, Bootstrap 5 site with a `pqf2_case` table, a custom activity `pqf2_visit` and the
// basic forms the portal-form-postback captures of that session posted. Only the parts those postbacks read are rebuilt:
// the forms, their fields, the pages that hold them and the records the captures name by fixture key (`run-row-<k>`,
// the case's offset in the run's id range). Site/EnableCustomPluginError is absent, as on the recorded site.
import fs from 'node:fs/promises';
import path from 'node:path';

export const HOSTED_F2_CONTACT = 'f2f2f2f2-0000-4000-8000-0000000c0001';
const record = (n) => `f2f2f2f2-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Fixture keys of the captures' records. */
export const hostedF2Ids = Object.fromEntries([1, 2, 3, 4, 5, 20].map((k) => [`run-row-${k}`, record(k)]));

// The party list columns of the custom activity, each with its own insert form (site-components.mjs PARTY_COLUMNS).
const PARTY_COLUMNS = [
  'from',
  'to',
  'cc',
  'bcc',
  'requiredattendees',
  'optionalattendees',
  'organizer',
  'customers',
  'partners',
  'resources',
];
const COLOURS = [
  { value: 619020000, label: 'Red', labels: { 1031: 'Rot', 1033: 'Red' } },
  { value: 619020001, label: 'Green', labels: { 1031: 'Grün', 1033: 'Green' } },
  { value: 619020002, label: 'Blue', labels: { 1031: 'Blau', 1033: 'Blue' } },
];
const RICH_TEXT_EDITOR = 'MscrmControls.RichTextEditor.RichTextEditorControl';

const name = { name: 'pqf2_name', type: 'text', label: 'Name', dataverseType: 'nvarchar', maxLength: 200 };
const amount = {
  name: 'pqf2_amount',
  type: 'number',
  label: 'Amount',
  dataverseType: 'int',
  minimum: -100000,
  maximum: 100000,
};
const text = (column, label, extra = {}) => ({
  name: column,
  type: 'text',
  label,
  dataverseType: 'nvarchar',
  ...extra,
});
const memo = (column, label, extra = {}) => ({
  name: column,
  type: 'textarea',
  label,
  dataverseType: 'ntext',
  maxLength: 4000,
  ...extra,
});
const float = (column, label) => ({ name: column, type: 'number', label, dataverseType: 'float' });

// The forms (pqf2 case simple, pqf2 case main, pqf2 case geo, pqf2 visit main of provision.mjs).
const SIMPLE = [name, amount];
const MAIN = [
  name,
  { name: 'pqf2_colours', label: 'Colours', dataverseType: 'multiselectpicklist', options: COLOURS },
  amount,
  // The editor is bound in FormXml only: no code component metadata (site-components.mjs 145 came after these runs).
  memo('pqf2_rich', 'Rich text (editor)', { richText: { name: RICH_TEXT_EDITOR } }),
  memo('pqf2_rich2', 'Rich text (plain control)'),
  text('pqf2_wfresult', 'Workflow result'),
];
const GEO = [
  name,
  text('pqf2_street', 'Street'),
  text('pqf2_city', 'City'),
  text('pqf2_county', 'County'),
  text('pqf2_region', 'State'),
  text('pqf2_postal', 'Postal code'),
  text('pqf2_country', 'Country'),
  text('pqf2_formatted', 'Formatted address'),
  float('pqf2_latitude', 'Latitude'),
  float('pqf2_longitude', 'Longitude'),
];

const EDIT = { adx_mode: 100000001, adx_entitysourcetype: 756150001, adx_recordidquerystringparametername: 'id' };
const ATTACH = {
  adx_attachfile: true,
  adx_attachfilerequired: true,
  adx_attachfilelabel: 'pqf2 attachment',
  adx_attachfileaccept: '*/*',
  adx_attachfilemaxsize: 1024,
  adx_attachfilesaveoption: 756150000,
  adx_attachfilestoragelocation: 756150000,
};
// [form id, name, page path, table, fields, settings]
const FORMS = [
  [
    'attachmax1',
    'pqf2 Attach Max1',
    'pqf2-attach-max1',
    'pqf2_case',
    SIMPLE,
    { ...EDIT, ...ATTACH, adx_attachfileallowmultiple: true, adx_maximumnooffiles: 1 },
  ],
  [
    'attachsingle',
    'pqf2 Attach Single',
    'pqf2-attach-single',
    'pqf2_case',
    SIMPLE,
    { ...EDIT, ...ATTACH, adx_attachfileallowmultiple: false },
  ],
  [
    'attachmax2',
    'pqf2 Attach Max2',
    'pqf2-attach-max2',
    'pqf2_case',
    SIMPLE,
    { ...EDIT, ...ATTACH, adx_attachfileallowmultiple: true, adx_maximumnooffiles: 2, adx_attachfilerequired: false },
  ],
  ['caseedit', 'pqf2 Case Edit', 'pqf2-edit', 'pqf2_case', MAIN, EDIT],
  [
    'casegeo',
    'pqf2 Case Geo',
    'pqf2-geo',
    'pqf2_case',
    GEO,
    {
      adx_mode: 100000000,
      adx_geolocation_enabled: true,
      adx_geolocation_displaymap: true,
      adx_geolocation_maptype: 756150000,
      adx_geolocation_addresslinefieldname: 'pqf2_street',
      adx_geolocation_cityfieldname: 'pqf2_city',
      adx_geolocation_countyfieldname: 'pqf2_county',
      adx_geolocation_statefieldname: 'pqf2_region',
      adx_geolocation_postalcodefieldname: 'pqf2_postal',
      adx_geolocation_countryfieldname: 'pqf2_country',
      adx_geolocation_formattedaddressfieldname: 'pqf2_formatted',
      adx_geolocation_latitudefieldname: 'pqf2_latitude',
      adx_geolocation_longitudefieldname: 'pqf2_longitude',
    },
  ],
  [
    'casecaptcha',
    'pqf2 Case Captcha',
    'pqf2-captcha',
    'pqf2_case',
    SIMPLE,
    { adx_mode: 100000000, adx_captcharequired: true, adx_showcaptchaforauthenticatedusers: true },
  ],
  ['casereject', 'pqf2 Case Reject', 'pqf2-reject', 'pqf2_case', SIMPLE, { adx_mode: 100000000 }],
  ...PARTY_COLUMNS.map((column) => [
    `visit${column}`,
    `pqf2 Visit ${column}`,
    `pqf2-visit-${column}`,
    'pqf2_visit',
    [text('subject', 'Subject', { maxLength: 200 })],
    {
      adx_mode: 100000000,
      adx_associatecurrentportaluser: true,
      adx_targetentityportaluserlookupattribute: column,
      adx_portaluserlookupattributeisactivityparty: true,
    },
  ]),
];

const yamlValue = (value) => (typeof value === 'string' ? JSON.stringify(value) : String(value));
const yaml = (fields) =>
  Object.entries(fields)
    .map(([key, value]) => `${key}: ${yamlValue(value)}`)
    .join('\n');

/** Writes the F2 site source into `directory`. */
export async function writeHostedF2FixtureSite(directory) {
  const files = {
    'website.yml': yaml({
      adx_websiteid: 'f2f2f2f2-0000-4000-8000-0000000000aa',
      adx_name: 'Invented hosted F2 forms',
    }),
    'Home.webpage.yml': yaml({
      adx_webpageid: 'home',
      adx_name: 'Home',
      adx_partialurl: '/',
      adx_isroot: true,
      adx_pagetemplateid: 'home',
    }),
    'Home.pagetemplate.yml': yaml({ adx_pagetemplateid: 'home', adx_webtemplateid: 'home' }),
    'Home.webtemplate.yml': yaml({ adx_webtemplateid: 'home', adx_name: 'Home' }),
    'Home.webtemplate.source.html': '<h1>Home</h1>',
    'sitesetting.yml': '- adx_sitesettingid: f2-bootstrap5\n  adx_name: Site/BootstrapV5Enabled\n  adx_value: "true"\n',
  };
  for (const [id, formName, page, table, , settings] of FORMS) {
    files[`${id}.webpage.yml`] = yaml({
      adx_webpageid: id,
      adx_name: page,
      adx_partialurl: page,
      adx_parentpageid: 'home',
      adx_pagetemplateid: id,
    });
    files[`${id}.pagetemplate.yml`] = yaml({ adx_pagetemplateid: id, adx_webtemplateid: id });
    files[`${id}.webtemplate.yml`] = yaml({ adx_webtemplateid: id, adx_name: page });
    files[`${id}.webtemplate.source.html`] = `{% entityform name: '${formName}' %}`;
    files[`${id}.basicform.yml`] = yaml({
      adx_entityformid: id,
      adx_name: formName,
      adx_entityname: table,
      adx_successmessage: `${formName} saved`,
      adx_hideformonsuccess: false,
      adx_validationsummarylinksenabled: true,
      ...settings,
    });
  }
  for (const [file, source] of Object.entries(files)) await fs.writeFile(path.join(directory, file), source);
}

const note = (n, regarding, extra) => ({
  annotationid: record(100 + n),
  objectid: { id: record(regarding), logical_name: 'pqf2_case' },
  objecttypecode: 'pqf2_case',
  subject: 'pqf2 admin note',
  notetext: '*WEB* pqf2 admin note',
  ...extra,
});
const adminFile = {
  filename: 'pqf2-admin.txt',
  mimetype: 'text/plain',
  isdocument: true,
  documentbody: 'cHFmMiBhZG1pbg==',
};

/** The simulator options of the F2 site for `sourceDir`. */
export function hostedF2FixtureOptions(sourceDir) {
  const caseFields = Object.fromEntries(
    [...new Map([...SIMPLE, ...MAIN, ...GEO].map((field) => [field.name, field])).values()].map((field) => [
      field.name,
      {
        dataverseType: field.dataverseType,
        ...(field.maxLength ? { maxLength: field.maxLength } : {}),
        ...(field.minimum != null ? { minValue: field.minimum, maxValue: field.maximum } : {}),
        ...(field.options ? { options: field.options } : {}),
      },
    ]),
  );
  const schemas = Object.fromEntries(
    FORMS.map(([id, , , table, fields]) => [id, { entity: table, fields: fields.map((field) => ({ ...field })) }]),
  );
  return {
    sourceDir,
    watch: false,
    port: 0,
    initial: {
      mappings: {
        contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' },
        pqf2_case: { entitySet: 'pqf2_cases', idColumn: 'pqf2_caseid', nameColumn: 'pqf2_name', fields: caseFields },
        pqf2_visit: {
          entitySet: 'pqf2_visits',
          idColumn: 'activityid',
          nameColumn: 'subject',
          fields: {
            subject: { dataverseType: 'nvarchar', maxLength: 200 },
            ...Object.fromEntries(PARTY_COLUMNS.map((column) => [column, { dataverseType: 'partylist' }])),
          },
        },
        activityparty: {
          entitySet: 'activityparties',
          idColumn: 'activitypartyid',
          relationships: {
            activityid_pqf2_visit: { entity: 'pqf2_visit', from: 'activityid', to: 'activityid', many: false },
            partyid_contact: { entity: 'contact', from: 'partyid', to: 'contactid', many: false },
          },
        },
        annotation: {
          entitySet: 'annotations',
          idColumn: 'annotationid',
          relationships: {
            objectid_pqf2_case: { entity: 'pqf2_case', from: 'objectid', to: 'pqf2_caseid', many: false },
          },
        },
      },
      tables: {
        contact: [{ contactid: HOSTED_F2_CONTACT, fullname: 'Invented Persona', statecode: 0 }],
        pqf2_case: [
          { pqf2_caseid: record(1), pqf2_name: 'A max1 with admin note <run>', pqf2_amount: 1 },
          { pqf2_caseid: record(2), pqf2_name: 'A single with admin note <run>', pqf2_amount: 2 },
          { pqf2_caseid: record(3), pqf2_name: 'A max1 without notes <run>', pqf2_amount: 3 },
          { pqf2_caseid: record(4), pqf2_name: 'A max2 with admin note <run>', pqf2_amount: 4 },
          { pqf2_caseid: record(5), pqf2_name: 'A single text-only admin note <run>', pqf2_amount: 5 },
          { pqf2_caseid: record(20), pqf2_name: 'C choices <run>', pqf2_amount: 20, pqf2_colours: '619020001' },
        ],
        pqf2_visit: [],
        activityparty: [],
        // The administrator's notes the persona's form counts (seed.mjs): files on rows 1, 2 and 4, text only on row 5.
        annotation: [
          note(1, 1, adminFile),
          note(2, 2, adminFile),
          note(4, 4, adminFile),
          note(5, 5, { subject: 'pqf2 admin text note', notetext: '*WEB* pqf2 admin text only' }),
        ],
      },
      settings: { permissionMode: 'permissive' },
      simulator: { mode: 'local', pageMode: 'local', live: {}, endpoints: [], componentSchemas: schemas },
    },
  };
}
