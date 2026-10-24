// Dataverse metadata messages with no table-write semantics of their own: reference checks between tables, autonumber
// seeds, key activation, language packs, localized labels and translation files. Each is an unbound operation in
// api.registry, so the Web API and SOAP's generic OrganizationRequest dispatch both reach it. Writes run in one store
// transaction through api.change. Reads never change state. Refusal messages without a native error code are guesses.
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { DataError } from './data-error.mjs';
import { isExactNumeric } from './exact-numeric.mjs';
import { contextUrl } from './dataverse-odata.mjs';
import { requireMetadataPrivilege } from './dataverse-metadata-relationships.mjs';
import { createMetadataService } from './dataverse-metadata.mjs';
import { handleMetadataWrite, activateKey } from './dataverse-metadata-tables.mjs';
import { zipOf } from './dataverse-solutions.mjs';

const DEFAULT_LCID = 1033;
const LABEL_LIMIT = 500; // translated text over 500 characters fails the import
const TABLE_LABELS = ['DisplayName', 'DisplayCollectionName', 'Description'];
// The only attributes RetrieveLocLabels and SetLocLabels accept (their documented supported tables).
const LOC_ATTRIBUTES = {
  dynamicproperty: ['name'],
  dynamicpropertyoptionsetitem: ['dynamicpropertyoptionname', 'dynamicpropertyoptiondescription'],
  product: ['name'],
  savedquery: ['name', 'description'],
  savedqueryvisualization: ['name', 'description'],
  systemform: ['name', 'description'],
  timezonedefinition: ['userinterfacename', 'standardname'],
  timezonelocalizedname: ['userinterfacename'],
};
const GUID = /^\{?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}?$/i;

const fail = (message, status = 400, code = 'InvalidRequest', innerCode) =>
  new DataError(message, status, code, innerCode ? { innerCode } : undefined);
const lower = (value) => String(value ?? '').toLowerCase();
const xmlEsc = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const xmlUnesc = (value) =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
// The operation's argument: a JSON body member for actions, a URL parameter for functions.
const argOf = (c, name) => (c.body?.[name] !== undefined ? c.body[name] : c.params?.[name]);
const required = (value, name) => {
  if (value === undefined || value === null || value === '') throw fail(`${name} is required.`);
  return value;
};
const lcidOf = (value, name) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw fail(`${name} must be a language code.`);
  return number;
};
const baseOf = (api) => Number(api.settings?.localeId ?? DEFAULT_LCID);
const tableOf = (api, name) => api.store.resolveMapping(lower(required(name, 'EntityName')));
const writeState = (api, fn) => api.change(() => api.store.transact(fn));

// ---- Reference checks
// Intersect tables take no relationships. Elastic tables take no N:N relationship.
const kindOf = (mapping) => {
  if (mapping.intersect) return 'intersect';
  if (mapping.tableType === 'Elastic' || mapping.dataverseMetadata?.TableType === 'Elastic') return 'elastic';
  return 'standard';
};
const canBeReferenced = (mapping) => kindOf(mapping) !== 'intersect'; // assumed true for virtual and elastic tables
const canBeReferencing = (mapping) => kindOf(mapping) !== 'intersect'; // assumed true for virtual and elastic tables
const canManyToMany = (mapping) => kindOf(mapping) === 'standard';
const namesWhere = (api, test) =>
  Object.values(api.store.state.mappings)
    .filter((mapping) => mapping.logicalName && test(mapping))
    .map((mapping) => mapping.logicalName)
    .sort();

// ---- Autonumber (default seed 1000)
// The counter is the next value, kept in settings.autoNumberSequences exactly where the record writer advances it.
function autoNumberOf(api, c) {
  const mapping = tableOf(api, argOf(c, 'EntityName'));
  const attribute = lower(required(argOf(c, 'AttributeName'), 'AttributeName'));
  const definition = api.store.fieldDefinitions(mapping.logicalName)[attribute];
  if (!definition?.autoNumberFormat)
    throw fail(`The column ${attribute} of ${mapping.logicalName} is not an autonumber column.`);
  const key = `${mapping.logicalName}.${attribute}`;
  const counter = api.store.state.settings?.autoNumberSequences?.[key];
  return {
    key,
    seed: Number(definition.autoNumberSeed ?? 1000),
    next: Number(counter ?? definition.autoNumberSeed ?? 1000),
  };
}

