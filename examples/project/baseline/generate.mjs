#!/usr/bin/env node
// Baseline fixture generator: writes the Dataverse manifest (tables, columns, relationships, keys,
// forms, views) and the extras (column kinds the manifest API does not model) for the invented
// baseline tables. Everything is deterministic: component ids derive from names, so reruns
// produce identical files and the provisioning script is idempotent.
//
//   node examples/project/baseline/generate.mjs
//
// Control classids were harvested from exported main forms of a connected environment (see
// mirage/docs/baseline/dataverse-inventory.md); they are the platform's form designer values.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const PREFIX = 'pqvd';
const SOLUTION = 'PaqviloBaseline';
const LCID = 1033;
const ITEM = `${PREFIX}_baselineitem`;
const PARENT = `${PREFIX}_baselineparent`;
const CHILD = `${PREFIX}_baselinechild`;

export const CLASSIDS = Object.freeze({
  text: '{4273EDBD-AC1D-40D3-9FB2-095C621B552D}',
  memo: '{E0DECE4B-6FC8-4A8F-A065-082708572369}',
  email: '{ADA2203E-B4CD-49BE-9DDF-234642B43B52}',
  url: '{71716B6C-711E-476C-8AB8-5D11542BFB47}',
  phone: '{8C10015A-B339-4982-9474-A95FE05631A5}',
  ticker: '{1E1FC551-F7A8-43AF-AC34-A8DC35C7B6D4}',
  integer: '{C6D124CA-7EDA-4A60-AEA9-7FB8D318B68F}',
  duration: '{AA987274-CE4E-4271-A803-66164311A958}',
  timezone: '{7C624A0B-F59E-493D-9583-638D34759266}',
  decimal: '{C3EFE0C3-0EC6-42BE-8349-CBD9079DFD8E}',
  double: '{0D2C745A-E5A8-4C8B-BA63-C6D3BB604660}',
  money: '{533B9E00-756B-4312-95A0-DC888637AC78}',
  datetime: '{5B773807-9FB2-42DB-97C3-7A91EFF8ADFF}',
  picklist: '{3EF39988-22BB-4F0B-BBBE-64B5A3748AEE}',
  status: '{5D68B988-0661-4DB2-BC3E-17598AD3BE6C}',
  multiselect: '{4AA28AB7-9C13-4F57-A73D-AD894D048B5F}',
  boolean: '{67FAC785-CD58-4F9F-ABB3-4B7DDC6ED5ED}',
  checkbox: '{B0C6723A-8503-4FD7-BB28-C8A06AC933C2}',
  lookup: '{270BD3DB-D9AF-4782-9025-509E298DEC0A}',
  polymorphic: '{F3015350-44A2-4AA0-97B5-00166532B5E9}',
  image: '{7E548B0D-209C-477B-9DCD-F0F44472381D}',
  file: '{0A7FF475-B016-4687-9CE5-042BFDBD6519}',
  subgrid: '{E7A81278-8635-4D9E-8D4D-59480B391C5B}',
  quickview: '{5C5600E0-1D6E-4205-A272-BE80DA87FD42}',
  notes: '{06375649-C143-495E-A496-C962E5B4488E}',
  webresource: '{9FDF5F91-88B1-47F4-AD53-C11EFC01A01D}',
  iframe: '{FD2A7985-3187-444E-908D-6624B21F69C0}',
});

