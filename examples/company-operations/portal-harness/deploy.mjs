import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConnection, connectedClient } from 'paqvilo/dataverse';
import { prepare, fetchXmlTagMatches } from './compile.mjs';
import { savePrivateJson } from './private-journal.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a), []),
);
export function componentId(website, key) {
  const bytes = createHash('sha256').update(`CO Portal Lab v1:${website}:${key}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export async function shellSource(manifest) {
  const core = await fs.readFile(path.join(here, 'core.mjs'), 'utf8'),
    runtime = await fs.readFile(path.join(here, 'runtime.mjs'), 'utf8');
  const coreImport = /^import\s*\{[^}]*\}\s+from\s+(['"])\.\/core\.mjs\1;\s*/;
  if (!coreImport.test(runtime)) throw new Error('The portal runtime must begin with its bundled core import.');
  const code = (core + '\n' + runtime.replace(coreImport, '')).replace(/\bexport /g, '');
  const encoded = JSON.stringify(manifest).replaceAll('<', String.raw`\u003c`);
  return `<section id="co-lab"><h1>Company Operations Permission Lab</h1><p>Paired Liquid and Web API FetchXML. Results distinguish parity, scenario assertions and missing backend evidence.</p><pre id="co-identity"></pre><label>Read case <select id="co-cases"><option value="all">All read cases and variants</option></select></label><label>Previous run <select id="co-baseline"><option value="">No baseline</option></select></label><button id="co-history">Load history</button><button id="co-view-history">View selected run</button><button id="co-read" data-run>Run reads</button><label>CRUD scope <select id="co-crud-scope"><option value="all">All prepared canaries</option><option value="equipment">Equipment only</option><option value="probe">Recorder probe only</option></select></label><button id="co-crud" data-run>Run reads and prepared CRUD</button><label>Plugin profile <select id="co-profile"><option value="">None</option></select></label><button id="co-stop">Stop</button><button id="co-export">Export current JSON</button><p id="co-status" role="status"></p><div id="co-results"></div></section><style>#co-lab{max-width:1100px;margin:24px auto;padding:16px;font-family:system-ui}#co-lab pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f6f7;padding:12px}#co-lab button,#co-lab select{margin:6px;padding:8px}#co-lab details{border-top:1px solid #ddd;padding:10px}</style><script id="co-context" type="application/xml"><context contact-id="{{ user.id | xml_escape }}"><roles>{% for role in user.roles %}<role>{{ role | xml_escape }}</role>{% endfor %}</roles></context></script>{% raw %}<script type="module">${code}\nconst manifest=${encoded};const contextXML=new DOMParser().parseFromString(document.getElementById('co-context').textContent,'application/xml');const context={contactId:contextXML.documentElement.getAttribute('contact-id'),roles:[...contextXML.querySelectorAll('role')].map(r=>r.textContent)};mount(manifest,context);</script>{% endraw %}`;
}
export async function deploy({
  connection,
  website,
  role,
  home,
  published,
  language,
  resolvedIds = {},
  readiness = {},
  overlayFile,
  personaRoleOverrides = {},
  artifactTransportBudgetBytes = 20 * 1024 * 1024,
  odataPositiveVariants = [],
}) {
  if (![website, role, home, published].every((v) => /^[a-f0-9-]{36}$/i.test(v || '')))
    throw new Error('Verified target website, CO Test Runner role, root page and publishing-state IDs required.');
  const connectionInfo = await loadConnection(connection),
    client = connectedClient(connectionInfo);
  await client.verify(connectionInfo.organisationId);
  const schema = JSON.parse(await fs.readFile(path.join(here, '../dataverse/manifest.json'), 'utf8'));
  const navigation = {};
  for (const table of schema.tables) {
    const relationships = await client.list(
      `EntityDefinitions(LogicalName='${table.name}')/ManyToOneRelationships?$select=ReferencingAttribute,ReferencedEntity,ReferencingEntityNavigationPropertyName`,
    );
    addTableNavigation(navigation, table, relationships);
  }
  const overlay = overlayFile ? JSON.parse(await fs.readFile(overlayFile, 'utf8')) : {};
  const { manifest, templates } = await prepare({
    resolvedIds,
    readiness,
    navigation,
    overlay,
    personaRoleOverrides,
    artifactTransportBudgetBytes,
    odataPositiveVariants,
  });
  const id = (key) => componentId(website, key),
    components = [];
  const push = (key, name, type, content, extra = {}) =>
    components.push({ key, id: id(key), name, type, content, ...extra });
  for (const t of templates)
    push('template:' + t.name, t.name, 8, { source: t.source, ...(t.mime ? { mimetype: t.mime } : {}) });
  push('template:shell', 'CO Permission Lab Shell', 8, { source: await shellSource(manifest) });
  push('pagetemplate:shell', 'CO Permission Lab', 6, {
    entityname: 'adx_webpage',
    type: 756150001,
    usewebsiteheaderandfooter: true,
    webtemplateid: id('template:shell'),
  });
  push('pagetemplate:liquid', 'CO Permission Lab Liquid Data', 6, {
    entityname: 'adx_webpage',
    type: 756150001,
    usewebsiteheaderandfooter: false,
    webtemplateid: id('template:CO Permission Lab Liquid Dispatcher'),
  });
  push('page:shell', 'CO Permission Lab', 2, {
    isroot: true,
    pagetemplateid: id('pagetemplate:shell'),
    parentpageid: home,
    partialurl: 'permission-lab',
    publishingstateid: published,
    title: 'Permission Lab',
    hiddenfromsitemap: true,
  });
  push('page:liquid', 'CO Permission Lab Liquid Data', 2, {
    isroot: true,
    pagetemplateid: id('pagetemplate:liquid'),
    parentpageid: id('page:shell'),
    partialurl: 'liquid',
    publishingstateid: published,
    title: 'Permission Lab Liquid Data',
    hiddenfromsitemap: true,
  });
  // Localized child rows are required by multilingual enhanced-model sites.
  if (language) addLocalizedPages(push, id, language, published);
  push('access:shell', 'CO Permission Lab Require Runner', 10, {
    adx_webpageaccesscontrolrule_webrole: [role],
    right: 2,
    scope: 1,
    webpageid: id('page:shell'),
  });
  push('access:liquid', 'CO Liquid Data Require Runner', 10, {
    adx_webpageaccesscontrolrule_webrole: [role],
    right: 2,
    scope: 1,
    webpageid: id('page:liquid'),
  });
  const fields = deployFieldAllowlist(manifest, schema);
  for (const [table, names] of Object.entries(fields)) {
    // Qualify allowlists against actual metadata; never deploy aliases or guessed columns as schema fields.
    const actual = await client.list(
      `EntityDefinitions(LogicalName='${table}')/Attributes?$select=LogicalName,AttributeType`,
    );
    addFieldSettings(table, names, actual, push);
  }
  const existing = await client.list(
    `powerpagecomponents?$filter=_powerpagesiteid_value eq ${website}&$select=powerpagecomponentid,name,powerpagecomponenttype,content,_powerpagesiteid_value,_powerpagesitelanguageid_value,statecode`,
  );
  const journal = { website, createdAt: new Date().toISOString(), manifestHash: manifest.manifestHash, entries: [] };
  const dir = path.join(here, '../.paqvilo/portal-harness');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `deploy-${Date.now()}.json`);
  const save = () => savePrivateJson(file, structuredClone(journal));
  await savePrivateJson(file, journal, { exclusive: true });
  for (const c of components) {
    const { own, body, unchanged, entry } = prepareComponentWrite(c, existing, website);
    journal.entries.push(entry);
    await save();
    if (!unchanged) {
      const request = componentWriteRequest(c, own, body, website);
      await client.request(request.path, request.options);
    }
    const actual = await client.get(`powerpagecomponents(${c.id})`);
    assertComponentReadback(actual, body, website);
    entry.status = componentWriteStatus(unchanged, own);
    await save();
    if (journal.entries.length % 10 === 0)
      console.log(JSON.stringify({ completed: journal.entries.length, total: components.length }));
  }
  const post = await client.list(
    `powerpagecomponents?$filter=_powerpagesiteid_value eq ${website}&$select=powerpagecomponentid,name,powerpagecomponenttype,content,_powerpagesiteid_value,_powerpagesitelanguageid_value,statecode`,
  );
  const mismatches = deploymentMismatches(components, post);
  journal.verification = { checked: components.length, mismatches };
  journal.finishedAt = new Date().toISOString();
  await save();
  if (mismatches.length) throw new Error(`Post-deployment verification failed for ${mismatches.join(', ')}`);
  return {
    journal: file,
    manifestHash: manifest.manifestHash,
    components: components.length,
    page: id('page:shell'),
    liquidPage: id('page:liquid'),
    fields: Object.fromEntries(
      Object.entries(fields).map(([table, columns]) => [table, [...columns].filter(Boolean).sort()]), // NOSONAR: preserve default coercion and UTF-16 sort order
    ),
  };
}