// ---- Languages
// The base language is the organization language. Language packs are not installable through the API, so the installed
// list is the base language plus settings.languagePacks. Provisioned and deprovisioned are kept in state.dataverse.languages.
function languagesOf(api) {
  const saved = api.store.state.dataverse?.languages ?? {};
  const base = baseOf(api);
  return {
    base,
    installed: saved.installed ?? [...new Set([base, ...(api.settings?.languagePacks ?? [])].map(Number))],
    provisioned: saved.provisioned ?? [],
    deprovisioned: saved.deprovisioned ?? [],
  };
}
const provisionedOf = (languages) => [...new Set([languages.base, ...languages.provisioned])].sort((a, b) => a - b);

// The refusals of ProvisionLanguage, checked without writing (ProvisionLanguageAsync checks them before its job).
function checkProvision(api, lcid) {
  const languages = languagesOf(api);
  if (lcid === languages.base || languages.provisioned.includes(lcid))
    throw fail(`The language ${lcid} is already provisioned.`);
  if (!languages.installed.includes(lcid)) throw fail(`The language pack ${lcid} is not installed.`);
}

async function provisionLanguage(api, lcid) {
  checkProvision(api, lcid);
  const languages = languagesOf(api);
  await writeState(api, () => {
    const dv = (api.store.state.dataverse ??= {});
    dv.languages = {
      installed: languages.installed,
      provisioned: [...languages.provisioned, lcid],
      deprovisioned: languages.deprovisioned.filter((id) => id !== lcid),
    };
  });
}

async function deprovisionLanguage(api, lcid, cleanup) {
  const languages = languagesOf(api);
  if (lcid === languages.base) throw fail('The base language cannot be deprovisioned.');
  if (!languages.provisioned.includes(lcid)) throw fail(`The language ${lcid} is not provisioned.`);
  await writeState(api, () => {
    const dv = (api.store.state.dataverse ??= {});
    dv.languages = {
      installed: languages.installed,
      provisioned: languages.provisioned.filter((id) => id !== lcid),
      deprovisioned: [...new Set([...languages.deprovisioned, lcid])],
    };
    if (cleanup) {
      // CleanupLanguageRows: the localized labels written in this language go too.
      for (const entry of Object.values(dv.locLabels ?? {})) delete entry[lcid];
    }
  });
}

