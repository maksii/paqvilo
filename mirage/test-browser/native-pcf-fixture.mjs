// Shared loopback fixture for the native form PCF browser tests: an invented table, a desktop FormXml that binds one
// probe field component to each listed column, portal sources supplied by the test, and a signed-in browser page.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { createSimulator } from '../server.mjs';
import { signInContext } from '../testing/session.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { writeFixtureFiles } from '../test/support/pcf-fixture-files.mjs';

export const RADIO_CLASS = '{67FAC785-CD58-4F9F-ABB3-4B7DDC6ED5ED}';
export const DROPDOWN_CLASS = '{3EF39988-22BB-4F0B-BBBE-64B5A3748AEE}';
export const ROW_ID = '10000000-0000-4000-8000-000000000001';
export const TARGET_ID = '20000000-0000-4000-8000-000000000001';
export const OTHER_TARGET_ID = '20000000-0000-4000-8000-000000000002';
const CODE_COMPONENT_STYLE = 756150001;

// The probe records, per form column (the data-logical-name of its cell, window.nativePcf[<column>]), its parameters at
// init, every lifecycle call in order (init, updateView with updatedProperties, notify, getOutputs) and emits a value on
// demand. emit() resolves with the next updateView after the output.
const probeBundle = (constructor) => `ComponentFramework.registerControl('${constructor}',class{
init(c,notify,_s,el){this.key=el.closest('[data-logical-name]')?.dataset.logicalName??'liquid';this.c=c;this.notify=notify;const self=this;
const all=window.nativePcf=window.nativePcf||{};const p=c.parameters.value;
const snap=(x)=>x&&{raw:x.raw instanceof Date?{date:x.raw.toISOString()}:(typeof x.raw==='number'&&Number.isNaN(x.raw)?'NaN':x.raw),formatted:typeof x.formatted==='number'&&Number.isNaN(x.formatted)?'NaN':x.formatted,type:x.type,attributes:x.attributes,security:x.security,error:x.error,errorMessage:x.errorMessage};
const o=all[this.key]={type:p?.type,initRaw:p?.raw,raw:p?.raw,disabled:c.mode.isControlDisabled,updates:[],events:[],snap,
parameters:Object.fromEntries(Object.entries(c.parameters).map(([k,v])=>[k,snap(v)])),
updatedPropertiesAtInit:[...c.updatedProperties],
emit(v){self.out=v;self.has=true;return new Promise((resolve)=>{o.waiting=resolve;o.events.push({kind:'notify-before'});const r=self.notify();o.events.push({kind:'notify-after',returned:r===undefined?'undefined':String(r)});});}};
o.events.push({kind:'init'});el.dataset.probe=this.key;el.textContent='probe '+this.key;}
updateView(c){this.c=c;const o=window.nativePcf[this.key];const p=c.parameters.value;o.raw=p?.raw;o.disabled=c.mode.isControlDisabled;o.visible=c.mode.isVisible;o.updates.push(p?.raw);
o.events.push({kind:'updateView',updatedProperties:[...c.updatedProperties],value:o.snap(p)});if(o.waiting){const w=o.waiting;o.waiting=null;w(o.snap(p));}}
getOutputs(){window.nativePcf[this.key].events.push({kind:'getOutputs'});return{value:this.has?this.out:this.c.parameters.value?.raw};}
destroy(){}});`;

// One single-type probe control per PCF type (tst_Synthetic.P_<type>, as the live per-type probes) and one type-group
// probe (tst_Synthetic.Probe) whose group starts with Currency like the live FieldProbe.
const probeControl = (type) => `tst_Synthetic.P_${type.replaceAll('.', '_')}`;
const PROBE_TYPES = [
  'Currency',
  'SingleLine.Text',
  'SingleLine.TextArea',
  'SingleLine.Phone',
  'SingleLine.Ticker',
  'Whole.Duration',
  'Multiple',
  'Whole.None',
  'Decimal',
  'FP',
  'DateAndTime.DateOnly',
  'DateAndTime.DateAndTime',
  'TwoOptions',
  'OptionSet',
  'MultiSelectOptionSet',
  'Lookup.Simple',
];

const labels = (text) =>
  `<labels><label description="${text}" languagecode="1033"/><label description="${text}" languagecode="1031"/></labels>`;
const options = (name, type, values) =>
  `<optionset Name="${name}"><OptionSetType>${type}</OptionSetType><options>${values.map(([value, text]) => `<option value="${value}">${labels(text)}</option>`).join('')}</options></optionset>`;