function deployFieldAllowlist(manifest, schema) {
  const fields = {};
  for (const plan of manifest.cases) addFetchXmlFields(fields, plan, schema);
  addPositiveVariantFields(fields, manifest);
  addSafeReadExtraFields(fields);
  addSystemTableFields(fields, schema);
  addSystemRelationshipFields(fields, schema);
  return fields;
}

function addTableNavigation(navigation, table, relationships) {
  navigation[
    table.entitySetName ||
      { account: 'accounts', contact: 'contacts', transactioncurrency: 'transactioncurrencies' }[table.name]
  ] = {};
  for (const relationship of relationships)
    navigation[
      table.entitySetName ||
        { account: 'accounts', contact: 'contacts', transactioncurrency: 'transactioncurrencies' }[table.name]
    ][relationship.ReferencingAttribute] = relationship.ReferencingEntityNavigationPropertyName;
}

function addLocalizedPages(push, id, language, published) {
  for (const [kind, title] of [
    ['shell', 'CO Permission Lab'],
    ['liquid', 'CO Permission Lab Liquid Data'],
  ])
    push(
      'contentpage:' + kind,
      title,
      2,
      {
        isroot: false,
        rootwebpageid: id('page:' + kind),
        pagetemplateid: id('pagetemplate:' + kind),
        partialurl: kind === 'shell' ? 'permission-lab' : 'liquid',
        publishingstateid: published,
        title,
        hiddenfromsitemap: true,
      },
      { language },
    );
}