// ---- Localized labels
// Labels live in state.dataverse.locLabels keyed "<table>|<row id>|<attribute>", each { lcid: text }.
function monikerOf(api, value) {
  const body = value ?? {};
  const typeName = String(body['@odata.type'] ?? '').replace(/^#?Microsoft\.Dynamics\.CRM\./, '');
  const logical = lower(body.LogicalName ?? typeName);
  if (!logical) throw fail('EntityMoniker is required.');
  const mapping = tableOf(api, logical);
  const fromId = /\(([^()]+)\)\s*$/.exec(String(body['@odata.id'] ?? ''))?.[1];
  const id = lower(GUID.exec(String(body[mapping.idColumn] ?? fromId ?? body.Id ?? '').trim())?.[1] ?? '');
  if (!id) throw fail('EntityMoniker needs a row id.');
  const rows = api.store.state.tables[mapping.logicalName] ?? [];
  if (!rows.some((row) => lower(row[mapping.idColumn]) === id))
    throw fail(`Could not find item '${id}'.`, 404, 'NotFound');
  return { mapping, id };
}
function localizedAttribute(mapping, attribute) {
  const name = lower(required(attribute, 'AttributeName'));
  if (!LOC_ATTRIBUTES[mapping.logicalName]?.includes(name)) {
    throw fail(`The attribute ${name} of ${mapping.logicalName} does not support localized labels.`);
  }
  return name;
}
const labelKey = (mapping, id, attribute) => `${mapping.logicalName}|${id}|${attribute}`;

// ---- Translation files (zip archives)
// CrmFieldTranslations.xml layout: one LocLabel per label. ponytail: this element layout is a guess and is read back only by
// this module; match the native file when one is available.
function readZipFiles(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw fail('The translation file is not a zip archive.');
  const count = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) throw fail('The translation file is not a valid zip archive.');
    const method = buffer.readUInt16LE(p + 10);
    const size = buffer.readUInt32LE(p + 20);
    const nameLength = buffer.readUInt16LE(p + 28);
    const extraLength = buffer.readUInt16LE(p + 30);
    const commentLength = buffer.readUInt16LE(p + 32);
    const local = buffer.readUInt32LE(p + 42);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLength);
    p += 46 + nameLength + extraLength + commentLength;
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const packed = buffer.subarray(start, start + size);
    files.set(name, method === 8 ? inflateRawSync(packed, { maxOutputLength: 16 * 1024 * 1024 }) : packed);
  }
  return files;
}
const attributesOf = (tag) =>
  Object.fromEntries([...tag.matchAll(/(\w+)="([^"]*)"/g)].map(([, k, v]) => [k, xmlUnesc(v)]));
function rowsOf(text) {
  return [...text.matchAll(/<LocLabel\b([^>]*?)\/?>/g)].map((m) => attributesOf(m[1]));
}
function labelXml(rows, root) {
  return `<?xml version="1.0" encoding="utf-8"?>\n<${root}><LocLabels>${rows
    .map(
      (row) =>
        `<LocLabel ${Object.entries(row)
          .map(([k, v]) => `${k}="${xmlEsc(v)}"`)
          .join(' ')} />`,
    )
    .join('')}</LocLabels></${root}>`;
}
const CONTENT_TYPES = `<?xml version="1.0" encoding="utf-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml" /></Types>`;

// Table labels (dataverseMetadata.labels) and localized labels of rows, one LocLabel per language.
function exportRows(api, { fields }) {
  const out = [];
  if (!fields) {
    for (const mapping of Object.values(api.store.state.mappings)) {
      if (!mapping.logicalName) continue;
      const labels = mapping.dataverseMetadata?.labels ?? {};
      for (const property of TABLE_LABELS) {
        for (const [lcid, text] of Object.entries(labels[property] ?? {})) {
          if (text != null)
            out.push({
              ObjectType: 'table',
              Name: mapping.logicalName,
              Property: property,
              languagecode: lcid,
              description: text,
            });
        }
      }
    }
  }
  for (const [key, entry] of Object.entries(api.store.state.dataverse?.locLabels ?? {})) {
    const [logical, , attribute] = key.split('|');
    for (const [lcid, text] of Object.entries(entry)) {
      if (text != null)
        out.push({
          ObjectType: 'field',
          Name: key,
          Property: attribute,
          languagecode: lcid,
          description: text,
          Table: logical,
        });
    }
  }
  return out;
}

async function importRows(api, rows) {
  await writeState(api, () => {
    const dv = (api.store.state.dataverse ??= {});
    for (const row of rows) {
      const lcid = String(row.languagecode ?? '');
      if (!/^\d+$/.test(lcid)) continue;
      const text = row.description ?? '';
      if (text.length > LABEL_LIMIT) throw fail(`A translated label is longer than ${LABEL_LIMIT} characters.`);
      if (row.ObjectType === 'table') {
        const mapping = api.store.state.mappings[row.Name];
        if (!mapping || !TABLE_LABELS.includes(row.Property)) continue; // labels for components not in this organization are dropped
        mapping.dataverseMetadata ??= {};
        const labels = (mapping.dataverseMetadata.labels ??= {});
        labels[row.Property] = { ...(labels[row.Property] ?? {}), [lcid]: text };
      } else if (row.ObjectType === 'field') {
        dv.locLabels ??= {};
        dv.locLabels[row.Name] = { ...(dv.locLabels[row.Name] ?? {}), [lcid]: text };
      }
    }
  });
}

function exportFile(rows, root) {
  const xml = Buffer.from(labelXml(rows, root), 'utf8');
  return zipOf([
    { name: `${root}.xml`, data: xml },
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
  ]);
}

// CrmTranslations.xml (ExportTranslation, ImportTranslation) is SpreadsheetML 2003 with the three documented sheets.
// The Information sheet's rows, the empty Display Strings sheet and the Object Type "Record" of a row label are guesses.
const TRANSLATION_ZIP =
  'The translation file is invalid. The compressed file must contain the following files at its root: CrmTranslations.xml, [Content_Types].xml.';
const TRANSLATION_SCHEMA = 'The translations file is invalid or does not confirm to the required schema.';
const LABEL_COLUMNS = ['Entity Name', 'Object Type', 'Object Id', 'Object Column Name'];
const isLcid = (name) => /^\d+$/.test(name);
const cellXml = (value) => `<Cell><Data ss:Type="String">${xmlEsc(value ?? '')}</Data></Cell>`;
const sheetXml = (name, rows) =>
  `<Worksheet ss:Name="${xmlEsc(name)}"><Table>${rows.map((row) => `<Row>${row.map(cellXml).join('')}</Row>`).join('')}</Table></Worksheet>`;

// One row per label, one column per provisioned language. Table labels are Entity rows (Object Id: the entity's MetadataId).
function labelSheetOf(api) {
  const languages = provisionedOf(languagesOf(api));
  const metadata = createMetadataService({
    organizationId: api.settings.organizationId,
    schema: api.schema ?? null,
    mappings: () => api.store.state.mappings,
  });
  const lines = new Map();
  for (const row of exportRows(api, { fields: false })) {
    const [entity, objectType, objectId, column] =
      row.ObjectType === 'table'
        ? [row.Name, 'Entity', metadata.metadataId('entity', row.Name), row.Property]
        : [row.Table, 'Record', row.Name.split('|')[1], row.Property];
    const key = [entity, objectType, objectId, column].join('|');
    const line = lines.get(key) ?? { cells: [entity, objectType, objectId, column], labels: {} };
    line.labels[row.languagecode] = row.description;
    lines.set(key, line);
  }
  return [
    [...LABEL_COLUMNS, ...languages.map(String)],
    ...[...lines.values()].map((line) => [...line.cells, ...languages.map((lcid) => line.labels[lcid] ?? '')]),
  ];
}

function translationFile(api, solutionName) {
  const workbook =
    '<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?>' +
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">' +
    sheetXml('Information', [['Solution Name', solutionName]]) +
    sheetXml('Display Strings', []) +
    sheetXml('Localized Labels', labelSheetOf(api)) +
    '</Workbook>';
  return zipOf([
    { name: 'CrmTranslations.xml', data: Buffer.from(workbook, 'utf8') },
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
  ]);
}

// The Localized Labels sheet as the rows importRows takes. Every LCID column with text becomes one row.
function rowsOfWorkbook(text) {
  const sheet = /<Worksheet\b[^>]*ss:Name="Localized Labels"[^>]*>([\s\S]*?)<\/Worksheet>/.exec(text);
  if (!/<Workbook\b/.test(text) || !sheet) throw fail(TRANSLATION_SCHEMA, 400, 'InvalidRequest', '0x80044249');
  const grid = [...sheet[1].matchAll(/<Row\b[^>]*>([\s\S]*?)<\/Row>/g)].map(([, row]) =>
    [...row.matchAll(/<Cell\b[^>]*?(?:\/>|>([\s\S]*?)<\/Cell>)/g)].map(([, cell = '']) =>
      xmlUnesc(/<Data\b[^>]*>([\s\S]*?)<\/Data>/.exec(cell)?.[1] ?? ''),
    ),
  );
  const [header = [], ...body] = grid;
  const rows = [];
  for (const cells of body) {
    const record = Object.fromEntries(header.map((name, i) => [name, cells[i] ?? '']));
    const isTable = record['Object Type'] === 'Entity';
    const name = isTable
      ? record['Entity Name']
      : `${record['Entity Name']}|${record['Object Id']}|${record['Object Column Name']}`;
    for (const lcid of header.filter(isLcid)) {
      if (!record[lcid]) continue;
      rows.push({
        ObjectType: isTable ? 'table' : 'field',
        Name: name,
        Property: record['Object Column Name'],
        languagecode: lcid,
        description: record[lcid],
      });
    }
  }
  return rows;
}

// ImportTranslation's rows, parsed without writing so a bad file is a request error (ImportTranslationAsync parses first too).
function translationRows(base64) {
  const files = readZipFiles(Buffer.from(String(required(base64, 'TranslationFile')), 'base64'));
  const entry = files.get('CrmTranslations.xml');
  if (!entry) throw fail(TRANSLATION_ZIP, 400, 'InvalidRequest', '0x80048061');
  return rowsOfWorkbook(entry.toString('utf8'));
}

function fieldRows(base64) {
  const files = readZipFiles(Buffer.from(String(required(base64, 'TranslationFile')), 'base64'));
  const entry = files.get('CrmFieldTranslations.xml');
  if (!entry) throw fail('The translation file has no CrmFieldTranslations.xml.');
  return rowsOf(entry.toString('utf8'));
}

// ---- Operations ----
const reply = (body = {}) => ({ status: 200, body });
const noContent = () => ({ status: 204 });

// The Label the handler answers (native shape: LocalizedLabels and UserLocalizedLabel, both LocalizedLabel).
const CSDL_LOC_LABELS = `<ComplexType Name="LocalizedLabel">
  <Property Name="Label" Type="Edm.String" />
  <Property Name="LanguageCode" Type="Edm.Int32" />
</ComplexType>
<ComplexType Name="Label">
  <Property Name="LocalizedLabels" Type="Collection(mscrm.LocalizedLabel)" />
  <Property Name="UserLocalizedLabel" Type="mscrm.LocalizedLabel" />
</ComplexType>
<ComplexType Name="RetrieveLocLabelsResponse">
  <Property Name="Label" Type="mscrm.Label" />
</ComplexType>
<Function Name="RetrieveLocLabels">
  <Parameter Name="EntityMoniker" Type="mscrm.crmbaseentity" Nullable="false" />
  <Parameter Name="AttributeName" Type="Edm.String" Nullable="false" />
  <Parameter Name="IncludeUnpublished" Type="Edm.Boolean" Nullable="false" />
  <ReturnType Type="mscrm.RetrieveLocLabelsResponse" Nullable="false" />
</Function>`;

function operations(api) {
  const privilege = (c, name, entity) => requireMetadataPrivilege(api, c, name, entity);
  const solutionRow = (name) => {
    const row = (api.store.state.tables.solution ?? []).find((r) => lower(r.uniquename) === lower(name));
    if (!row) throw fail(`Solution ${name} does not exist.`, 404, 'NotFound');
    return row;
  };
  const key = (mapping, name) => {
    const found = (mapping.alternateKeys ?? []).find(
      (k) => lower(k.name) === lower(name) || lower(k.schemaName) === lower(name),
    );
    if (!found) throw fail(`Could not find the key ${name} of ${mapping.logicalName}.`, 404, 'NotFound');
    return found;
  };
  const languageArg = (c) => lcidOf(required(argOf(c, 'Language'), 'Language'), 'Language');

  const ops = [
    // References
    {
      name: 'CanBeReferenced',
      kind: 'action',
      signature: { params: [['EntityName', 'Edm.String']], response: [['CanBeReferenced', 'Edm.Boolean']] },
      handle: (c) => reply({ CanBeReferenced: canBeReferenced(tableOf(api, argOf(c, 'EntityName'))) }),
    },
    {
      name: 'CanBeReferencing',
      kind: 'action',
      signature: { params: [['EntityName', 'Edm.String']], response: [['CanBeReferencing', 'Edm.Boolean']] },
      handle: (c) => reply({ CanBeReferencing: canBeReferencing(tableOf(api, argOf(c, 'EntityName'))) }),
    },
    {
      name: 'CanManyToMany',
      kind: 'action',
      signature: { params: [['EntityName', 'Edm.String']], response: [['CanManyToMany', 'Edm.Boolean']] },
      handle: (c) => reply({ CanManyToMany: canManyToMany(tableOf(api, argOf(c, 'EntityName'))) }),
    },
    {
      name: 'GetValidManyToMany',
      kind: 'function',
      signature: { response: [['EntityNames', 'Collection(Edm.String)']] },
      handle: () => reply({ EntityNames: namesWhere(api, canManyToMany) }),
    },
    {
      name: 'GetValidReferencedEntities',
      kind: 'function',
      signature: {
        params: [['ReferencingEntityName', 'Edm.String']],
        response: [['EntityNames', 'Collection(Edm.String)']],
      },
      handle: async (c) => {
        const referencing = tableOf(api, argOf(c, 'ReferencingEntityName'));
        return reply({ EntityNames: canBeReferencing(referencing) ? namesWhere(api, canBeReferenced) : [] }); // the empty answer is a guess
      },
    },
    {
      name: 'GetValidReferencingEntities',
      kind: 'function',
      signature: {
        params: [['ReferencedEntityName', 'Edm.String']],
        response: [['EntityNames', 'Collection(Edm.String)']],
      },
      handle: async (c) => {
        const referenced = tableOf(api, argOf(c, 'ReferencedEntityName'));
        return reply({ EntityNames: canBeReferenced(referenced) ? namesWhere(api, canBeReferencing) : [] }); // the empty answer is a guess
      },
    },
    // Keys: indexStatus and asyncJob are read by keysOf (dataverse-metadata.mjs).
    {
      name: 'DeactivateEntityKey',
      kind: 'action',
      signature: {
        params: [
          ['EntityKeyLogicalName', 'Edm.String'],
          ['EntityLogicalName', 'Edm.String'],
        ],
      },
      handle: (c) => deactivateKey(c),
    },
    {
      name: 'ReactivateEntityKey',
      kind: 'action',
      signature: {
        params: [
          ['EntityKeyLogicalName', 'Edm.String'],
          ['EntityLogicalName', 'Edm.String'],
        ],
      },
      handle: (c) => reactivateKey(c),
    },
    // Publishing: Mirage applies every write at once, so these only check the declared shape (dataverse-metadata-tables.mjs).
    {
      name: 'PublishAllXml',
      kind: 'action',
      csdl: '<Action Name="PublishAllXml" />',
      handle: (c) => handleMetadataWrite({ ...c, api, route: { kind: 'function', name: 'PublishAllXml' } }),
    },
    {
      name: 'PublishAllXmlAsync',
      kind: 'action',
      signature: { response: [['AsyncOperationId', 'Edm.Guid']] },
      async handle(c) {
        // Writes already apply immediately in Mirage; the asynchronous publication stays observable as a system job.
        privilege(c, 'prvWriteEntity', 'solution'); // privilege is a guess, the same as synchronous publication
        const id = await api.systemJob(
          { name: 'Publish all customizations', operationtype: 204, callerId: c.caller?.systemuserid },
          () => handleMetadataWrite({ ...c, method: 'POST', api, route: { kind: 'function', name: 'PublishAllXml' } }),
        );
        return {
          status: 200,
          body: {
            '@odata.context': contextUrl(c.origin, c.version, 'Microsoft.Dynamics.CRM.PublishAllXmlAsyncResponse'),
            AsyncOperationId: id,
          },
        };
      },
    },
    {
      name: 'PublishXml',
      kind: 'action',
      csdl: '<Action Name="PublishXml"><Parameter Name="ParameterXml" Type="Edm.String" Nullable="false" Unicode="false" /></Action>',
      handle: (c) => handleMetadataWrite({ ...c, api, route: { kind: 'function', name: 'PublishXml' } }),
    },
    // Autonumber seeds
    {
      name: 'GetAutoNumberSeed',
      kind: 'action',
      signature: {
        params: [
          ['EntityName', 'Edm.String'],
          ['AttributeName', 'Edm.String'],
        ],
        response: [['AutoNumberSeedValue', 'Edm.Int64']],
      },
      handle: (c) => reply({ AutoNumberSeedValue: autoNumberOf(api, c).next }),
    },
    {
      name: 'GetNextAutoNumberValue',
      kind: 'action',
      signature: {
        params: [
          ['EntityName', 'Edm.String'],
          ['AttributeName', 'Edm.String'],
        ],
        response: [['NextAutoNumberValue', 'Edm.Int64']],
      },
      handle: (c) => reply({ NextAutoNumberValue: autoNumberOf(api, c).next }),
    },
    {
      name: 'SetAutoNumberSeed',
      kind: 'action',
      signature: {
        params: [
          ...[
            ['EntityName', 'Edm.String'],
            ['AttributeName', 'Edm.String'],
          ],
          ['Value', 'Edm.Int64'],
        ],
      },
      handle: async (c) => {
        const raw = argOf(c, 'Value');
        const value = Number(isExactNumeric(raw) ? raw.value : raw);
        if (!Number.isSafeInteger(value) || value < 0) throw fail('Value must be a non-negative whole number.');
        const { key: counterKey } = autoNumberOf(api, c);
        privilege(c, 'prvWriteAttribute', 'attribute');
        await writeState(api, () => {
          const settings = (api.store.state.settings ??= {});
          (settings.autoNumberSequences ??= {})[counterKey] = value;
        });
        return noContent();
      },
    },
    // Languages
    {
      name: 'RetrieveAvailableLanguages',
      kind: 'function',
      signature: { response: [['LocaleIds', 'Collection(Edm.Int32)']] },
      handle: () => reply({ LocaleIds: languagesOf(api).installed }),
    },
    {
      name: 'RetrieveInstalledLanguagePacks',
      kind: 'function',
      signature: { response: [['RetrieveInstalledLanguagePacks', 'Collection(Edm.Int32)']] },
      handle: () => reply({ RetrieveInstalledLanguagePacks: languagesOf(api).installed }),
    },
    {
      name: 'RetrieveDeprovisionedLanguages',
      kind: 'function',
      signature: { response: [['RetrieveDeprovisionedLanguages', 'Collection(Edm.Int32)']] },
      handle: () => reply({ RetrieveDeprovisionedLanguages: languagesOf(api).deprovisioned }),
    },
    {
      name: 'RetrieveProvisionedLanguages',
      kind: 'function',
      signature: { response: [['RetrieveProvisionedLanguages', 'Collection(Edm.Int32)']] },
      handle: () => reply({ RetrieveProvisionedLanguages: provisionedOf(languagesOf(api)) }),
    },
    {
      name: 'RetrieveInstalledLanguagePackVersion',
      kind: 'function',
      signature: { params: [['Language', 'Edm.Int32']], response: [['Version', 'Edm.String']] },
      handle: async (c) => {
        const lcid = languageArg(c);
        if (!languagesOf(api).installed.includes(lcid)) throw fail(`The language pack ${lcid} is not installed.`);
        return reply({ Version: api.settings?.version ?? '' }); // the pack version string is a guess
      },
    },
    {
      name: 'RetrieveProvisionedLanguagePackVersion',
      kind: 'function',
      signature: { params: [['Language', 'Edm.Int32']], response: [['Version', 'Edm.String']] },
      handle: async (c) => {
        const lcid = languageArg(c);
        if (!provisionedOf(languagesOf(api)).includes(lcid)) throw fail(`The language ${lcid} is not provisioned.`);
        return reply({ Version: api.settings?.version ?? '' }); // the pack version string is a guess
      },
    },
    {
      name: 'ProvisionLanguage',
      kind: 'action',
      signature: { params: [['Language', 'Edm.Int32']] },
      handle: async (c) => {
        privilege(c, 'prvWriteOrganization', 'organization');
        await provisionLanguage(api, languageArg(c));
        return noContent();
      },
    },
    {
      // The refusals are checked in the request; the provisioning runs as a system job (operationtype 209, dataverse-async.mjs).
      name: 'ProvisionLanguageAsync',
      kind: 'action',
      signature: { params: [['Language', 'Edm.Int32']], response: [['AsyncOperationId', 'Edm.Guid']] },
      handle: async (c) => {
        privilege(c, 'prvWriteOrganization', 'organization');
        const lcid = languageArg(c);
        checkProvision(api, lcid);
        const id = await api.systemJob(
          { name: `Provision language ${lcid}`, operationtype: 209, callerId: c.caller?.systemuserid },
          () => provisionLanguage(api, lcid),
        );
        return reply({ AsyncOperationId: id });
      },
    },
    {
      name: 'DeprovisionLanguage',
      kind: 'action',
      signature: {
        params: [
          ['Language', 'Edm.Int32'],
          ['CleanupLanguageRows', 'Edm.Boolean'],
        ],
      },
      handle: async (c) => {
        privilege(c, 'prvWriteOrganization', 'organization');
        await deprovisionLanguage(api, languageArg(c), argOf(c, 'CleanupLanguageRows') === true);
        return noContent();
      },
    },
    // Localized labels
    {
      name: 'SetLocLabels',
      kind: 'action',
      signature: {
        params: [
          ['EntityMoniker', 'mscrm.crmbaseentity'],
          ['AttributeName', 'Edm.String'],
          ['Labels', 'Collection(mscrm.LocalizedLabel)'],
        ],
      },
      handle: async (c) => {
        const { mapping, id } = monikerOf(api, argOf(c, 'EntityMoniker'));
        const attribute = localizedAttribute(mapping, argOf(c, 'AttributeName'));
        const labels = required(argOf(c, 'Labels'), 'Labels');
        if (!Array.isArray(labels)) throw fail('Labels must be a collection of LocalizedLabel.');
        privilege(c, 'prvWriteAttribute', 'attribute');
        const active = provisionedOf(languagesOf(api));
        await writeState(api, () => {
          const dv = (api.store.state.dataverse ??= {});
          dv.locLabels ??= {};
          const name = labelKey(mapping, id, attribute);
          const entry = { ...(dv.locLabels[name] ?? {}) };
          for (const item of labels) {
            const lcid = lcidOf(item?.LanguageCode, 'LanguageCode');
            if (!active.includes(lcid)) throw fail(`The language ${lcid} is not provisioned.`);
            if (item.Label == null || item.Label === '') delete entry[lcid];
            else entry[lcid] = String(item.Label);
          }
          dv.locLabels[name] = entry;
        });
        return noContent();
      },
    },
    {
      name: 'RetrieveLocLabels',
      kind: 'function',
      csdl: CSDL_LOC_LABELS,
      handle: async (c) => {
        const { mapping, id } = monikerOf(api, argOf(c, 'EntityMoniker'));
        const attribute = localizedAttribute(mapping, argOf(c, 'AttributeName'));
        const entry = api.store.state.dataverse?.locLabels?.[labelKey(mapping, id, attribute)] ?? {};
        const localized = Object.entries(entry).map(([lcid, text]) => ({ Label: text, LanguageCode: Number(lcid) }));
        const base = localized.find((label) => label.LanguageCode === baseOf(api)) ?? null;
        // IncludeUnpublished adds nothing: labels have no unpublished state here.
        return reply({ Label: { LocalizedLabels: localized, UserLocalizedLabel: base } });
      },
    },
    // Translations
    {
      name: 'ExportTranslation',
      kind: 'action',
      binding: 'collection',
      entity: 'solution',
      signature: { params: [['SolutionName', 'Edm.String']], response: [['ExportTranslationFile', 'Edm.Binary']] },
      handle: async (c) => {
        const solutionName = required(argOf(c, 'SolutionName'), 'SolutionName');
        solutionRow(solutionName); // ponytail: every table label is exported, not only the solution's components
        return reply({ ExportTranslationFile: translationFile(api, solutionName).toString('base64') });
      },
    },
    {
      name: 'ImportTranslation',
      kind: 'action',
      signature: {
        params: [
          ['TranslationFile', 'Edm.Binary'],
          ['ImportJobId', 'Edm.Guid'],
        ],
      },
      handle: async (c) => {
        privilege(c, 'prvWriteEntity', 'EntityDefinitions');
        await importRows(api, translationRows(argOf(c, 'TranslationFile')));
        return noContent();
      },
    },
    {
      // The file is parsed now (a bad file is a request error); the import runs as a system job (operationtype 210).
      name: 'ImportTranslationAsync',
      kind: 'action',
      signature: {
        params: [
          ['TranslationFile', 'Edm.Binary'],
          ['ImportJobId', 'Edm.Guid'],
        ],
        response: [['AsyncOperationId', 'Edm.Guid']],
      },
      handle: async (c) => {
        privilege(c, 'prvWriteEntity', 'EntityDefinitions');
        required(argOf(c, 'ImportJobId'), 'ImportJobId');
        const rows = translationRows(argOf(c, 'TranslationFile'));
        const id = await api.systemJob(
          { name: 'Import translation', operationtype: 210, callerId: c.caller?.systemuserid },
          () => importRows(api, rows),
        );
        return reply({ AsyncOperationId: id });
      },
    },
    {
      name: 'ExportFieldTranslation',
      kind: 'function',
      signature: { response: [['ExportTranslationFile', 'Edm.Binary']] },
      handle: () =>
        reply({
          ExportTranslationFile: exportFile(exportRows(api, { fields: true }), 'CrmFieldTranslations').toString(
            'base64',
          ),
        }),
    },
    {
      name: 'ImportFieldTranslation',
      kind: 'action',
      signature: { params: [['TranslationFile', 'Edm.Binary']], returns: 'mscrm.importjob' },
      handle: async (c) => {
        privilege(c, 'prvWriteEntity', 'EntityDefinitions');
        await importRows(api, fieldRows(argOf(c, 'TranslationFile')));
        return reply({ '@odata.type': 'Microsoft.Dynamics.CRM.importjob', importjobid: randomUUID() }); // the importjob body is a guess
      },
    },
  ];

  // Assumed native behavior: deactivation leaves the key Failed, and both key messages need prvWriteAttribute.
  function keyFor(c) {
    const mapping = tableOf(api, argOf(c, 'EntityLogicalName') ?? argOf(c, 'EntityName'));
    const found = key(
      mapping,
      required(argOf(c, 'EntityKeyLogicalName') ?? argOf(c, 'KeyName'), 'EntityKeyLogicalName'),
    );
    privilege(c, 'prvWriteAttribute', 'attribute');
    return { mapping, found };
  }

  async function deactivateKey(c) {
    const { found } = keyFor(c);
    if ((found.indexStatus ?? 'Active') !== 'Active')
      throw fail('Deactivate entity key is only supported for Active EntityKey.', 400, 'InvalidRequest', '0x8009050B');
    await writeState(api, () => {
      found.indexStatus = 'Failed';
      found.deactivated = true;
    });
    return noContent();
  }

  // "Create index for {0} for table {1}" is the index job's name. The job validates the data again (activateKey): the key
  // is Active when the values are unique and Failed again while duplicates remain.
  async function reactivateKey(c) {
    const { mapping, found } = keyFor(c);
    if (found.indexStatus !== 'Failed')
      throw fail('Reactivate entity key is only supported for failed job', 400, 'InvalidRequest', '0x80060897');
    await activateKey(api, mapping.logicalName, found.name, c.caller?.systemuserid ?? null);
    return noContent();
  }

  return ops;
}

export const EXTENSION = {
  name: 'dataverse-metadata-messages',
  install(api) {
    // Each operation's declaration comes from its csdl or signature (dataverse-operations.mjs), so $metadata lists it.
    for (const op of operations(api))
      api.registry.register({
        name: op.name,
        kind: op.kind,
        binding: op.binding ?? 'unbound',
        entity: op.entity,
        handle: op.handle,
        csdl: op.csdl,
        signature: op.signature,
      });
  },
};