const COLORS = [
  [1, 'Red'],
  [2, 'Green'],
  [3, 'Blue'],
];

const uniqueId = (name, options) => options?.uniqueid ?? 'u-' + name;
const controlOf = (kind, options) =>
  options?.control ?? (options?.group ? 'tst_Synthetic.Probe' : probeControl(COLUMN_KINDS[kind].pcf));
// Static inputs of every single-type probe (as the live per-type probes declare them, with manifest defaults).
const PROBE_INPUTS =
  '<property name="caption" of-type="SingleLine.Text" usage="input" default-value="Default caption"/>' +
  '<property name="count" of-type="Whole.None" usage="input" default-value="7"/>' +
  '<property name="toggle" of-type="TwoOptions" usage="input"/>';
/** The solution files of one probe control (manifest properties inside <control>). */
export function controlFiles(name, properties) {
  const [namespace, constructor] = name.replace(/^tst_/, '').split('.');
  return {
    [`solution/Controls/${name}/ControlManifest.xml`]: `<manifest><control namespace="${namespace}" constructor="${constructor}" control-type="standard">${properties}<resources><code path="bundle.js"/></resources></control></manifest>`,
    [`solution/Controls/${name}/ControlManifest.xml.data.xml`]: `<CustomControl><Name>${name}</Name></CustomControl>`,
    [`solution/Controls/${name}/bundle.js`]: probeBundle(`${namespace}.${constructor}`),
  };
}

/** Entity.xml attribute body (after <Type>) and the FormXml parameter type for each invented column kind. */
const COLUMN_KINDS = {
  text: { type: 'nvarchar', extra: '<Format>text</Format><MaxLength>100</MaxLength>', pcf: 'SingleLine.Text' },
  whole: { type: 'int', extra: '', pcf: 'Whole.None' },
  decimal: { type: 'decimal', extra: '<Accuracy>2</Accuracy>', pcf: 'Decimal' },
  float: { type: 'float', extra: '<Accuracy>2</Accuracy>', pcf: 'FP' },
  money: { type: 'money', extra: '<Accuracy>2</Accuracy>', pcf: 'Currency' },
  dateonly: { type: 'datetime', extra: '<Format>date</Format><Behavior>2</Behavior>', pcf: 'DateAndTime.DateOnly' },
  datetime: {
    type: 'datetime',
    extra: '<Format>datetime</Format><Behavior>1</Behavior>',
    pcf: 'DateAndTime.DateAndTime',
  },
  flag: { type: 'bit', extra: '', pcf: 'TwoOptions' },
  choice: { type: 'picklist', extra: options('tst_color', 'picklist', COLORS), pcf: 'OptionSet' },
  choices: {
    type: 'multiselectpicklist',
    extra: options('tst_colors', 'picklist', COLORS),
    pcf: 'MultiSelectOptionSet',
  },
  lookup: { type: 'lookup', extra: '', pcf: 'Lookup.Simple' },
  ranged: { type: 'int', extra: '<MinValue>-100000</MinValue><MaxValue>100000</MaxValue>', pcf: 'Whole.None' },
  phone: { type: 'nvarchar', extra: '<Format>phone</Format><MaxLength>50</MaxLength>', pcf: 'SingleLine.Phone' },
  ticker: {
    type: 'nvarchar',
    extra: '<Format>tickersymbol</Format><MaxLength>10</MaxLength>',
    pcf: 'SingleLine.Ticker',
  },
  longtext: { type: 'nvarchar', extra: '<Format>text</Format><MaxLength>200</MaxLength>', pcf: 'SingleLine.Text' },
  duration: {
    type: 'int',
    extra: '<Format>duration</Format><MinValue>0</MinValue><MaxValue>100000</MaxValue>',
    pcf: 'Whole.Duration',
  },
  required: {
    type: 'nvarchar',
    extra: '<Format>text</Format><MaxLength>100</MaxLength><RequiredLevel>applicationrequired</RequiredLevel>',
    pcf: 'SingleLine.Text',
  },
  memo: { type: 'ntext', extra: '<Format>text</Format><MaxLength>4000</MaxLength>', pcf: 'Multiple' },
  tzi: {
    type: 'datetime',
    extra: '<Format>datetime</Format><Behavior>3</Behavior>',
    pcf: 'DateAndTime.DateAndTime',
  },
  file: { type: 'file', extra: '', pcf: 'SingleLine.Text' },
  customer: { type: 'customer', extra: '', pcf: 'Lookup.Simple' },
  status: {
    type: 'status',
    extra: options('statuscode', 'status', [
      [1, 'Active'],
      [2, 'Inactive'],
    ]),
    pcf: 'OptionSet',
  },
  state: {
    type: 'state',
    extra: options('statecode', 'state', [
      [0, 'Active'],
      [1, 'Inactive'],
    ]),
    pcf: 'OptionSet',
  },
};