function addFieldSettings(table, names, actual, push) {
  const legal = new Set(
    actual.flatMap((column) => [
      column.LogicalName,
      ...(['Lookup', 'Customer', 'Owner'].includes(column.AttributeType) ? [`_${column.LogicalName}_value`] : []),
    ]),
  );
  for (const name of names)
    if (name && !legal.has(name)) throw new Error(`Web API allowlist references missing ${table}.${name}`);
  push('setting:' + table + ':enabled', `Webapi/${table}/enabled`, 9, { value: 'true' });
  push('setting:' + table + ':fields', `Webapi/${table}/fields`, 9, {
    value: [...names].filter(Boolean).sort().join(','), // NOSONAR: preserve default coercion and UTF-16 sort order
  });
}

function deploymentMismatches(components, post) {
  return components
    .filter(
      (component) =>
        !post.some(
          (entry) =>
            entry.powerpagecomponentid === component.id &&
            entry.statecode === 0 &&
            entry.powerpagecomponenttype === component.type &&
            entry.content === JSON.stringify(component.content),
        ),
    )
    .map((component) => component.key);
}

function addFetchXmlFields(fields, plan, schema) {
  fields[plan.table] ||= new Set([plan.primaryId, plan.primaryName]);
  const entityStack = [],
    aliases = {};
  for (const match of fetchXmlTagMatches(plan.fetchXml)) {
    if (match[1]) {
      const table = match[2].match(/\bname="([^"]+)"/)?.[1],
        alias = match[2].match(/\balias="([^"]+)"/)?.[1];
      entityStack.push(table);
      if (alias) aliases[alias] = table;
    } else if (match[3]) entityStack.pop();
    else {
      const attrs = match[4],
        entityAlias = attrs.match(/\bentityname="([^"]+)"/)?.[1],
        table = entityAlias ? aliases[entityAlias] : entityStack.at(-1),
        name = attrs.match(/\b(?:name|attribute)="([^"]+)"/)?.[1];
      if (name && schema.tables.some((t) => t.name === table)) {
        fields[table] ||= new Set();
        fields[table].add(name);
      }
    }
  }
}

function addPositiveVariantFields(fields, manifest) {
  for (const plan of manifest.odataPositiveVariants) {
    for (const field of plan.requiredLogicalWebApiFields ?? []) {
      fields[plan.table] ||= new Set();
      fields[plan.table].add(field);
    }
    for (const field of plan.fields ?? [])
      if (field.logicalName && field.source === `_${field.logicalName}_value`) fields[plan.table].add(field.source);
  }
}

