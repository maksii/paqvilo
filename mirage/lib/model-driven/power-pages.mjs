// Platform adapter: documented Power Pages management tables, never site-specific data.
// https://learn.microsoft.com/power-pages/admin/enhanced-data-model
import { portalField } from '../importer.mjs';
import { isDeepStrictEqual } from 'node:util';

const managementGroups = [
  [
    'Website',
    [
      ['website', 'Websites'],
      ['pagetemplate', 'Page Templates'],
      ['redirect', 'Redirects'],
      ['sitemarker', 'Site Markers'],
      ['sitesetting', 'Site Settings'],
      ['setting', 'Settings'],
    ],
  ],
  [
    'Content',
    [
      ['contentsnippet', 'Content Snippets'],
      ['basicform', 'Basic Forms', 'entityform'],
      ['list', 'Lists', 'entitylist'],
      ['shortcut', 'Shortcuts'],
      ['webfile', 'Web Files'],
      ['advancedform', 'Multistep Forms', 'webform'],
      ['weblinkset', 'Web Link Sets'],
      ['webpage', 'Web Pages'],
      ['webtemplate', 'Web Templates'],
    ],
  ],
  [
    'Security',
    [
      ['contact', 'Contacts'],
      ['tablepermission', 'Table Permissions', 'entitypermission'],
      ['columnpermissionprofile', 'Column Permission Profiles'],
      ['invitation', 'Invitations'],
      ['publishingstatetransitionrule', 'Publishing State Transition Rules'],
      ['webpageaccesscontrolrule', 'Web Page Access Control Rules'],
      ['webrole', 'Web Roles'],
      ['websiteaccess', 'Website Access Permissions'],
    ],
  ],
];
const auxiliaries = [
  ['weblink', 'Web Links'],
  ['basicformmetadata', 'Basic Form Metadata', 'entityformmetadata'],
  ['advancedformstep', 'Multistep Form Steps', 'webformstep'],
  ['advancedformmetadata', 'Multistep Form Metadata', 'webformmetadata'],
  ['publishingstate', 'Publishing States'],
  ['websitelanguage', 'Website Languages'],
  ['columnpermission', 'Column Permissions'],
];
const systemTables = new Set(['contact', 'setting', 'invitation']);
const platformColumns = {
  website: [
    'defaultlanguage:lookup:websitelanguage',
    'primarydomainname',
    'websiteversion',
    'headerwebtemplateid:lookup:webtemplate',
    'footerwebtemplateid:lookup:webtemplate',
  ],
  pagetemplate: ['webtemplateid:lookup:webtemplate', 'rewriteurl', 'usewebsiteheaderandfooter:boolean', 'entityname'],
  sitesetting: ['value:textarea'],
  contentsnippet: ['value:textarea', 'contentsnippetlanguageid:lookup:websitelanguage'],
  webtemplate: ['source:textarea'],
  webpage: [
    'partialurl',
    'isroot:boolean',
    'parentpageid:lookup:webpage',
    'pagetemplateid:lookup:pagetemplate',
    'rootwebpageid:lookup:webpage',
    'webpagelanguageid:lookup:websitelanguage',
    'publishingstateid:lookup:publishingstate',
    'copy:textarea',
    'summary:textarea',
    'customcss:textarea',
    'customjavascript:textarea',
    'title',
  ],
  webfile: ['partialurl', 'parentpageid:lookup:webpage', 'publishingstateid:lookup:publishingstate'],
  basicform: ['entityname', 'formname', 'tabname', 'mode:number', 'recordidquerystringparametername'],
  list: [
    'entityname',
    'view',
    'pagesize:number',
    'webpageforcreate:lookup:webpage',
    'webpagefordetails:lookup:webpage',
  ],
  sitemarker: ['pageid:lookup:webpage'],
  redirect: ['inboundurl', 'redirecturl', 'statuscode:number'],
  weblinkset: ['title'],
  weblink: ['weblinksetid:lookup:weblinkset', 'pageid:lookup:webpage', 'externalurl', 'displayorder:number'],
  tablepermission: [
    'entitylogicalname',
    'scope:number',
    'read:boolean',
    'create:boolean',
    'write:boolean',
    'delete:boolean',
    'append:boolean',
    'appendto:boolean',
  ],
  webrole: ['description:textarea', 'authenticatedusersrole:boolean', 'anonymoususersrole:boolean'],
  publishingstate: ['isvisible:boolean', 'isdefault:boolean'],
};
const platformLabels = {
  defaultlanguage: 'Default Language',
  primarydomainname: 'Primary Domain Name',
  websiteversion: 'Website Version',
  websiteid: 'Website',
  parentpageid: 'Parent Page',
  pagetemplateid: 'Page Template',
  partialurl: 'Partial URL',
  rootwebpageid: 'Root Web Page',
  webpagelanguageid: 'Page Language',
  publishingstateid: 'Publishing State',
  customcss: 'Custom CSS',
  customjavascript: 'Custom JavaScript',
  isroot: 'Root Page',
  entityname: 'Table Name',
  entitylogicalname: 'Table Name',
  formname: 'Form Name',
  tabname: 'Tab Name',
  webtemplateid: 'Web Template',
  usewebsiteheaderandfooter: 'Use Website Header and Footer',
  rewriteurl: 'Rewrite URL',
  contentsnippetlanguageid: 'Content Snippet Language',
  authenticatedusersrole: 'Authenticated Users Role',
  anonymoususersrole: 'Anonymous Users Role',
  createdon: 'Created On',
  modifiedon: 'Modified On',
  createdby: 'Created By',
  modifiedby: 'Modified By',
};
const pretty = (value) =>
  String(value)
    .replace(/^(?:adx|mspp)_/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
const idOf = (value) =>
  String(value?.id ?? value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
const prefixOf = (portal) => (portal.dataModel === 'standard' || portal.format === 'standard' ? 'adx_' : 'mspp_');
const fieldType = (name, values) => {
  const value = values.find((item) => item != null);
  if (/^(?:createdon|modifiedon)$/.test(name))
    return { type: 'date', dataverseType: 'datetime', validForCreate: false, validForUpdate: false };
  if (/^(?:createdby|modifiedby|versionnumber|createdonbehalfby|modifiedonbehalfby)$/.test(name))
    return { type: 'text', validForCreate: false, validForUpdate: false };
  if (typeof value === 'boolean') return { type: 'boolean', dataverseType: 'bit' };
  if (typeof value === 'number') return { type: 'number', dataverseType: Number.isInteger(value) ? 'int' : 'decimal' };
  if (typeof value === 'object') return { type: 'json', dataverseType: 'json' };
  if (/(?:source|copy|value|customjavascript|customcss|description|summary)$/.test(name))
    return {
      type: 'textarea',
      dataverseType: 'memo',
      ...(/(?:source|copy|customjavascript|customcss)$/.test(name) ? { editorRows: 12 } : {}),
    };
  return { type: 'text', dataverseType: 'nvarchar' };
};

/** Export columns retain their identity; only the documented adx -> mspp façade changes. */
export function powerPagesTables(portal, metadata = {}) {
  const prefix = prefixOf(portal);
  const definitions = [...managementGroups.flatMap(([, items]) => items), ...auxiliaries];
  const tables = {};
  for (const [kind, plural, raw = kind] of definitions) {
    const entity = systemTables.has(kind) ? (kind === 'contact' ? 'contact' : `adx_${raw}`) : prefix + raw;
    const projected = !systemTables.has(kind);
    if (!projected) continue;
    const idColumn = `${entity}id`,
      nameColumn = `${prefix}name`;
    const primaryWebsiteId = portal.website.id ?? portalField(portal.website, 'websiteid');
    const records =
      kind === 'website'
        ? [
            { ...portal.website, kind: 'website', id: primaryWebsiteId },
            ...(portal.records ?? []).filter((record) => record.kind === 'website' && record.id !== primaryWebsiteId),
          ]
        : (portal.records ?? []).filter((record) => record.kind === kind);
    const rows = records
      .filter((record) => record.id)
      .map((record) => {
        const row = {
          [idColumn]: record.id,
          [nameColumn]: record.name ?? portalField(record, 'name', ''),
          statecode: Number(portalField(record, 'statecode', 0)),
        };
        if (kind !== 'website') row[prefix + 'websiteid'] = primaryWebsiteId;
        for (const [key, value] of Object.entries(record)) {
          if (key.startsWith('_') || ['id', 'kind', 'name', 'filename', 'powerpagecomponenttype'].includes(key))
            continue;
          const bare = key.replace(/^(?:adx|mspp)_/, '');
          const column = ['statecode', 'statuscode', 'createdon', 'createdby', 'modifiedon', 'modifiedby'].includes(
            bare,
          )
            ? bare
            : prefix + bare;
          row[column] = value;
        }
        // Source sidecars are compiled into the portal; make their content editable too.
        if (kind === 'webtemplate')
          row[prefix + 'source'] = portal.templates?.[record.id]?.source ?? portalField(record, 'source', '');
        if (kind === 'contentsnippet')
          row[prefix + 'value'] =
            portal.snippetTranslations?.[idOf(portalField(record, 'contentsnippetlanguageid'))]?.[row[nameColumn]] ??
            portal.snippets?.[row[nameColumn]] ??
            portalField(record, 'value', '');
        const page = portal.pages?.find((page) => page.id === record.id);
        if (page)
          for (const [column, value] of Object.entries({
            copy: page.html,
            customcss: page.css,
            customjavascript: page.js,
            summary: page.summary,
          }))
            row[prefix + column] = value;
        return row;
      });
    const fields = {};
    const keys = new Set([
      idColumn,
      nameColumn,
      ...(kind === 'website' ? [] : [prefix + 'websiteid']),
      ...rows.flatMap(Object.keys),
    ]);
    for (const column of keys) {
      const bare = column.replace(/^(?:adx|mspp)_/, '');
      fields[column] = {
        name: column,
        label: column === nameColumn ? 'Name' : (platformLabels[bare] ?? pretty(column)),
        ...fieldType(
          bare,
          rows.map((row) => row[column]),
        ),
      };
    }
    for (const spec of [
      ...(kind === 'website' ? [] : ['websiteid:lookup:website']),
      ...(platformColumns[kind] ?? []),
    ]) {
      const [name, type = 'text', target] = spec.split(':'),
        column = prefix + name;
      fields[column] = {
        ...fields[column],
        name: column,
        label: platformLabels[name] ?? pretty(name),
        type,
        dataverseType: { text: 'nvarchar', textarea: 'memo', number: 'int', boolean: 'bit', lookup: 'lookup' }[type],
        ...(target ? { targets: [prefix + target] } : {}),
      };
    }
    fields[idColumn] = {
      name: idColumn,
      label: 'ID',
      type: 'text',
      dataverseType: 'uniqueidentifier',
      isPrimaryId: true,
      validForCreate: false,
      validForUpdate: false,
    };
    fields[nameColumn].required = true;
    fields[nameColumn].isPrimaryName = true;
    fields.statecode = {
      name: 'statecode',
      label: 'Status',
      type: 'number',
      dataverseType: 'state',
      options: [
        { value: 0, label: 'Active' },
        { value: 1, label: 'Inactive' },
      ],
    };
    Object.assign(fields, metadata.entities?.[entity]?.fields);
    // These documented portal columns contain editable source, rather than a
    // standard memo field. Keep the management editor spacious when metadata
    // replaces the projected column definition.
    for (const name of ['source', 'copy', 'customjavascript', 'customcss'])
      if (fields[prefix + name]?.type === 'textarea') fields[prefix + name].editorRows ??= 12;
    if (kind !== 'website' && fields[prefix + 'websiteid'])
      fields[prefix + 'websiteid'].defaultValue = primaryWebsiteId;
    tables[entity] = {
      entity,
      kind,
      label: plural,
      singular: plural === 'Websites' ? 'Website' : plural.replace(/s$/, ''),
      entitySet: metadata.entities?.[entity]?.entitySet,
      ownership: metadata.entities?.[entity]?.ownership,
      tableType: metadata.entities?.[entity]?.tableType ?? (prefix === 'mspp_' ? 'Virtual' : 'Standard'),
      idColumn,
      nameColumn,
      fields,
      rows,
      source: 'power-pages-export',
      projected: true,
      prefix,
      protectedIds: kind === 'website' ? [primaryWebsiteId] : [],
    };
  }
  return tables;
}

export function defaultManagementApp(portal) {
  const prefix = prefixOf(portal);
  return {
    id: 'power-pages-management',
    uniqueName: 'mspp_PowerPageManagement',
    name: 'Mirage Site Manager',
    source: 'platform-default',
    navigation: [
      {
        id: 'management',
        title: 'Power Pages',
        groups: managementGroups.map(([title, items]) => ({
          id: title.toLowerCase(),
          title,
          items: items.map(([kind, title, raw = kind]) => ({
            id: kind,
            title,
            entity: systemTables.has(kind) ? (kind === 'contact' ? 'contact' : `adx_${raw}`) : prefix + raw,
            supported: true,
          })),
        })),
      },
    ],
  };
}

export function managementOverlay(table, row, previousRow) {
  const patch = { kind: table.kind, id: row[table.idColumn] };
  for (const [column, value] of Object.entries(row)) {
    if (
      column === table.idColumn ||
      column.includes('@') ||
      (previousRow && isDeepStrictEqual(value, previousRow[column]))
    )
      continue;
    const bare = column.replace(/^(?:adx|mspp)_/, '');
    patch[bare] = value;
  }
  return patch;
}