/** Deterministic GUID from a name (version-4 shaped, fixed per name). */
export function guid(name) {
  const hex = createHash('sha256').update(`paqvilo-baseline:${name}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const braced = (name) => `{${guid(name).toUpperCase()}}`;
const escape = (text) =>
  String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---- Columns of the item table. `kind` selects the form control; `manifest` columns go through the
// provisioning manifest, the others are created by the extras script with the raw Web API.
// Columns are written with their full logical name so inventory anchors (`generate.mjs#pqvd_text`) resolve.
const col = (name, label, kind, manifest, extra = {}) => ({ name, label, kind, manifest, ...extra });
export const ITEM_COLUMNS = [
  col(
    'pqvd_code',
    'Code',
    'text',
    { type: 'string', maxLength: 40, required: 'required' },
    { catalog: 'dv.key.alternate' },
  ),
  col('pqvd_text', 'Text', 'text', { type: 'string', maxLength: 50 }, { catalog: 'dv.column.string.text' }),
  col(
    'pqvd_textarea',
    'Text area',
    'text',
    { type: 'string', maxLength: 500, format: 'TextArea' },
    { catalog: 'dv.column.string.textarea' },
  ),
  col(
    'pqvd_email',
    'Email',
    'email',
    { type: 'string', maxLength: 100, format: 'Email' },
    { catalog: 'dv.column.string.email' },
  ),
  col('pqvd_url', 'Url', 'url', { type: 'string', maxLength: 200, format: 'Url' }, { catalog: 'dv.column.string.url' }),
  col(
    'pqvd_phone',
    'Phone',
    'phone',
    { type: 'string', maxLength: 50, format: 'Phone' },
    { catalog: 'dv.column.string.phone' },
  ),
  col(
    'pqvd_ticker',
    'Ticker',
    'ticker',
    { type: 'string', maxLength: 10, format: 'TickerSymbol' },
    { catalog: 'dv.column.string.tickersymbol' },
  ),
  col(
    'pqvd_richtext',
    'Rich text',
    'memo',
    { type: 'memo', maxLength: 4000 },
    { catalog: 'dv.column.string.richtext', extras: { richText: true } },
  ),
  // Json format strings exist only on elastic (non-relational) tables: Dataverse rejects them here (recorded in the inventory as not applicable).
  col('pqvd_autonumber', 'Auto number', 'text', null, {
    catalog: 'dv.column.string.autonumber',
    extras: { kind: 'autonumber', format: 'BLI-{SEQNUM:5}', maxLength: 20 },
  }),
  col('pqvd_memo', 'Memo', 'memo', { type: 'memo', maxLength: 2000 }, { catalog: 'dv.column.memo' }),
  col(
    'pqvd_wholenumber',
    'Whole number',
    'integer',
    { type: 'integer', min: 0, max: 1000 },
    { catalog: 'dv.column.integer.none' },
  ),
  col('pqvd_duration', 'Duration', 'duration', null, {
    catalog: 'dv.column.integer.duration',
    extras: { kind: 'integer', format: 'Duration' },
  }),
  col('pqvd_timezone', 'Time zone', 'timezone', null, {
    catalog: 'dv.column.integer.timezone',
    extras: { kind: 'integer', format: 'TimeZone' },
  }),
  col('pqvd_language', 'Language', 'integer', null, {
    catalog: 'dv.column.integer.language',
    extras: { kind: 'integer', format: 'Language' },
  }),
  col('pqvd_locale', 'Locale', 'integer', null, {
    catalog: 'dv.column.integer.locale',
    extras: { kind: 'integer', format: 'Locale' },
  }),
  col(
    'pqvd_decimal',
    'Decimal',
    'decimal',
    { type: 'decimal', min: -1000, max: 1000, precision: 2 },
    { catalog: 'dv.column.decimal' },
  ),
  col(
    'pqvd_float',
    'Float',
    'double',
    { type: 'double', min: -100000, max: 100000, precision: 3 },
    { catalog: 'dv.column.double' },
  ),
  col(
    'pqvd_amount',
    'Amount',
    'money',
    { type: 'money', min: 0, max: 1000000, precision: 2 },
    { catalog: 'dv.column.money' },
  ),
  col('pqvd_bigint', 'Big integer', 'integer', null, { catalog: 'dv.column.bigint', extras: { kind: 'bigint' } }),
  col(
    'pqvd_datetime',
    'Date and time',
    'datetime',
    { type: 'datetime', behavior: 'UserLocal' },
    { catalog: 'dv.column.datetime.userlocal' },
  ),
  col(
    'pqvd_dateonly',
    'Date only',
    'datetime',
    { type: 'datetime', behavior: 'DateOnly' },
    { catalog: 'dv.column.datetime.dateonly' },
  ),
  col(
    'pqvd_datetimetzi',
    'Date time independent',
    'datetime',
    { type: 'datetime', behavior: 'TimeZoneIndependent' },
    { catalog: 'dv.column.datetime.tzindependent' },
  ),
  col('pqvd_dateonlyuserlocal', 'Date only user local', 'datetime', null, {
    catalog: 'dv.column.datetime.format',
    extras: { kind: 'datetime', behavior: 'UserLocal', format: 'DateOnly' },
  }),
  col('pqvd_localchoice', 'Local choice', 'picklist', null, {
    catalog: 'dv.column.choice.local',
    extras: {
      kind: 'localchoice',
      options: [
        ['Alpha', 1],
        ['Beta', 2],
        ['Gamma', 3],
      ],
      default: 2,
    },
  }),
  col(
    'pqvd_globalchoice',
    'Global choice',
    'picklist',
    { type: 'choice', choice: `${PREFIX}_baselinecolor`, default: 18327001 },
    { catalog: 'dv.column.choice.global' },
  ),
  col(
    'pqvd_multichoice',
    'Multi choice',
    'multiselect',
    { type: 'multichoice', choice: `${PREFIX}_baselinetag` },
    { catalog: 'dv.column.choices.multiselect' },
  ),
  col('pqvd_flag', 'Flag', 'boolean', { type: 'boolean', default: true }, { catalog: 'dv.column.boolean' }),
  col(
    'pqvd_flagcheckbox',
    'Flag checkbox',
    'checkbox',
    { type: 'boolean', default: false },
    { catalog: 'dv.column.boolean' },
  ),
  col(
    'pqvd_required',
    'Required',
    'text',
    { type: 'string', maxLength: 50, required: 'required' },
    { catalog: 'dv.state.required.applicationrequired' },
  ),
  col(
    'pqvd_recommended',
    'Recommended',
    'text',
    { type: 'string', maxLength: 50, required: 'recommended' },
    { catalog: 'dv.state.required.recommended' },
  ),
  col(
    'pqvd_readonly',
    'Read only',
    'text',
    { type: 'string', maxLength: 50 },
    { catalog: 'dv.state.form.disabled', form: { disabled: true } },
  ),
  col(
    'pqvd_hidden',
    'Hidden',
    'text',
    { type: 'string', maxLength: 50 },
    { catalog: 'dv.state.form.hidden', form: { visible: false } },
  ),
  col(
    'pqvd_nolabel',
    'No label',
    'text',
    { type: 'string', maxLength: 50 },
    { catalog: 'dv.state.form.label-hidden', form: { showlabel: false } },
  ),
  col(
    'pqvd_wide',
    'Wide',
    'text',
    { type: 'string', maxLength: 50 },
    { catalog: 'dv.formxml.cell', form: { colspan: 2 } },
  ),
  col(
    'pqvd_relabelled',
    'Relabelled',
    'text',
    { type: 'string', maxLength: 50 },
    { catalog: 'dv.formxml.label', form: { label: 'Form label override' } },
  ),
  col(
    'pqvd_hiddenbyrule',
    'Hidden by rule',
    'text',
    { type: 'string', maxLength: 50 },
    { catalog: 'dv.br.action.visibility' },
  ),
  col(
    'pqvd_lockedbyrule',
    'Locked by rule',
    'text',
    { type: 'string', maxLength: 50 },
    { catalog: 'dv.br.action.lock-unlock' },
  ),
  col(
    'pqvd_requiredbyrule',
    'Required by rule',
    'text',
    { type: 'string', maxLength: 50 },
    { catalog: 'dv.br.action.required' },
  ),
  col(
    'pqvd_defaultbyrule',
    'Default by rule',
    'text',
    { type: 'string', maxLength: 50 },
    { catalog: 'dv.br.action.set-default' },
  ),
  col(
    'pqvd_setbyrule',
    'Set by rule',
    'text',
    { type: 'string', maxLength: 50 },
    { catalog: 'dv.br.action.set-value' },
  ),
  col(
    'pqvd_ruleerror',
    'Rule error',
    'integer',
    { type: 'integer', min: 0, max: 100000 },
    { catalog: 'dv.br.action.show-error' },
  ),
  col(
    'pqvd_secret',
    'Secret',
    'text',
    { type: 'string', maxLength: 50 },
    { catalog: 'dv.state.secured', extras: { secured: true } },
  ),
  col('pqvd_notupdatable', 'Not updatable', 'text', null, {
    catalog: 'dv.state.valid-for',
    extras: { kind: 'string', maxLength: 50, isValidForUpdate: false },
  }),
  // Dataverse has no metadata default for whole numbers; default values are covered by the boolean (`flag`) and choice (`globalchoice`) columns.
  col(
    'pqvd_defaulted',
    'Defaulted',
    'integer',
    { type: 'integer', min: 0, max: 100 },
    {
      catalog: 'dv.column.integer.none',
      note: 'whole numbers carry no metadata default; the default-value state is exercised by pqvd_flag and pqvd_globalchoice',
    },
  ),
  // The calculated shell is created by script (SourceType 1); its formula is maker-portal only (manual step), and the platform stores MaxLength 4000 for it.
  col('pqvd_calculated', 'Calculated', 'text', null, {
    catalog: 'dv.column.calculated',
    extras: { kind: 'calculated', maxLength: 4000, manual: 'formula' },
  }),
  col('pqvd_formula', 'Formula', 'text', null, {
    catalog: 'dv.column.formula',
    extras: { kind: 'formula', maxLength: 200, formula: `Concatenate(${PREFIX}_name, " / ", ${PREFIX}_code)` },
  }),
  col('pqvd_file', 'File', 'file', null, { catalog: 'dv.column.file', extras: { kind: 'file', maxSizeKb: 1024 } }),
  // Placed only in the collapsed tab and the unlabelled section: a column placed twice renders once and the platform warns.
  col(
    'pqvd_collapsedtext',
    'Collapsed text',
    'text',
    { type: 'string', maxLength: 50 },
    { catalog: 'dv.column.string.text' },
  ),
  col(
    'pqvd_unlabelledtext',
    'Unlabelled text',
    'text',
    { type: 'string', maxLength: 50 },
    { catalog: 'dv.column.string.text' },
  ),
];
export const PARENT_COLUMNS = [
  col(
    'pqvd_code',
    'Code',
    'text',
    { type: 'string', maxLength: 20, required: 'required' },
    { catalog: 'dv.column.string.text' },
  ),
  col('pqvd_rank', 'Rank', 'integer', { type: 'integer', min: 0, max: 100 }, { catalog: 'dv.column.integer.none' }),
  col('pqvd_description', 'Description', 'memo', { type: 'memo', maxLength: 2000 }, { catalog: 'dv.column.memo' }),
  // Only on "Baseline Parent Reference": a parent column whose control id no item form repeats (the fixed insert multistep variant).
  col('pqvd_summary', 'Summary', 'text', { type: 'string', maxLength: 100 }, { catalog: 'dv.column.string.text' }),
  // Rollup definitions are maker-portal only (Dataverse rejected a scripted FormulaDefinition as "not valid Xaml"; Learn: not supported by code): created by the documented manual procedure, verified by the provisioning script.
  col('pqvd_rollup', 'Rollup', 'integer', null, {
    catalog: 'dv.column.rollup',
    extras: { kind: 'rollup', manual: true, related: ITEM, lookup: `${PREFIX}_parentid` },
  }),
];
export const CHILD_COLUMNS = [
  col('pqvd_note', 'Note', 'memo', { type: 'memo', maxLength: 2000 }, { catalog: 'dv.column.memo' }),
  col(
    'pqvd_sortorder',
    'Sort order',
    'integer',
    { type: 'integer', min: 0, max: 1000 },
    { catalog: 'dv.column.integer.none' },
  ),
];

// ---- Manifest
const manifestColumn = ({ name, label, manifest }) => ({ name, label, ...manifest });
export function manifest() {
  return {
    schemaVersion: 1,
    language: LCID,
    publisher: { uniqueName: 'Paqvilo', friendlyName: 'Paqvilo', prefix: PREFIX, optionValuePrefix: 18327 },
    solutions: [{ uniqueName: SOLUTION, friendlyName: 'Paqvilo baseline fixture', version: '1.0.0.0' }],
    choices: [
      {
        name: `${PREFIX}_baselinecolor`,
        label: 'Baseline color',
        solution: SOLUTION,
        options: [
          { value: 18327000, label: 'Red' },
          { value: 18327001, label: 'Green' },
          { value: 18327002, label: 'Blue' },
        ],
      },
      {
        name: `${PREFIX}_baselinetag`,
        label: 'Baseline tag',
        solution: SOLUTION,
        options: [
          { value: 18327010, label: 'North' },
          { value: 18327011, label: 'East' },
          { value: 18327012, label: 'South' },
          { value: 18327013, label: 'West' },
        ],
      },
    ],
    tables: [
      { name: 'account', existing: true, solution: SOLUTION, existingColumns: ['accountid'] },
      { name: 'contact', existing: true, solution: SOLUTION, existingColumns: ['contactid'] },
      {
        name: PARENT,
        schemaName: PARENT,
        entitySetName: `${PARENT}s`,
        label: 'Baseline Parent',
        pluralLabel: 'Baseline Parents',
        ownership: 'organization',
        notes: true,
        solution: SOLUTION,
        primaryName: { name: `${PREFIX}_name`, label: 'Name', maxLength: 100, required: 'required' },
        columns: PARENT_COLUMNS.filter((c) => c.manifest).map(manifestColumn),
        keys: [],
      },
      {
        name: ITEM,
        schemaName: ITEM,
        entitySetName: `${ITEM}s`,
        label: 'Baseline Item',
        pluralLabel: 'Baseline Items',
        ownership: 'user',
        notes: true,
        activities: true,
        solution: SOLUTION,
        primaryName: { name: `${PREFIX}_name`, label: 'Name', maxLength: 100, required: 'required' },
        columns: ITEM_COLUMNS.filter((c) => c.manifest).map(manifestColumn),
        keys: [{ name: `${PREFIX}_baselineitem_code`, label: 'Baseline item code', columns: [`${PREFIX}_code`] }],
      },
      {
        name: CHILD,
        schemaName: CHILD,
        entitySetName: `${CHILD}s`,
        label: 'Baseline Child',
        pluralLabel: 'Baseline Children',
        ownership: 'user',
        solution: SOLUTION,
        primaryName: { name: `${PREFIX}_name`, label: 'Name', maxLength: 100, required: 'required' },
        columns: CHILD_COLUMNS.filter((c) => c.manifest).map(manifestColumn),
        keys: [],
      },
    ],
    relationships: [
      {
        name: `${PREFIX}_baselineparent_baselineitem`,
        kind: 'oneToMany',
        parent: PARENT,
        child: ITEM,
        solution: SOLUTION,
        lookup: { name: `${PREFIX}_parentid`, label: 'Parent', required: 'recommended' },
        cascade: { Delete: 'RemoveLink' },
      },
      {
        name: `${PREFIX}_contact_baselineitem`,
        kind: 'oneToMany',
        parent: 'contact',
        child: ITEM,
        solution: SOLUTION,
        lookup: { name: `${PREFIX}_contactid`, label: 'Contact' },
        cascade: { Delete: 'RemoveLink', Merge: 'Cascade' },
      },
      {
        name: `${PREFIX}_account_baselineitem`,
        kind: 'oneToMany',
        parent: 'account',
        child: ITEM,
        solution: SOLUTION,
        lookup: { name: `${PREFIX}_accountid`, label: 'Account' },
        cascade: { Delete: 'RemoveLink', Merge: 'Cascade' },
      },
      {
        name: `${PREFIX}_baselineitem_baselinechild`,
        kind: 'oneToMany',
        parent: ITEM,
        child: CHILD,
        solution: SOLUTION,
        lookup: { name: `${PREFIX}_itemid`, label: 'Item', required: 'required' },
        cascade: { Delete: 'Cascade' },
      },
    ],
    // Forms and views are owned by provision.mjs (create or update); the manifest API would refuse
    // the whole apply on any later layout change ("drift"), which iteration needs.
    forms: [],
    views: [],
  };
}

// ---- FormXml builder
const label = (text) => `<labels><label description="${escape(text)}" languagecode="${LCID}" /></labels>`;
function cell(
  field,
  kind,
  {
    showlabel = true,
    colspan,
    rowspan,
    label: text,
    disabled = false,
    visible = true,
    control: extraControl = '',
    id,
  } = {},
) {
  const attrs = [
    `id="${braced(`cell:${id ?? field}`)}"`,
    `showlabel="${showlabel}"`,
    colspan ? `colspan="${colspan}"` : '',
    rowspan ? `rowspan="${rowspan}"` : '',
    visible ? '' : `visible="false"`,
  ]
    .filter(Boolean)
    .join(' ');
  const control =
    extraControl ||
    `<control id="${field}" classid="${CLASSIDS[kind]}" datafieldname="${field}" disabled="${disabled}" />`;
  return `<cell ${attrs}>${label(text ?? field)}${control}</cell>`;
}
const columnCell = (column, table) =>
  cell(column.name, column.form?.kind ?? column.kind, {
    ...(column.form ?? {}),
    label: column.form?.label ?? column.label,
    id: `${table}:${column.name}`,
  });
function section(name, title, cells, { columns = 1, showlabel = true, visible = true, labelwidth = 115 } = {}) {
  // Multi-column sections place `columns` cells per row; a cell that spans the row stands alone.
  const rows = [];
  let row = [];
  for (const item of cells) {
    const spans = /colspan="(\d+)"/.exec(item)?.[1];
    const width = spans ? Number(spans) : 1;
    if (width >= columns || row.length + width > columns) {
      if (row.length) rows.push(row);
      row = [];
    }
    row.push(item);
    if (row.reduce((sum, c) => sum + Number(/colspan="(\d+)"/.exec(c)?.[1] ?? 1), 0) >= columns) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length) rows.push(row);
  return `<section name="${name}" id="${braced(`section:${name}`)}" showlabel="${showlabel}" showbar="false" columns="${'1'.repeat(columns)}" layout="varwidth" celllabelposition="Top" labelwidth="${labelwidth}"${visible ? '' : ' visible="false"'}>${label(title)}<rows>${rows.map((items) => `<row>${items.join('')}</row>`).join('')}</rows></section>`;
}
function tab(name, title, sections, { expanded = true, visible = true, showlabel = true } = {}) {
  return `<tab name="${name}" id="${braced(`tab:${name}`)}" IsUserDefined="1" showlabel="${showlabel}" expanded="${expanded}"${visible ? '' : ' visible="false"'}>${label(title)}<columns><column width="100%"><sections>${sections.join('')}</sections></column></columns></tab>`;
}
const form = (tabs, { showImage = false } = {}) =>
  `<form showImage="${showImage}"><tabs>${tabs.join('')}</tabs></form>`;
const subgridControl = (id, table, relationship, viewId, { quickFind = true } = {}) =>
  `<control id="${id}" classid="${CLASSIDS.subgrid}"><parameters><ViewId>${viewId}</ViewId><IsUserView>false</IsUserView><RelationshipName>${relationship}</RelationshipName><TargetEntityType>${table}</TargetEntityType><AutoExpand>Fixed</AutoExpand><EnableQuickFind>${quickFind}</EnableQuickFind><EnableViewPicker>false</EnableViewPicker><ViewIds>${viewId}</ViewIds><EnableChartPicker>false</EnableChartPicker><RecordsPerPage>4</RecordsPerPage></parameters></control>`;
// The QuickForms parameter carries XML-escaped text (as the form designer stores it), ids without braces.
const quickViewControl = (id, field, table, formId) =>
  `<control id="${id}" classid="${CLASSIDS.quickview}" datafieldname="${field}" disabled="false"><parameters><QuickForms>${escape(`<QuickFormIds><QuickFormId entityname="${table}">${formId.replace(/[{}]/g, '').toLowerCase()}</QuickFormId></QuickFormIds>`)}</QuickForms><ControlMode>Edit</ControlMode></parameters></control>`;
const notesControl = `<control id="notescontrol" classid="${CLASSIDS.notes}" disabled="false" />`;
const webResourceControl = `<control id="WebResource_baseline" classid="${CLASSIDS.webresource}"><parameters><Url>pqvd_baseline_banner.html</Url><PassParameters>false</PassParameters><Security>false</Security><Scrolling>auto</Scrolling><Border>false</Border><ShowOnMobileClient>false</ShowOnMobileClient></parameters></control>`;
// Static, script-free document with a visible heading so captures show where it rendered.
export const BANNER_HTML =
  '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Baseline banner</title></head><body><h2 class="baseline-banner">Baseline web resource</h2><p>Static HTML web resource of the baseline fixture.</p></body></html>';
const iframeControl = `<control id="IFRAME_baseline" classid="${CLASSIDS.iframe}"><parameters><Url>about:blank</Url><PassParameters>false</PassParameters><Security>true</Security><Scrolling>auto</Scrolling><Border>true</Border><ShowOnMobileClient>false</ShowOnMobileClient></parameters></control>`;

const byName = (columns, ...names) => names.map((name) => columns.find((c) => c.name === `${PREFIX}_${name}`));
const NAME = `${PREFIX}_name`;

// quickView false: the stepped insert form. A quick view needs a saved record, and on an insert form with
// generated steps the platform throws at its cell after the step postback; the edit forms keep it.
function itemMainForm({ quickView = true } = {}) {
  const c = (name) => byName(ITEM_COLUMNS, name)[0];
  const identity = [
    cell(NAME, 'text', { label: 'Name' }),
    columnCell(c('code'), ITEM),
    cell(c('autonumber').name, 'text', { label: 'Auto number', disabled: true }),
    cell(`${PREFIX}_parentid`, 'lookup', { label: 'Parent' }),
    cell(`${PREFIX}_contactid`, 'lookup', { label: 'Contact' }),
    cell(`${PREFIX}_accountid`, 'lookup', { label: 'Account' }),
    cell(`${PREFIX}_customerid`, 'lookup', { label: 'Customer' }),
    cell(`${PREFIX}_anyid`, 'polymorphic', { label: 'Any record' }),
    cell('ownerid', 'lookup', { label: 'Owner' }),
  ];
  const text = ['text', 'textarea', 'email', 'url', 'phone', 'ticker', 'richtext', 'memo'].map((name) =>
    columnCell(c(name), ITEM),
  );
  const numbers = [
    ...['wholenumber', 'duration', 'timezone', 'language', 'locale', 'decimal', 'float', 'amount', 'bigint'].map(
      (name) => columnCell(c(name), ITEM),
    ),
    cell('transactioncurrencyid', 'lookup', { label: 'Currency' }),
  ];
  const dates = ['datetime', 'dateonly', 'datetimetzi', 'dateonlyuserlocal'].map((name) => columnCell(c(name), ITEM));
  const choices = [
    ...['localchoice', 'globalchoice', 'multichoice', 'flag', 'flagcheckbox'].map((name) => columnCell(c(name), ITEM)),
    cell('statuscode', 'status', { label: 'Status reason' }),
    cell('statecode', 'picklist', { label: 'Status' }),
  ];
  const states = [
    'required',
    'recommended',
    'readonly',
    'hidden',
    'nolabel',
    'wide',
    'relabelled',
    'hiddenbyrule',
    'lockedbyrule',
    'requiredbyrule',
    'defaultbyrule',
    'setbyrule',
    'ruleerror',
    'secret',
    'notupdatable',
    'defaulted',
    'calculated',
    'formula',
  ].map((name) => columnCell(c(name), ITEM));
  const files = [cell('entityimage', 'image', { label: 'Image' }), columnCell(c('file'), ITEM)];
  const related = [
    `<cell id="${braced('cell:subgrid-children')}" showlabel="true" rowspan="6">${label('Children')}${subgridControl('subgrid_children', CHILD, `${PREFIX}_baselineitem_baselinechild`, '{PLATFORM_VIEW:pqvd_baselinechild:2}')}</cell>`,
    ...(quickView
      ? [
          `<cell id="${braced('cell:quickview-parent')}" showlabel="true">${label('Parent details')}${quickViewControl('quickview_parent', `${PREFIX}_parentid`, PARENT, braced('form:parent-quick-view'))}</cell>`,
        ]
      : []),
    `<cell id="${braced('cell:notes')}" showlabel="false" rowspan="6">${label('Notes')}${notesControl}</cell>`,
    `<cell id="${braced('cell:webresource')}" showlabel="true" rowspan="2">${label('Web resource')}${webResourceControl}</cell>`,
    `<cell id="${braced('cell:iframe')}" showlabel="true" rowspan="4">${label('Iframe')}${iframeControl}</cell>`,
    // A spacer is a cell without a control (no exported form in the environment carries a spacer control element).
    `<cell id="${braced('cell:spacer')}" showlabel="false" userspacer="true">${label('Spacer')}</cell>`,
  ];
  return form([
    tab('general', 'General', [
      section('identity', 'Identity', identity, { columns: 2 }),
      section('text', 'Text', text),
      section('numbers', 'Numbers', numbers, { columns: 2 }),
      section('dates', 'Dates', dates, { columns: 2 }),
      section('choices', 'Choices', choices, { columns: 2 }),
      section('states', 'States', states, { columns: 2 }),
      section('files', 'Files', files),
      section(
        'hiddensection',
        'Hidden section',
        [cell(c('text').name, 'text', { label: 'Text again (hidden section)', id: 'hiddensection:text' })],
        { visible: false },
      ),
      section('unlabelled', 'Unlabelled section', [columnCell(c('unlabelledtext'), ITEM)], { showlabel: false }),
    ]),
    tab('related', 'Related', [section('related', 'Related records', related)]),
    tab('collapsed', 'Collapsed tab', [section('collapsed', 'Collapsed', [columnCell(c('collapsedtext'), ITEM)])], {
      expanded: false,
    }),
    tab(
      'hiddentab',
      'Hidden tab',
      [
        section('hiddentab', 'Hidden', [
          cell(c('email').name, 'email', { label: 'Email again', id: 'hiddentab:email' }),
        ]),
      ],
      { visible: false },
    ),
  ]);
}
function itemCompactForm() {
  const c = (name) => byName(ITEM_COLUMNS, name)[0];
  return form([
    tab('step1', 'Step one', [
      section('step1', 'Step one', [
        cell(NAME, 'text', { label: 'Name' }),
        columnCell(c('code'), ITEM),
        columnCell(c('text'), ITEM),
        columnCell(c('globalchoice'), ITEM),
      ]),
    ]),
    tab('step2', 'Step two', [
      section('step2', 'Step two', [
        columnCell(c('wholenumber'), ITEM),
        columnCell(c('datetime'), ITEM),
        columnCell(c('flag'), ITEM),
        cell(`${PREFIX}_parentid`, 'lookup', { label: 'Parent' }),
      ]),
    ]),
  ]);
}
function itemLookupCreateForm() {
  const c = (name) => byName(ITEM_COLUMNS, name)[0];
  return form([
    tab('create', 'Create', [
      section('create', 'Create', [
        cell(NAME, 'text', { label: 'Name' }),
        columnCell(c('code'), ITEM),
        columnCell(c('required'), ITEM),
      ]),
    ]),
  ]);
}
function parentMainForm() {
  const c = (name) => byName(PARENT_COLUMNS, name)[0];
  const rows = [
    cell(NAME, 'text', { label: 'Name' }),
    columnCell(c('code'), PARENT),
    columnCell(c('rank'), PARENT),
    columnCell(c('description'), PARENT),
  ]; // the rollup column joins the form after the manual maker-portal step
  const items = [
    `<cell id="${braced('cell:subgrid-items')}" showlabel="true" rowspan="8">${label('Items')}${subgridControl('subgrid_items', ITEM, `${PREFIX}_baselineparent_baselineitem`, '{PLATFORM_VIEW:pqvd_baselineitem:2}')}</cell>`,
  ];
  return form([tab('general', 'General', [section('general', 'General', rows), section('items', 'Items', items)])]);
}
// Read-only reference form of the fixed insert multistep: a multistep step renders it beside the item create form,
// so it carries no column whose control id the create form repeats (pqvd_name, pqvd_code, ...).
function parentReferenceForm() {
  const c = (name) => byName(PARENT_COLUMNS, name)[0];
  return form([
    tab('reference', 'Reference', [section('reference', 'Parent reference', [columnCell(c('summary'), PARENT)])]),
  ]);
}
function parentQuickViewForm() {
  const c = (name) => byName(PARENT_COLUMNS, name)[0];
  return form([
    tab('quick', 'Quick view', [
      section('quick', 'Quick view', [
        cell(NAME, 'text', { label: 'Name' }),
        columnCell(c('code'), PARENT),
        columnCell(c('rank'), PARENT),
      ]),
    ]),
  ]);
}
function cardForm(table) {
  // Card forms need exactly four sections; the first (color strip) accepts only two-option, choice or status reason columns.
  const fields =
    table === ITEM
      ? [
          ['statuscode', 'status', 'Status reason'],
          [NAME, 'text', 'Name'],
          [p('code'), 'text', 'Code'],
          [p('text'), 'text', 'Text'],
        ]
      : [
          ['statuscode', 'status', 'Status reason'],
          [NAME, 'text', 'Name'],
          [p('code'), 'text', 'Code'],
          [p('rank'), 'integer', 'Rank'],
        ];
  const names = ['ColorStrip', 'CardHeader', 'CardDetails', 'CardFooter'];
  const sections = fields.map(([field, kind, text], index) =>
    section(
      `card:${table}:${names[index]}`,
      names[index],
      [cell(field, kind, { label: text, id: `card:${table}:${field}` })],
      { showlabel: false },
    ),
  );
  return `<form showImage="false"><tabs><tab name="card" id="${braced(`tab:card:${table}`)}" IsUserDefined="1" showlabel="false" expanded="true">${label('Card')}<columns><column width="100%"><sections>${sections.join('')}</sections></column></columns></tab></tabs></form>`;
}
function childMainForm() {
  const c = (name) => byName(CHILD_COLUMNS, name)[0];
  return form([
    tab('general', 'General', [
      section('general', 'General', [
        cell(NAME, 'text', { label: 'Name' }),
        cell(`${PREFIX}_itemid`, 'lookup', { label: 'Item' }),
        columnCell(c('note'), CHILD),
        columnCell(c('sortorder'), CHILD),
      ]),
    ]),
  ]);
}

export const FORMS = [
  { file: 'item-main', id: guid('form:item-main'), table: ITEM, name: 'Baseline Item', type: 2, build: itemMainForm },
  {
    file: 'item-steps',
    id: guid('form:item-steps'),
    table: ITEM,
    name: 'Baseline Item Steps',
    type: 2,
    build: () => itemMainForm({ quickView: false }),
  },
  {
    file: 'item-compact',
    id: guid('form:item-compact'),
    table: ITEM,
    name: 'Baseline Item Compact',
    type: 2,
    build: itemCompactForm,
  },
  {
    file: 'item-lookup-create',
    id: guid('form:item-lookup-create'),
    table: ITEM,
    name: 'Baseline Item Lookup Create',
    type: 2,
    build: itemLookupCreateForm,
  },
  {
    file: 'item-card',
    id: guid('form:item-card'),
    table: ITEM,
    name: 'Baseline Item Card',
    type: 11,
    build: () => cardForm(ITEM),
  },
  {
    file: 'parent-main',
    id: guid('form:parent-main'),
    table: PARENT,
    name: 'Baseline Parent',
    type: 2,
    build: parentMainForm,
  },
  {
    file: 'parent-card',
    id: guid('form:parent-card'),
    table: PARENT,
    name: 'Baseline Parent',
    type: 11,
    build: () => cardForm(PARENT),
  },
  {
    file: 'parent-reference',
    id: guid('form:parent-reference'),
    table: PARENT,
    name: 'Baseline Parent Reference',
    type: 2,
    build: parentReferenceForm,
  },
  {
    file: 'parent-quick-view',
    id: guid('form:parent-quick-view'),
    table: PARENT,
    name: 'Baseline Parent Quick View',
    type: 6,
    build: parentQuickViewForm,
  },
  {
    file: 'child-main',
    id: guid('form:child-main'),
    table: CHILD,
    name: 'Baseline Child',
    type: 2,
    build: childMainForm,
  },
];

// ---- Views
function fetch(table, { attributes, order = [], filter = '', links = '', distinct = false }) {
  const attrs = attributes.map((name) => `<attribute name="${name}" />`).join('');
  const orders = order.map(([name, desc]) => `<order attribute="${name}" descending="${desc}" />`).join('');
  return `<fetch version="1.0" output-format="xml-platform" mapping="logical" distinct="${distinct}"><entity name="${table}">${attrs}${orders}${filter}${links}</entity></fetch>`;
}
function layout(table, cells, { jump = NAME, preview = '1', icon = '1' } = {}) {
  // `object` is the table's object type code, assigned by the environment; provision.mjs resolves the token.
  return `<grid name="resultset" object="{OBJECT_TYPE_CODE:${table}}" jump="${jump}" select="1" icon="${icon}" preview="${preview}"><row name="result" id="${table}id">${cells.map(([name, width]) => `<cell name="${name}" width="${width}" />`).join('')}</row></grid>`;
}
const active = `<filter type="and"><condition attribute="statecode" operator="eq" value="0" /></filter>`;
const inactive = `<filter type="and"><condition attribute="statecode" operator="eq" value="1" /></filter>`;
const p = (name) => `${PREFIX}_${name}`;
const itemColumns = [
  [NAME, 200],
  [p('code'), 100],
  [p('wholenumber'), 100],
  [p('decimal'), 100],
  [p('datetime'), 150],
  [p('globalchoice'), 100],
  [p('parentid'), 150],
  [p('flag'), 80],
  [p('multichoice'), 150],
  ['createdon', 125],
];
export const VIEWS = [
  {
    file: 'item-active',
    id: guid('view:item-active'),
    table: ITEM,
    name: 'Active Baseline Items',
    queryType: 0,
    isDefault: true,
    fetch: () =>
      fetch(ITEM, {
        attributes: [`${ITEM}id`, ...itemColumns.map(([n]) => n)],
        order: [[NAME, 'false']],
        filter: active,
      }),
    layout: () => layout(ITEM, itemColumns),
  },
  {
    file: 'item-inactive',
    id: guid('view:item-inactive'),
    table: ITEM,
    name: 'Inactive Baseline Items',
    queryType: 0,
    fetch: () =>
      fetch(ITEM, {
        attributes: [`${ITEM}id`, NAME, p('code'), 'modifiedon'],
        order: [['modifiedon', 'true']],
        filter: inactive,
      }),
    layout: () =>
      layout(ITEM, [
        [NAME, 200],
        [p('code'), 100],
        ['modifiedon', 125],
      ]),
  },
  {
    file: 'item-all',
    id: guid('view:item-all'),
    table: ITEM,
    name: 'All Baseline Items',
    queryType: 0,
    fetch: () =>
      fetch(ITEM, {
        attributes: [
          `${ITEM}id`,
          NAME,
          p('code'),
          p('amount'),
          p('dateonly'),
          p('localchoice'),
          'statecode',
          'statuscode',
          'ownerid',
        ],
        order: [[p('code'), 'true']],
      }),
    layout: () =>
      layout(ITEM, [
        [NAME, 200],
        [p('code'), 100],
        [p('amount'), 100],
        [p('dateonly'), 100],
        [p('localchoice'), 100],
        ['statecode', 100],
        ['statuscode', 100],
        ['ownerid', 150],
      ]),
  },
  {
    file: 'item-by-parent',
    id: guid('view:item-by-parent'),
    table: ITEM,
    name: 'Baseline Items by Parent',
    queryType: 0,
    fetch: () =>
      fetch(ITEM, {
        attributes: [`${ITEM}id`, NAME, p('code'), p('parentid')],
        order: [[NAME, 'false']],
        filter: active,
        links: `<link-entity name="${PARENT}" from="${PARENT}id" to="${p('parentid')}" link-type="outer" alias="parent"><attribute name="${p('code')}" /><attribute name="${p('rank')}" /></link-entity>`,
      }),
    layout: () =>
      layout(ITEM, [
        [NAME, 200],
        [p('code'), 100],
        [p('parentid'), 150],
        [`parent.${p('code')}`, 100],
        [`parent.${p('rank')}`, 80],
      ]),
  },
  {
    file: 'parent-active',
    id: guid('view:parent-active'),
    table: PARENT,
    name: 'Active Baseline Parents',
    queryType: 0,
    isDefault: true,
    fetch: () =>
      fetch(PARENT, {
        attributes: [`${PARENT}id`, NAME, p('code'), p('rank')],
        order: [
          [p('rank'), 'false'],
          [NAME, 'false'],
        ],
        filter: active,
      }),
    layout: () =>
      layout(PARENT, [
        [NAME, 200],
        [p('code'), 100],
        [p('rank'), 80],
      ]),
  },
  {
    file: 'child-active',
    id: guid('view:child-active'),
    table: CHILD,
    name: 'Active Baseline Children',
    queryType: 0,
    isDefault: true,
    fetch: () =>
      fetch(CHILD, {
        attributes: [`${CHILD}id`, NAME, p('sortorder'), p('itemid')],
        order: [[p('sortorder'), 'false']],
        filter: active,
      }),
    layout: () =>
      layout(CHILD, [
        [NAME, 200],
        [p('sortorder'), 80],
        [p('itemid'), 150],
      ]),
  },
];

// Dataverse creates one Quick Find (4), Lookup (64) and Associated (2) view per table; Learn documents new
// views as public (0). The fixture adjusts the platform views' definitions instead of adding rivals.
// Quick Find definitions cannot be updated through the record API on this environment (toolkit note in
// docs/dataverse-provisioning.md), so the platform default is retained and recorded.
export const PLATFORM_VIEW_ADJUSTMENTS = [
  {
    file: 'item-quick-find',
    id: guid('view:item-quick-find'),
    table: ITEM,
    name: 'Baseline Item Quick Find',
    queryType: 4,
    isQuickFind: true,
    fetch: () =>
      fetch(ITEM, {
        attributes: [`${ITEM}id`, NAME, p('code'), p('text')],
        order: [[NAME, 'false']],
        filter: `<filter type="and"><condition attribute="statecode" operator="eq" value="0" /></filter><filter type="or" isquickfindfields="1"><condition attribute="${NAME}" operator="like" value="{0}" /><condition attribute="${p('code')}" operator="like" value="{0}" /><condition attribute="${p('text')}" operator="like" value="{0}" /></filter>`,
      }),
    layout: () =>
      layout(ITEM, [
        [NAME, 200],
        [p('code'), 100],
        [p('text'), 150],
      ]),
  },
  {
    file: 'item-lookup',
    id: guid('view:item-lookup'),
    table: ITEM,
    name: 'Baseline Item Lookup View',
    queryType: 64,
    fetch: () => fetch(ITEM, { attributes: [`${ITEM}id`, NAME, p('code')], order: [[NAME, 'false']], filter: active }),
    layout: () =>
      layout(ITEM, [
        [NAME, 200],
        [p('code'), 100],
      ]),
  },
  {
    file: 'item-associated',
    id: guid('view:item-associated'),
    table: ITEM,
    name: 'Baseline Item Associated View',
    queryType: 2,
    fetch: () =>
      fetch(ITEM, { attributes: [`${ITEM}id`, NAME, p('code'), p('wholenumber')], order: [[p('code'), 'false']] }),
    layout: () =>
      layout(ITEM, [
        [NAME, 200],
        [p('code'), 100],
        [p('wholenumber'), 100],
      ]),
  },
  {
    file: 'parent-quick-find',
    id: guid('view:parent-quick-find'),
    table: PARENT,
    name: 'Baseline Parent Quick Find',
    queryType: 4,
    isQuickFind: true,
    fetch: () =>
      fetch(PARENT, {
        attributes: [`${PARENT}id`, NAME, p('code')],
        order: [[NAME, 'false']],
        filter: `<filter type="or" isquickfindfields="1"><condition attribute="${NAME}" operator="like" value="{0}" /><condition attribute="${p('code')}" operator="like" value="{0}" /></filter>`,
      }),
    layout: () =>
      layout(PARENT, [
        [NAME, 200],
        [p('code'), 100],
      ]),
  },
  {
    file: 'parent-lookup',
    id: guid('view:parent-lookup'),
    table: PARENT,
    name: 'Baseline Parent Lookup View',
    queryType: 64,
    fetch: () =>
      fetch(PARENT, {
        attributes: [`${PARENT}id`, NAME, p('code'), p('rank')],
        order: [[NAME, 'false']],
        filter: active,
      }),
    layout: () =>
      layout(PARENT, [
        [NAME, 200],
        [p('code'), 100],
        [p('rank'), 80],
      ]),
  },
  {
    file: 'child-associated',
    id: guid('view:child-associated'),
    table: CHILD,
    name: 'Baseline Child Associated View',
    queryType: 2,
    fetch: () =>
      fetch(CHILD, { attributes: [`${CHILD}id`, NAME, p('sortorder'), p('note')], order: [[p('sortorder'), 'false']] }),
    layout: () =>
      layout(CHILD, [
        [NAME, 200],
        [p('sortorder'), 80],
        [p('note'), 200],
      ]),
  },
  {
    file: 'child-quick-find',
    id: guid('view:child-quick-find'),
    table: CHILD,
    name: 'Baseline Child Quick Find',
    queryType: 4,
    isQuickFind: true,
    fetch: () =>
      fetch(CHILD, {
        attributes: [`${CHILD}id`, NAME, p('sortorder')],
        order: [[NAME, 'false']],
        filter: `<filter type="or" isquickfindfields="1"><condition attribute="${NAME}" operator="like" value="{0}" /></filter>`,
      }),
    layout: () =>
      layout(CHILD, [
        [NAME, 200],
        [p('sortorder'), 80],
      ]),
  },
];

// ---- Extras: everything the manifest API does not model, applied by provision.mjs after the manifest.
export function extras() {
  const columns = [];
  for (const [table, list] of [
    [ITEM, ITEM_COLUMNS],
    [PARENT, PARENT_COLUMNS],
  ])
    for (const column of list)
      if (column.extras)
        columns.push({
          table,
          name: column.name,
          label: column.label,
          ...column.extras,
          viaManifest: Boolean(column.manifest),
        });
  return {
    version: 1,
    solution: SOLUTION,
    columns,
    forms: FORMS.map((form) => ({
      id: form.id,
      table: form.table,
      name: form.name,
      type: form.type ?? 2,
      file: `formxml/${form.file}.xml`,
    })),
    views: VIEWS.map((view) => ({
      id: view.id,
      table: view.table,
      name: view.name,
      queryType: view.queryType ?? 0,
      fetchFile: `views/${view.file}.fetch.xml`,
      layoutFile: `views/${view.file}.layout.xml`,
      isDefault: Boolean(view.isDefault),
      isQuickFind: false,
    })),
    platformViewAdjustments: PLATFORM_VIEW_ADJUSTMENTS.map((view) => ({
      table: view.table,
      queryType: view.queryType,
      ...(view.queryType === 4
        ? { retainDefault: true }
        : { fetchFile: `views/${view.file}.fetch.xml`, layoutFile: `views/${view.file}.layout.xml` }),
      retiredFixtureViewId: view.id,
    })),
    customerLookup: {
      table: ITEM,
      name: `${PREFIX}_customerid`,
      label: 'Customer',
      relationships: {
        account: `${PREFIX}_account_baselineitem_customer`,
        contact: `${PREFIX}_contact_baselineitem_customer`,
      },
    },
    polymorphicLookup: {
      table: ITEM,
      name: `${PREFIX}_anyid`,
      label: 'Any record',
      targets: [PARENT, 'account'],
      relationships: {
        [PARENT]: `${PREFIX}_baselineparent_baselineitem_any`,
        account: `${PREFIX}_account_baselineitem_any`,
      },
    },
    image: { table: ITEM, schemaName: 'EntityImage', maxSizeKb: 1024 },
    statusReasons: {
      [ITEM]: [
        { state: 0, value: 18327020, label: 'Reviewed' },
        { state: 1, value: 18327021, label: 'Archived' },
      ],
    },
    defaultViews: VIEWS.filter((view) => view.isDefault).map((view) => ({ id: view.id, table: view.table })),
    // Rule schema: { id, table, name, scope: "entity" | "all-forms" | "form", formId? (scope "form"), when: { field, equals | greaterThan | isNull },
    // guard?: { field, notEqual | notNull } (ANDed with when), actions[], otherwise? }. when.field is the rule's only trigger.
    // The rules run as background workflows on live (mode 0) and each write sends the whole record image, which re-triggers
    // every rule on its fields: a rule that writes must no-op once its target holds the value, hence the guards.
    // Action types: visibility, lock, required, setValue, setDefault, clearValue, error.
    businessRules: [
      {
        id: guid('br:hide-by-flag'),
        table: ITEM,
        name: 'Baseline hide by flag',
        scope: 'entity',
        when: { field: p('flag'), equals: false },
        actions: [{ type: 'visibility', field: p('hiddenbyrule'), visible: false }],
        otherwise: [{ type: 'visibility', field: p('hiddenbyrule'), visible: true }],
      },
      {
        id: guid('br:lock-by-flag'),
        table: ITEM,
        name: 'Baseline lock by flag',
        scope: 'entity',
        when: { field: p('flag'), equals: true },
        actions: [{ type: 'lock', field: p('lockedbyrule'), locked: true }],
        otherwise: [{ type: 'lock', field: p('lockedbyrule'), locked: false }],
      },
      {
        id: guid('br:require-by-text'),
        table: ITEM,
        name: 'Baseline require by text',
        scope: 'entity',
        when: { field: p('text'), equals: 'require' },
        actions: [{ type: 'required', field: p('requiredbyrule'), required: true }],
        otherwise: [{ type: 'required', field: p('requiredbyrule'), required: false }],
      },
      {
        id: guid('br:default-value'),
        table: ITEM,
        name: 'Baseline default value',
        scope: 'entity',
        when: { field: p('defaultbyrule'), isNull: true },
        actions: [{ type: 'setDefault', field: p('defaultbyrule'), value: 'rule default' }],
      },
      {
        id: guid('br:set-value'),
        table: ITEM,
        name: 'Baseline set value',
        scope: 'entity',
        when: { field: p('flag'), equals: true },
        guard: { field: p('setbyrule'), notEqual: 'set by rule' },
        actions: [{ type: 'setValue', field: p('setbyrule'), value: 'set by rule' }],
      },
      {
        id: guid('br:show-error'),
        table: ITEM,
        name: 'Baseline show error',
        scope: 'entity',
        when: { field: p('ruleerror'), greaterThan: 500 },
        actions: [{ type: 'error', field: p('ruleerror'), message: 'Rule error must be 500 or less' }],
      },
      {
        id: guid('br:clear-value'),
        table: ITEM,
        name: 'Baseline clear value',
        scope: 'entity',
        when: { field: p('flag'), equals: false },
        guard: { field: p('setbyrule'), notNull: true },
        actions: [{ type: 'clearValue', field: p('setbyrule') }],
      },
      {
        id: guid('br:all-forms-scope'),
        table: ITEM,
        name: 'Baseline all forms scope',
        scope: 'all-forms',
        when: { field: p('text'), equals: 'all-forms' },
        actions: [{ type: 'required', field: p('recommended'), required: true }],
      },
      {
        id: guid('br:form-scope'),
        table: ITEM,
        name: 'Baseline form scope',
        scope: 'form',
        formId: guid('form:item-main'),
        when: { field: p('text'), equals: 'form-scope' },
        actions: [{ type: 'visibility', field: p('recommended'), visible: false }],
      },
    ],
    columnSecurityProfile: {
      name: 'Paqvilo baseline secured columns',
      columns: [{ table: ITEM, name: p('secret'), read: 0, update: 0, create: 0 }],
    },
    // A fixture-owned web resource so the form's web resource control has no dependency outside the solution.
    // HTML (type 1): "Render Web Resources Inline" embeds the resource's content, which only an HTML resource has; an image
    // control is never created inline and its label association throws. Plain forms frame the same resource.
    // Predecessors are deleted by provision.mjs once the published form stops naming them.
    webResource: {
      name: 'pqvd_baseline_banner.html',
      displayName: 'Baseline banner',
      type: 1,
      content: Buffer.from(BANNER_HTML, 'utf8').toString('base64'),
      retire: ['pqvd_baseline_icon.png', 'pqvd_baseline_icon.svg'],
    },
    // The three fixture tables are exported with every subcomponent so the solution is self-contained.
    includeAllSubcomponents: [PARENT, ITEM, CHILD],
    // Platform components of non-fixture tables the site renders: added to the solution as-is (AddSolutionComponent only,
    // never modified) so the export carries them. Ids are the platform's own; provision.mjs checks name and table.
    // Not here: the managed Contact main form 1fed44d1-ae68-4a41-bd2b-f13acac4acfa (adx_formname Contact). ExportSolution
    // omits an unmodified managed form and lists it as a MissingDependency, so membership alone cannot export it.
    platformComponents: [
      {
        type: 26,
        table: 'contact',
        id: 'a2d479c5-53e3-4c69-addd-802327e67a0d',
        name: 'Contacts Lookup View',
        reason: "default lookup view of the item form's contact and customer lookups",
      },
      {
        type: 26,
        table: 'account',
        id: 'a9af0ab8-861d-4cfa-92a5-c6281fed7fab',
        name: 'Account Lookup View',
        reason: "default lookup view of the item form's account, customer and any-record lookups",
      },
      // Columns of those lookup views (type 2, resolved by logical name): the export then carries their attribute metadata.
      ...Object.entries({
        contact: [
          'contactid',
          'fullname',
          'emailaddress1',
          'telephone1',
          'parentcustomerid',
          'address1_city',
          'address1_telephone1',
          'statecode',
          'statuscode',
        ],
        account: [
          'accountid',
          'name',
          'emailaddress1',
          'telephone1',
          'accountnumber',
          'primarycontactid',
          'address1_city',
          'statecode',
          'statuscode',
        ],
      }).flatMap(([table, names]) =>
        names.map((name) => ({ type: 2, table, name, reason: `${table} lookup view column` })),
      ),
      // Columns bound on the platform Contact main form (1fed44d1…, read by the project's platform-components.mjs) beyond those above.
      // Not here: msdyn_designation, msdynce_bankbranch, msdynce_selectedspecialties, msdynce_specialties, msdynce_specialtiescategory.
      // Their base layer is the managed app PowerPages_BookMeetingSalesRep_V2, so the export lists them as non-System MissingDependency.
      ...[
        'address1_composite',
        'address1_freighttermscode',
        'address1_shippingmethodcode',
        'anniversary',
        'birthdate',
        'creditlimit',
        'creditonhold',
        'description',
        'donotbulkemail',
        'donotemail',
        'donotfax',
        'donotphone',
        'donotpostalmail',
        'familystatuscode',
        'fax',
        'followemail',
        'gendercode',
        'jobtitle',
        'mobilephone',
        'ownerid',
        'paymenttermscode',
        'preferredcontactmethodcode',
        'spousesname',
        'transactioncurrencyid',
      ].map((name) => ({ type: 2, table: 'contact', name, reason: 'contact main form column' })),
    ],
  };
}

async function main() {
  const out = (relative) => path.join(root, relative);
  await fs.mkdir(out('dataverse/formxml'), { recursive: true });
  await fs.mkdir(out('dataverse/views'), { recursive: true });
  const m = manifest();
  await fs.writeFile(out('dataverse/manifest.json'), JSON.stringify(m, null, 2) + '\n');
  for (const item of FORMS) await fs.writeFile(out(`dataverse/formxml/${item.file}.xml`), item.build() + '\n');
  for (const view of [...VIEWS, ...PLATFORM_VIEW_ADJUSTMENTS].filter((view) => view.queryType !== 4)) {
    await fs.writeFile(out(`dataverse/views/${view.file}.fetch.xml`), view.fetch() + '\n');
    await fs.writeFile(out(`dataverse/views/${view.file}.layout.xml`), view.layout() + '\n');
  }
  await fs.writeFile(out('dataverse/extras.json'), JSON.stringify(extras(), null, 2) + '\n');
  console.log(
    JSON.stringify({
      manifest: out('dataverse/manifest.json'),
      tables: m.tables.length,
      columns: m.tables.reduce((n, t) => n + (t.columns?.length ?? 0), 0),
      forms: FORMS.length,
      views: VIEWS.length,
      extras: extras().columns.length,
    }),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