function addSafeReadExtraFields(fields) {
  const safeReadExtras = {
    account: ['name', 'accountnumber', 'pqvd_orgkind'],
    contact: ['firstname', 'lastname', 'fullname', 'pqvd_personcode'],
    pqvd_equipment: [
      'pqvd_canaryrunid',
      'pqvd_roomid',
      'pqvd_accountid',
      'pqvd_assettag',
      'pqvd_equipmentkind',
      'pqvd_condition',
      'pqvd_equipmentstate',
    ],
    pqvd_accesspermission: [
      'pqvd_roleid',
      'pqvd_granteecontactid',
      'pqvd_scopeaccountid',
      'pqvd_departmentid',
      'pqvd_employmentid',
      'pqvd_accessstate',
      'pqvd_validfrom',
      'pqvd_validuntil',
      'pqvd_scopekey',
    ],
  };
  for (const [table, names] of Object.entries(safeReadExtras))
    for (const name of names) {
      fields[table] ||= new Set();
      fields[table].add(name);
    }
}

function addSystemTableFields(fields, schema) {
  for (const table of schema.tables.filter((item) => isHarnessTable(item.name))) {
    fields[table.name] = new Set([
      `${table.name}id`,
      'pqvd_name',
      ...(table.columns || []).map((column) => column.name),
    ]);
    for (const relationship of schema.relationships.filter(
      (item) =>
        item.child === table.name || item.referencingTable === table.name || item.referencingEntity === table.name,
    ))
      if (relationship.lookup?.name) fields[table.name].add(relationship.lookup.name);
  }
}

function addSystemRelationshipFields(fields, schema) {
  // Relationships in the generated registry use referencingTable/referencedTable or parent/child: read concrete Lookup schema names.
  for (const relationship of schema.relationships) {
    const child = relationship.child || relationship.referencingTable || relationship.referencingEntity;
    if (isHarnessTable(child) && relationship.lookup)
      fields[child].add((relationship.lookup.name || relationship.lookup.schemaName)?.toLowerCase());
  }
}

function isHarnessTable(name) {
  return [
    'pqvd_testrun',
    'pqvd_testresult',
    'pqvd_testoperation',
    'pqvd_crudprobe',
    'pqvd_pluginevent',
    'pqvd_chainnode',
  ].includes(name);
}

function prepareComponentWrite(component, existing, website) {
  const matches = existing.filter(
    (entry) =>
      entry.name === component.name && entry.powerpagecomponenttype === component.type && entry.statecode === 0,
  );
  if (component.type === 9 && matches.length > 1)
    throw new Error(`Duplicate active setting ${component.name}; reconcile ambiguous configuration first.`);
  // Site-level API settings have a unique semantic name: preserve discovered identity and journal prior content.
  if (component.type === 9 && matches.length === 1) component.id = matches[0].powerpagecomponentid;
  const own = existing.find((entry) => entry.powerpagecomponentid === component.id);
  if (
    own &&
    (own._powerpagesiteid_value !== website ||
      own.name !== component.name ||
      own.powerpagecomponenttype !== component.type)
  )
    throw new Error('Portal deployment component identity collision.');
  const body = {
    name: component.name,
    powerpagecomponenttype: component.type,
    content: JSON.stringify(component.content),
  };
  if (component.language) body['powerpagesitelanguageid@odata.bind'] = `/powerpagesitelanguages(${component.language})`;
  const unchanged = own?.content === body.content && own?.statecode === 0;
  const entry = {
    key: component.key,
    id: component.id,
    status: unchanged ? 'exists' : 'pending',
    planned: body,
    ...(own && !unchanged ? { before: own } : {}),
  };
  return { own, body, unchanged, entry };
}

function componentWriteRequest(component, own, body, website) {
  if (own) {
    if (!own['@odata.etag']) throw new Error('Portal update requires a native ETag.');
    return {
      path: `powerpagecomponents(${component.id})`,
      options: { method: 'PATCH', body, ifMatch: own['@odata.etag'] },
    };
  }
  return {
    path: 'powerpagecomponents',
    options: {
      method: 'POST',
      body: {
        ...body,
        powerpagecomponentid: component.id,
        'powerpagesiteid@odata.bind': `/powerpagesites(${website})`,
      },
    },
  };
}

function assertComponentReadback(actual, body, website) {
  if (actual.content !== body.content || actual.statecode !== 0 || actual._powerpagesiteid_value !== website)
    throw new Error('Portal component readback failed.');
}

function componentWriteStatus(unchanged, own) {
  if (unchanged) return 'exists';
  return own ? 'updated' : 'created';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(await fs.readFile(args.config, 'utf8'));
  console.log(JSON.stringify(await deploy(config)));
}