const attribute = (name, type, extra = '') =>
  `<attribute PhysicalName="${name}"><Name>${name}</Name><LogicalName>${name}</LogicalName><Type>${type}</Type>${extra}<displaynames><displayname description="${name}" languagecode="1033"/></displaynames></attribute>`;

/** Solution sources for table tst_row with one FormXml cell per column ([name, kind, classid?, { untyped }?]) bound
 * to the probe; an untyped column exports its FormXml parameter without a type attribute. */
export function solutionFiles(columns) {
  const cells = columns
    .map(
      ([name, , classid, options]) =>
        `<row><cell${options?.hidden ? ' visible="false"' : ''}>${labels(name)}<control id="${name}" uniqueid="${uniqueId(name, options)}" datafieldname="${name}"${classid ? ` classid="${classid}"` : ''}/></cell></row>`,
    )
    .join('');
  const descriptions = columns
    .map(
      ([name, kind, , options]) =>
        `<controlDescription forControl="${uniqueId(name, options)}"><customControl name="${controlOf(kind, options)}" formFactor="0"><parameters>${options?.parameters ?? `<value${options?.untyped ? '' : ` type="${COLUMN_KINDS[kind].pcf}"`}>${name}</value>`}</parameters></customControl></controlDescription>`,
    )
    .join('');
  const lookups = columns.filter(([, kind]) => kind === 'lookup');
  const primary = (entity) =>
    `${attribute(entity + 'id', 'primarykey')}${attribute('tst_title', 'nvarchar', '<DisplayMask>PrimaryName|ValidForForm</DisplayMask><MaxLength>100</MaxLength>')}`;
  return {
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>Synthetic</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Other/Relationships.xml': `<EntityRelationships>${lookups
      .map(
        ([name]) =>
          `<EntityRelationship Name="tst_row_${name}"><EntityRelationshipType>OneToMany</EntityRelationshipType><ReferencingEntityName>tst_row</ReferencingEntityName><ReferencedEntityName>tst_target</ReferencedEntityName><ReferencingAttributeName>${name}</ReferencingAttributeName><ReferencedAttributeName>tst_targetid</ReferencedAttributeName></EntityRelationship>`,
      )
      .join('')}</EntityRelationships>`,
    'solution/Entities/tst_row/Entity.xml': `<Entity><Name>tst_row</Name><EntityInfo><entity Name="tst_row"><EntitySetName>tst_rows</EntitySetName><attributes>${primary('tst_row')}${columns
      .map(([name, kind]) => attribute(name, COLUMN_KINDS[kind].type, COLUMN_KINDS[kind].extra))
      .join('')}</attributes></entity></EntityInfo></Entity>`,
    'solution/Entities/tst_target/Entity.xml': `<Entity><Name>tst_target</Name><EntityInfo><entity Name="tst_target"><EntitySetName>tst_targets</EntitySetName><attributes>${primary('tst_target')}</attributes></entity></EntityInfo></Entity>`,
    'solution/Entities/tst_row/FormXml/main/row-form.xml': `<forms><systemform><formid>{a1000000-0000-4000-8000-000000000001}</formid><FormActivationState>1</FormActivationState><form><tabs><tab name="general"><columns><column><sections><section name="main"><rows>${cells}</rows></section></sections></column></columns></tab></tabs><controlDescriptions>${descriptions}</controlDescriptions></form><LocalizedNames><LocalizedName description="Portal row" languagecode="1033"/><LocalizedName description="Portal row" languagecode="1031"/></LocalizedNames></systemform></forms>`,
    ...controlFiles(
      'tst_Synthetic.Probe',
      `<type-group name="all">${PROBE_TYPES.map((type) => `<type>${type}</type>`).join('')}</type-group><property name="value" of-type-group="all" usage="bound"/>`,
    ),
    ...Object.assign(
      {},
      ...PROBE_TYPES.map((type) =>
        controlFiles(probeControl(type), `<property name="value" of-type="${type}" usage="bound"/>${PROBE_INPUTS}`),
      ),
    ),
  };
}

/** Portal basics: a home page rendering `template`, optionally in German (de-DE, comma decimal separator). */
export function portalFiles(template, { german = false } = {}) {
  return {
    'portal/website.yml': german
      ? 'adx_websiteid: site\nadx_name: Synthetic\nadx_defaultlanguage: lang-de\nadx_website_language: 1031'
      : 'adx_websiteid: site\nadx_name: Synthetic',
    ...(german
      ? {
          'portal/websitelanguage.yml':
            '- adx_websitelanguageid: lang-de\n  adx_name: German - Germany\n  adx_languagecode: de-DE\n  adx_lcid: 1031',
        }
      : {}),
    'portal/Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: main',
    'portal/Main.pagetemplate.yml':
      'adx_pagetemplateid: main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: true',
    'portal/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'portal/Main.webtemplate.source.html': template,
  };
}

/** Basic form metadata rows enabling the code component on each column. */
export function metadataFiles(kind, owner, columns, style = CODE_COMPONENT_STYLE) {
  const ownerField = kind === 'advancedformmetadata' ? 'adx_webformstep' : 'adx_entityform';
  const idField = kind === 'advancedformmetadata' ? 'adx_webformmetadataid' : 'adx_entityformmetadataid';
  return Object.fromEntries(
    columns.map(([name]) => [
      `portal/${owner}-${name}.${kind}.yml`,
      `${idField}: m-${owner}-${name}\n${ownerField}: ${owner}\nadx_type: 100000000\nadx_attributelogicalname: ${name}\nadx_controlstyle: ${style}`,
    ]),
  );
}

/** The local state of a native PCF site: the mappings and tables given, permissive access and an Editor identity. */
export const localEditorState = (mappings, tables) => ({
  version: 1,
  mappings,
  tables,
  permissions: [],
  settings: { permissionMode: 'permissive' },
  simulator: {
    mode: 'local',
    pageMode: 'local',
    identity: { id: 'editor', roles: ['Editor'] },
    endpoints: [],
    live: { origin: null },
    componentSchemas: {},
  },
});

/** Launches a browser the test closes, signs a context in to `app` as the Editor and opens a page. */
export async function editorPage(t, app, contextOptions = {}) {
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  ownedFixture(t).add(() => browser.close());
  const context = await browser.newContext(contextOptions);
  await signInContext(context, app, 'editor', { roles: ['Editor'] });
  return context.newPage();
}

/** Starts the simulator over the files, signs a browser context in and opens a page that records page errors. */
export async function openNativePcfSite(t, files, { rows = [], targets = [], timezoneId, observed } = {}) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'native-pcf-e2e-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  await writeFixtureFiles(root, files);
  const app = await createSimulator({
    sourceDir: path.join(root, 'portal'),
    solutionRoots: [path.join(root, 'solution')],
    port: 0,
    watch: false,
    ...(observed ? { observed } : {}),
    initial: localEditorState(
      {
        tst_row: { entitySet: 'tst_rows', idColumn: 'tst_rowid', nameColumn: 'tst_title' },
        tst_target: { entitySet: 'tst_targets', idColumn: 'tst_targetid', nameColumn: 'tst_title' },
      },
      { tst_row: rows, tst_target: targets },
    ),
  });
  ownedFixture(t).add(() => app.close());
  const page = await editorPage(t, app, timezoneId ? { timezoneId } : {});
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { app, page, errors, root };
}

/** Waits until `count` probes mounted, or fails with the PCF diagnostics and any error markup. */
export async function probesReady(page, app, count) {
  try {
    await page.waitForFunction((n) => document.querySelectorAll('[data-pcf-ready=true]').length >= n, count);
  } catch (error) {
    const alerts = await page.locator('[data-mirage-component=codecomponent]').allTextContents();
    const diagnostics = app.state().diagnostics?.filter((entry) => /PCF/.test(entry.code ?? ''));
    throw new Error(`${error.message}\n${JSON.stringify({ alerts, diagnostics })}`, { cause: error });
  }
}

export const probe = (page, column) => page.evaluate((key) => window.nativePcf?.[key], column);
export const emit = (page, column, value) =>
  page.evaluate(([key, output]) => window.nativePcf[key].emit(output), [column, value]);
export const storedRow = (app, id = ROW_ID) =>
  app.store.snapshot().tables.tst_row.find((row) => String(row.tst_rowid).toLowerCase() === id);
