// Dataverse data messages: the recycle bin (the delete record hook, Restore, EmptyRecycleBin) and the classic import job
// (ParseImport, TransformImport, ImportRecordsImport). Assumptions: undocumented error codes and message texts, the
// privilege names, and the asyncoperation operationtype values chosen below.
import { randomUUID } from 'node:crypto';
import { DataError } from './data-error.mjs';
import { contextUrl, parseDataverseRoute, parsePrefer } from './dataverse-odata.mjs';
import { guidKey } from './dataverse-values.mjs';
import { privilegeDeniedError } from './dataverse-security.mjs';
import { parseEntityReference } from './data.mjs';
import { parseXmlDocument, xmlEscapeAttribute } from './fetchxml-engine.mjs';
import { registerInternalMessage } from './dataverse-addon-common.mjs';
import { requireMetadataPrivilege } from './dataverse-metadata-relationships.mjs';

const CRM = 'Microsoft.Dynamics.CRM.';
const nowIso = () => new Date().toISOString();
const invalid = (message, innerCode = '0x80040203') => new DataError(message, 400, 'InvalidRequest', { innerCode });
const bodyOf = (c) => {
  if (typeof c.body !== 'string') return c.body ?? {};
  try {
    return JSON.parse(c.body || '{}');
  } catch {
    throw invalid('Request body is not valid JSON.');
  }
};
const reply = (c, name, fields) => ({
  status: 200,
  body: { '@odata.context': contextUrl(c.origin, c.version, `${CRM}${name}Response`), ...fields },
});

// --- Recycle bin
// EmptyRecycleBin requires System Administrator. prvBulkDelete is used only in the refusal error, whose native shape is
// not known.
const RECYCLE_PRIVILEGE = 'prvBulkDelete';
const REFERENCE = 'deleteditemreference';
const NEVER_RECYCLED = new Set([REFERENCE, 'recyclebinconfig']);

// A table is recycled when its recyclebinconfig row is Active and ready; a table with no row of its own takes the
// 'organization' row (the default). No row at all means the table is not recycled.
function recycleBinEnabled(store, logical) {
  const rows = store.state.tables.recyclebinconfig ?? [];
  const row =
    rows.find((r) => r.name === logical) ??
    rows.find((r) => r.bintablename === logical) ??
    rows.find((r) => r.name === 'organization') ??
    rows.find((r) => r.bintablename === 'organization');
  return Boolean(row) && Number(row.statecode) === 0 && row.isreadyforrecyclebin === true;
}

// The reference row points at a stored JSON snapshot of the deleted row, kept as a file on the reference (deletedrecords).
// Assumptions: the snapshot's file name and mime type; the reference's statecode/statuscode values.
function writeReference(store, entries, identity) {
  const root = entries.at(-1);
  if (!root) return;
  const mapping = store.resolveMapping(root.logicalName),
    snapshot = root.row,
    id = snapshot[mapping.idColumn];
  const refId = randomUUID();
  const name = `${mapping.logicalName}.json`;
  const data = Buffer.from(JSON.stringify(entries));
  const fileId = randomUUID();
  ((store.state.dataverse ??= {}).files ??= {})[fileId] = {
    entity: REFERENCE,
    recordId: refId,
    column: 'deletedrecords',
    name,
    mimeType: 'application/json',
    size: data.length,
    data: data.toString('base64'),
    createdOn: nowIso(),
  };
  store.insertRow(REFERENCE, (store.state.tables[REFERENCE] ??= []), {
    deleteditemreferenceid: refId,
    name: String(snapshot[mapping.nameColumn] ?? id),
    deletedobject: id,
    deletedobjectidtype: mapping.logicalName,
    deletedrecords: fileId,
    deletedrecords_name: name,
    validforrestore: true,
    totalrecords: entries.length,
    processedrecords: entries.length,
    statecode: 0,
    statuscode: 1,
    createdon: nowIso(),
    createdby: identity?.dataverse?.callerId,
  });
}

const snapshotsOf = (store, reference) => {
  const file = store.state.dataverse?.files?.[reference.deletedrecords];
  if (!file) return [];
  const value = JSON.parse(Buffer.from(file.data, 'base64').toString('utf8'));
  return Array.isArray(value) ? value : [{ logicalName: reference.deletedobjectidtype, row: value }];
};
export function binRows(store, logical) {
  return (store.state.tables[REFERENCE] ?? [])
    .filter((ref) => ref.validforrestore)
    .flatMap((ref) => snapshotsOf(store, ref))
    .filter((entry) => entry.logicalName === logical)
    .map((entry) => structuredClone(entry.row));
}
const retainedRows = (store, logical) => structuredClone(store.state.dataverse?.retained?.[logical] ?? []);
const eligible = (mapping) =>
  !NEVER_RECYCLED.has(mapping.logicalName) &&
  !/^(?:elastic|virtual)$/i.test(mapping.tableType ?? '') &&
  !mapping.isVirtual;
const targetRef = (store, target) => {
  const type = String(target?.['@odata.type'] ?? '').replace(/^#?Microsoft\.Dynamics\.CRM\./, '');
  if (type) {
    const mapping = store.resolveMapping(type),
      id = guidKey(target[mapping.idColumn]);
    if (!id) throw invalid('Target must carry the entity primary key.');
    return { mapping, id };
  }
  const reference = typeof target === 'string' ? target : target?.['@odata.id'];
  const parsed =
    typeof reference === 'string' &&
    parseEntityReference(
      reference
        .trim()
        .replace(/^https?:\/\/[^/]+/i, '')
        .replace(/^\/?api\/data\/v\d+\.\d+\//i, ''),
    );
  if (!parsed?.id) throw invalid('Target must identify a record.');
  return { mapping: store.resolveMapping(parsed.entitySet ?? parsed.set ?? parsed.entity), id: guidKey(parsed.id) };
};

// Deletes a reference and its snapshot file; the caller holds the transaction.
function dropReference(store, key) {
  const files = ((store.state.dataverse ??= {}).files ??= {});
  const rows = store.state.tables[REFERENCE] ?? [];
  const index = rows.findIndex((r) => guidKey(r.deleteditemreferenceid) === key);
  if (index < 0) return;
  const [row] = rows.splice(index, 1);
  if (row.deletedrecords && files[row.deletedrecords]) delete files[row.deletedrecords];
}

// Restore takes the deleted record as Target; a deleteditemreference target is accepted too.
// The documented conflict codes distinguish primary keys, alternate keys, removed choices and missing lookups;
// the refusal text and status are guesses where the reference gives no wire response.
function restore(api) {
  return async (c) => {
    const { store } = api;
    const input = bodyOf(c);
    const target = targetRef(store, input.Target);
    const references = store.state.tables[REFERENCE] ?? [];
    const ref = references.find((r) =>
      target.mapping.logicalName === REFERENCE
        ? guidKey(r.deleteditemreferenceid) === target.id
        : r.deletedobjectidtype === target.mapping.logicalName && guidKey(r.deletedobject) === target.id,
    );
    if (!ref) {
      if (
        references.some((r) =>
          snapshotsOf(store, r).some(
            (entry) =>
              entry.logicalName === target.mapping.logicalName &&
              guidKey(entry.row[target.mapping.idColumn]) === target.id,
          ),
        )
      ) {
        throw invalid('A record deleted by a cascade is restored with its parent.');
      }
      throw new DataError(`${REFERENCE} With Id = ${target.id} Does Not Exist`, 404, 'NotFound', {
        innerCode: '0x80040217',
      });
    }
    if (!ref.validforrestore) throw invalid('The deleted record cannot be restored.');
    const entries = snapshotsOf(store, ref);
    if (!entries.length) throw invalid('The deleted record has no stored data.');
    const root = entries.at(-1),
      logical = root.logicalName,
      mapping = store.resolveMapping(logical);
    const snapshot = {
      ...root.row,
      ...Object.fromEntries(
        Object.entries(input.Target ?? {}).filter(
          ([name]) => !name.startsWith('@odata.') && target.mapping.logicalName !== REFERENCE,
        ),
      ),
    };
    api.principals.authorize({ user: c.user, entity: logical, operation: 'create', mapping });
    const id = snapshot[mapping.idColumn];
    await api.change(() =>
      store.transact(
        () => {
          for (const entry of [...entries].reverse()) {
            const row = entry === root ? snapshot : entry.row,
              m = store.resolveMapping(entry.logicalName),
              rows = (store.state.tables[m.logicalName] ??= []);
            api.principals.authorize({ user: c.user, entity: m.logicalName, operation: 'create', mapping: m });
            if (rows.some((r) => guidKey(r[m.idColumn]) === guidKey(row[m.idColumn])))
              throw invalid(
                `Please delete the existing conflicting record '${m.logicalName}' with primary key '${m.idColumn}' and primary key value '${row[m.idColumn]}' before attempting restore.`,
                '0x80049939',
              );
            try {
              store.assertAlternateKeys(m, row, rows, -1);
            } catch (error) {
              if (error.code !== 'DuplicateRecord') throw error;
              throw invalid(
                `Duplicate entity key preventing restore of record '${m.logicalName}' with primary key '${m.idColumn}' and primary key value '${row[m.idColumn]}'. See inner exception for entity key details.`,
                '0x80049929',
              );
            }
            for (const [column, definition] of Object.entries(m.fields ?? {})) {
              const value = row[column]?.id ?? row[column];
              if (value == null) continue;
              if (
                definition.options?.length &&
                definition.optionSetOpen !== true &&
                !definition.options.some((option) => String(option.value ?? option.Value) === String(value))
              )
                throw invalid(
                  'Picklist value not valid, please add the invalid value back to the picklist before restoring record. See inner exception for details.',
                  '0x80049949',
                );
              const targets = definition.targets ?? definition.lookupTargets;
              if (
                targets?.length &&
                !targets.some((name) => {
                  const m = store.resolveMapping(name);
                  return (store.state.tables[name] ?? []).some((r) => guidKey(r[m.idColumn]) === guidKey(value));
                })
              )
                throw invalid(
                  `Entity with id '${value}' and logical name '${targets[0]}' does not exist. We cannot restore the reference '${column}' that must be restored as part of this Restore call.`,
                  '0x80049959',
                );
            }
            store.insertRow(m.logicalName, rows, structuredClone(row));
          }
          dropReference(store, guidKey(ref.deleteditemreferenceid));
        },
        { isolated: true },
      ),
    );
    return reply(c, 'Restore', { id });
  };
}

// EmptyRecycleBin (System Administrator only) deletes every reference and answers the count.
function emptyRecycleBin(api) {
  return async (c) => {
    const { store } = api;
    if (!api.principals.roles(c.user).some((role) => role.name === 'System Administrator'))
      throw privilegeDeniedError(c.user, RECYCLE_PRIVILEGE, REFERENCE);
    const keys = (store.state.tables[REFERENCE] ?? []).map((r) => guidKey(r.deleteditemreferenceid));
    await api.change(() =>
      store.transact(
        () => {
          for (const key of keys) {
            const reference = (store.state.tables[REFERENCE] ?? []).find(
              (row) => guidKey(row.deleteditemreferenceid) === key,
            );
            for (const entry of snapshotsOf(store, reference)) {
              const mapping = store.resolveMapping(entry.logicalName);
              for (const [fileId, file] of Object.entries(store.state.dataverse?.files ?? {}))
                if (file.entity === entry.logicalName && sameId(file.recordId, entry.row[mapping.idColumn]))
                  delete store.state.dataverse.files[fileId];
            }
            dropReference(store, key);
          }
        },
        { isolated: true },
      ),
    );
    return reply(c, 'EmptyRecycleBin', { DeletedCount: keys.length });
  };
}

// --- Import
// Choice values of importfile.processingstatus and asyncoperation.operationtype.
const STATUS = { parsingComplete: 3, transformationComplete: 8, importComplete: 11 };
const OPERATION = { importFileParse: 3, import: 5 }; // assumed: TransformImport and ImportRecordsImport share 5
const LOG_PHASE_CREATE = 2; // importlog.logphasecode: 0 parse, 1 transform, 2 create, 3 update

// CSV fields use the standard importfile delimiter choices, including doubled quotes and CR/LF/CRLF line endings.
export function parseCsv(text, { delimiter = ',', quote = '"' } = {}) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== quote) field += ch;
      else if (text[i + 1] === quote) {
        field += quote;
        i++;
      } else quoted = false;
    } else if (quote && ch === quote) quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}
const csvOf = (file) =>
  parseCsv(String(file.content ?? ''), {
    delimiter: { 1: ':', 2: ',', 3: '\t', 4: ';' }[file.fielddelimitercode] ?? ',',
    quote: { 1: '"', 2: '', 3: "'" }[file.datadelimitercode] ?? '"',
  });
const idOf = (value) => guidKey(value?.id ?? value);
const sameId = (a, b) => idOf(a) != null && idOf(a) === idOf(b);
const mapOf = (store, file) => {
  if (!file.importmapid) return null;
  const map = (store.state.tables.importmap ?? []).find((row) => sameId(row.importmapid, file.importmapid));
  if (!map) throw invalid('The import map does not exist.');
  return (store.state.tables.columnmapping ?? []).filter(
    (row) =>
      sameId(row.importmapid, file.importmapid) &&
      row.targetentityname === file.targetentityname &&
      Number(row.processcode ?? 1) === 1 &&
      (!row.sourceentityname || !file.sourceentityname || row.sourceentityname === file.sourceentityname),
  );
};
const logFailure = (store, file, phase, line, message) =>
  store.insertRow('importlog', (store.state.tables.importlog ??= []), {
    importlogid: randomUUID(),
    importfileid: file.importfileid,
    linenumber: line,
    logphasecode: phase,
    errordescription: message,
    errornumber: 0,
    createdon: nowIso(),
  });

// The import's files, in table order.
const filesOfImport = (store, importId) =>
  (store.state.tables.importfile ?? []).filter((f) => sameId(f.importid, importId));

// Each job runs as a system job of dataverse-async. The asyncoperation row carries regardingobjectid = the import.
function importJob(api, { name, operation, importId, callerId, work }) {
  return api.systemJob({ name, operationtype: operation, regardingobjectid: importId, callerId }, work);
}

function asImportAction(api, name, operation, workFor) {
  return async (c) => {
    const { store } = api;
    const importId = c.target?.id ?? guidKey(bodyOf(c).ImportId);
    if (!importId) throw invalid('ImportId is required.');
    const importRow = rowById(api, c, 'import', importId);
    authorize(api, c, 'import', 'update', importRow);
    const files = filesOfImport(store, importId);
    if (!files.length) throw new DataError(`import With Id = ${importId} has no import file.`, 400, 'InvalidRequest'); // native message text not known
    for (const file of files) authorize(api, c, 'importfile', 'update', file);
    const jobId = await importJob(api, {
      name,
      operation,
      importId,
      callerId: c.caller?.systemuserid ?? c.user?.systemuserid,
      work: () => workFor({ c, files: filesOfImport(store, importId) }),
    });
    return {
      status: 200,
      body: {
        '@odata.context': contextUrl(c.origin, c.version, 'asyncoperations/$entity'),
        '@odata.type': `#${CRM}asyncoperation`,
        asyncoperationid: jobId,
      },
    };
  };
}

// Writes one importfile field set inside the job's transaction.
const setFile = (api, file, values) =>
  api.change(() =>
    api.store.transact(
      () => {
        const row = (api.store.state.tables.importfile ?? []).find(
          (r) => guidKey(r.importfileid) === guidKey(file.importfileid),
        );
        if (row) Object.assign(row, values);
      },
      { isolated: true },
    ),
  );

// ParseImport: reads each file's header line and row count. Assumption: the header is stored comma-joined in headerrow.
function parseWork(api) {
  return async ({ files }) => {
    for (const file of files) {
      const rows = csvOf(file);
      const header =
        file.isfirstrowheader === false ? (rows[0] ?? []).map((_, i) => `Column${i + 1}`) : (rows[0] ?? []);
      await setFile(api, file, {
        headerrow: header.join(','),
        parsedtablecolumnsnumber: header.length,
        totalcount: Math.max(0, rows.length - (file.isfirstrowheader === false ? 0 : 1)),
        processingstatus: STATUS.parsingComplete,
      });
    }
    return `${files.length} import file(s) parsed`;
  };
}

// TransformImport: a file that parsed moves to Transformation Complete. Attribute mapping happens in ImportRecordsImport.
function transformWork(api) {
  return async ({ files }) => {
    for (const file of files) {
      if (file.processingstatus !== STATUS.parsingComplete) throw invalid('The import file has not been parsed.'); // native wording and code not known
      try {
        const columns = mapOf(api.store, file),
          target = api.store.resolveMapping(file.targetentityname);
        if (columns?.some((column) => !Object.hasOwn(target.fields ?? {}, column.targetattributename)))
          throw invalid('An import map target attribute does not exist.');
      } catch (error) {
        await api.change(() =>
          api.store.transact(() => logFailure(api.store, file, 1, 0, error.message), { isolated: true }),
        );
        await setFile(api, file, { processingstatus: 6 });
        throw error;
      }
      await setFile(api, file, { processingstatus: STATUS.transformationComplete });
    }
    return `${files.length} import file(s) transformed`;
  };
}

// ImportRecordsImport applies configured column, picklist, system lookup and owner mappings. Without an import map,
// logical column names remain the fallback. A failed row is logged and subsequent rows continue.
function importWork(api, c) {
  return async ({ files }) => {
    const { store } = api;
    let created = 0;
    let failed = 0;
    for (const file of files) {
      let fileCreated = 0,
        fileFailed = 0;
      const logical = String(file.targetentityname ?? '');
      const mapping = store.resolveMapping(logical);
      api.principals.authorize({ user: c.user, entity: logical, operation: 'create', mapping });
      const rows = csvOf(file),
        columns = mapOf(store, file);
      const header =
        file.isfirstrowheader === false ? (rows[0] ?? []).map((_, i) => `Column${i + 1}`) : (rows[0] ?? []);
      const fields = header.map((name) =>
        columns
          ? (columns.find(
              (column) => String(column.sourceattributename).toLowerCase() === String(name).trim().toLowerCase(),
            ) ?? null)
          : {
              targetattributename:
                Object.keys(mapping.fields ?? {}).find(
                  (field) => field.toLowerCase() === String(name).trim().toLowerCase(),
                ) ?? null,
            },
      );
      const body = file.isfirstrowheader === false ? rows : rows.slice(1);
      let line = file.isfirstrowheader === false ? 1 : 2;
      for (const cells of body) {
        const data = {};
        try {
          fields.forEach((column, index) => {
            const field = column?.targetattributename,
              cell = cells[index];
            if (!field || cell === undefined || cell === '') return;
            let value = cell;
            const choices = (store.state.tables.picklistmapping ?? []).filter(
              (row) => sameId(row.columnmappingid, column.columnmappingid) && Number(row.processcode ?? 1) === 1,
            );
            if (choices.length) {
              const choice = choices.find((row) => String(row.sourcevalue) === cell);
              if (!choice) throw invalid(`No picklist mapping for '${cell}'.`);
              value = choice.targetvalue;
            }
            const lookups = (store.state.tables.lookupmapping ?? []).filter(
              (row) => sameId(row.columnmappingid, column.columnmappingid) && Number(row.processcode ?? 1) === 1,
            );
            if (lookups.length) {
              if (lookups.some((lookup) => Number(lookup.lookupsourcecode) !== 1))
                throw invalid('Source-file lookup mappings require an imported source-row adapter.');
              const match = lookups
                .map((lookup) => {
                  const target = store.resolveMapping(lookup.lookupentityname);
                  const row = (store.state.tables[target.logicalName] ?? []).find(
                    (row) => String(row[lookup.lookupattributename]) === cell,
                  );
                  return row ? { id: row[target.idColumn], logical_name: target.logicalName } : null;
                })
                .find(Boolean);
              if (!match) throw invalid(`No lookup mapping for '${cell}'.`);
              value = match;
            }
            if (field === 'ownerid' && file.importmapid) {
              const owner = (store.state.tables.ownermapping ?? []).find(
                (row) =>
                  sameId(row.importmapid, file.importmapid) &&
                  row.sourcesystemusername === cell &&
                  Number(row.processcode ?? 1) === 1,
              );
              if (owner) value = { id: owner.targetsystemuserid, logical_name: 'systemuser' };
            }
            data[field] = value;
          });
          // CSV values pass the import transformer first, then the same caller-authorized record pipeline as a
          // normal Dataverse create. Its transaction supplies system stamps, lookup/FLS checks and real-time hooks.
          store.coerceRecord(mapping, data, { metadata: api.metadataFields });
          for (const [field, value] of Object.entries(data)) {
            if (!value || typeof value !== 'object' || !value.id || !value.logical_name) continue;
            const target = store.resolveMapping(value.logical_name);
            delete data[field];
            data[`${field}@odata.bind`] = `/${target.entitySet}(${value.id})`;
          }
          const url = new URL(`${c.origin}/api/data/${c.version}/${mapping.entitySet}`);
          const result = await api.records.handle({
            ...c,
            method: 'POST',
            url,
            route: parseDataverseRoute(url.pathname),
            body: data,
            headers: { 'content-type': 'application/json' },
            prefer: parsePrefer(undefined),
          });
          if (result.status >= 400) throw invalid(result.body?.error?.message ?? 'The imported row was refused.');
          created++;
          fileCreated++;
        } catch (error) {
          failed++;
          fileFailed++;
          await api.change(() =>
            store.transact(
              () => {
                logFailure(store, file, LOG_PHASE_CREATE, line, error.message);
              },
              { isolated: true },
            ),
          );
        }
        line++;
      }
      await setFile(api, file, {
        processingstatus: STATUS.importComplete,
        successcount: fileCreated,
        failurecount: fileFailed,
      });
    }
    return `${created} record(s) created, ${failed} failed`;
  };
}

const argsOf = (c) => ({ ...bodyOf(c), ...(c.params ?? {}) });
const authorize = (api, c, logical, operation, row) =>
  api.principals.authorize({
    user: c.user,
    entity: logical,
    operation,
    row,
    mapping: api.store.resolveMapping(logical),
  });
const rowById = (api, c, logical, id) => {
  const mapping = api.store.resolveMapping(logical),
    row = (api.store.state.tables[logical] ?? []).find((row) => sameId(row[mapping.idColumn], id));
  if (!row)
    throw new DataError(`${logical} With Id = ${id} Does Not Exist`, 404, 'NotFound', { innerCode: '0x80040217' });
  authorize(api, c, logical, 'read', row);
  return row;
};
const parsedRows = (file) => {
  if (Number(file.processingstatus) < 3) throw invalid('The import file has not been parsed.');
  if (Number(file.processingstatus) === 11)
    throw invalid('Cannot access the parse table after the import has completed.');
  const rows = csvOf(file);
  return {
    columns: file.isfirstrowheader === false ? (rows[0] ?? []).map((_, i) => `Column${i + 1}`) : (rows[0] ?? []),
    rows: file.isfirstrowheader === false ? rows : rows.slice(1),
  };
};
const pageRows = (rows, page = 1, count = 5000) => {
  const p = Number(page ?? 1),
    n = Number(count ?? 5000);
  if (!Number.isSafeInteger(p) || p < 1 || !Number.isSafeInteger(n) || n < 1 || n > 5000)
    throw invalid('Paging requires a positive page and a count between 1 and 5000.');
  return rows.slice((p - 1) * n, p * n);
};
const childNodes = (node, name) => node?.children.filter((item) => item.name === name) ?? [];
const childText = (node, name) => childNodes(node, name)[0]?.text.trim() ?? '';
const nestedNodes = (node, wrapper, name) => childNodes(childNodes(node, wrapper)[0], name);
const processCode = (value) => ({ Process: 1, Ignore: 2, Internal: 3 })[value] ?? (Number(value) || 1);
const codeText = (value) => ({ 1: 'Process', 2: 'Ignore', 3: 'Internal' })[value] ?? 'Process';
const xmlText = (name, value) => `<${name}>${xmlEscapeAttribute(String(value ?? ''))}</${name}>`;

function importMappings(api) {
  return async (c) => {
    const { MappingsXml, ReplaceIds } = argsOf(c);
    if (typeof MappingsXml !== 'string' || !MappingsXml.trim()) throw invalid('MappingsXml is required.');
    const map = parseXmlDocument(MappingsXml, { root: 'Map' });
    authorize(api, c, 'importmap', 'create');
    const id = (node, attribute) =>
      ReplaceIds === false && guidKey(node.attrs[attribute]) ? guidKey(node.attrs[attribute]) : randomUUID();
    const mapId = id(map, 'ImportMapId'),
      row = {
        importmapid: mapId,
        name: map.attrs.Name ?? '',
        source: map.attrs.Source ?? '',
        description: childText(map, 'Description'),
        entitiesperfile: Number(childText(map, 'EntitiesPerFile')) || 1,
      };
    const put = (logical, value) => {
      authorize(api, c, logical, 'create');
      const mapping = api.store.resolveMapping(logical),
        rows = (api.store.state.tables[logical] ??= []);
      if (rows.some((existing) => sameId(existing[mapping.idColumn], value[mapping.idColumn])))
        throw invalid(`${logical} primary key already exists.`);
      api.store.insertRow(logical, rows, value);
    };
    await api.change(() =>
      api.store.transact(
        () => {
          put('importmap', row);
          for (const entity of nestedNodes(map, 'EntityMaps', 'EntityMap')) {
            const common = {
              importmapid: mapId,
              sourceentityname: entity.attrs.SourceEntityName ?? '',
              targetentityname: entity.attrs.TargetEntityName ?? '',
            };
            put('importentitymapping', {
              ...common,
              importentitymappingid: id(entity, 'ImportEntityMappingId'),
              processcode: processCode(entity.attrs.ProcessCode),
              dedupe: entity.attrs.Dedupe === 'true',
            });
            for (const column of nestedNodes(entity, 'AttributeMaps', 'AttributeMap')) {
              const columnId = id(column, 'ColumnMappingId');
              put('columnmapping', {
                ...common,
                columnmappingid: columnId,
                sourceattributename: childText(column, 'SourceAttributeName'),
                targetattributename: childText(column, 'TargetAttributeName'),
                processcode: processCode(childText(column, 'ProcessCode')),
              });
              for (const choice of nestedNodes(column, 'PicklistMaps', 'PicklistMap'))
                put('picklistmapping', {
                  picklistmappingid: id(choice, 'PicklistMappingId'),
                  columnmappingid: columnId,
                  sourcevalue: childText(choice, 'SourceValue'),
                  targetvalue: Number(childText(choice, 'TargetValue')),
                  processcode: processCode(childText(choice, 'ProcessCode')),
                });
              for (const lookup of nestedNodes(column, 'LookupMaps', 'LookupMap'))
                put('lookupmapping', {
                  lookupmappingid: id(lookup, 'LookupMappingId'),
                  columnmappingid: columnId,
                  lookupsourcecode: childText(lookup, 'LookupType') === 'Source' ? 0 : 1,
                  lookupentityname: childText(lookup, 'LookupEntityName'),
                  lookupattributename: childText(lookup, 'LookupAttributeName'),
                  processcode: processCode(childText(lookup, 'ProcessCode')),
                });
            }
            for (const owner of nestedNodes(entity, 'OwnerMaps', 'OwnerMap'))
              put('ownermapping', {
                ownermappingid: id(owner, 'OwnerMappingId'),
                importmapid: mapId,
                sourcesystemusername: childText(owner, 'SourceSystemUserName'),
                targetsystemuserid: childText(owner, 'TargetSystemUserId'),
                processcode: processCode(childText(owner, 'ProcessCode')),
              });
          }
        },
        { isolated: true },
      ),
    );
    return {
      status: 200,
      body: {
        '@odata.context': contextUrl(c.origin, c.version, 'importmaps/$entity'),
        '@odata.type': `#${CRM}importmap`,
        ...row,
      },
    };
  };
}

function exportMappings(api) {
  return (c) => {
    const map = rowById(api, c, 'importmap', c.target.id),
      exportIds = argsOf(c).ExportIds === true;
    const idAttr = (name, value) => (exportIds ? ` ${name}="${xmlEscapeAttribute(String(value))}"` : '');
    const rows = (logical, predicate) => (api.store.state.tables[logical] ?? []).filter(predicate);
    const entities = rows('importentitymapping', (row) => sameId(row.importmapid, map.importmapid));
    const attributeXml = (column) => {
      const picklists = rows('picklistmapping', (row) => sameId(row.columnmappingid, column.columnmappingid))
        .map(
          (row) =>
            `<PicklistMap${idAttr('PicklistMappingId', row.picklistmappingid)}>${xmlText('SourceValue', row.sourcevalue)}${xmlText('TargetValue', row.targetvalue)}${xmlText('ProcessCode', codeText(row.processcode))}</PicklistMap>`,
        )
        .join('');
      const lookups = rows('lookupmapping', (row) => sameId(row.columnmappingid, column.columnmappingid))
        .map(
          (row) =>
            `<LookupMap${idAttr('LookupMappingId', row.lookupmappingid)}>${xmlText('LookupType', row.lookupsourcecode === 0 ? 'Source' : 'System')}${xmlText('LookupEntityName', row.lookupentityname)}${xmlText('LookupAttributeName', row.lookupattributename)}${xmlText('ProcessCode', codeText(row.processcode))}</LookupMap>`,
        )
        .join('');
      return `<AttributeMap${idAttr('ColumnMappingId', column.columnmappingid)}>${xmlText('SourceAttributeName', column.sourceattributename)}${xmlText('TargetAttributeName', column.targetattributename)}${xmlText('ProcessCode', codeText(column.processcode))}<PicklistMaps>${picklists}</PicklistMaps><LookupMaps>${lookups}</LookupMaps></AttributeMap>`;
    };
    const xml = `<Map Name="${xmlEscapeAttribute(map.name ?? '')}" Source="${xmlEscapeAttribute(map.source ?? '')}"${idAttr('ImportMapId', map.importmapid)}>${xmlText('Description', map.description)}${xmlText('EntitiesPerFile', map.entitiesperfile ?? 1)}<EntityMaps>${entities
      .map((entity) => {
        const columns = rows(
          'columnmapping',
          (row) =>
            sameId(row.importmapid, map.importmapid) &&
            row.sourceentityname === entity.sourceentityname &&
            row.targetentityname === entity.targetentityname,
        );
        const owners = rows('ownermapping', (row) => sameId(row.importmapid, map.importmapid))
          .map(
            (row) =>
              `<OwnerMap${idAttr('OwnerMappingId', row.ownermappingid)}>${xmlText('SourceSystemUserName', row.sourcesystemusername)}${xmlText('TargetSystemUserId', row.targetsystemuserid)}${xmlText('ProcessCode', codeText(row.processcode))}</OwnerMap>`,
          )
          .join('');
        return `<EntityMap SourceEntityName="${xmlEscapeAttribute(entity.sourceentityname ?? '')}" TargetEntityName="${xmlEscapeAttribute(entity.targetentityname ?? '')}" ProcessCode="${codeText(entity.processcode)}" Dedupe="${Boolean(entity.dedupe)}"${idAttr('ImportEntityMappingId', entity.importentitymappingid)}><AttributeMaps>${columns.map(attributeXml).join('')}</AttributeMaps><OwnerMaps>${owners}</OwnerMaps></EntityMap>`;
      })
      .join('')}</EntityMaps></Map>`;
    return reply(c, 'ExportMappingsImportMap', { MappingsXml: xml });
  };
}

function installImportMessages(api) {
  const register = (spec) => api.registry.register({ binding: 'unbound', ...spec });
  register({
    name: 'ImportMappingsImportMap',
    kind: 'action',
    signature: {
      params: [
        ['MappingsXml', 'Edm.String'],
        ['ReplaceIds', 'Edm.Boolean'],
      ],
      returns: 'mscrm.importmap',
    },
    handle: importMappings(api),
  });
  register({
    name: 'ExportMappingsImportMap',
    kind: 'action',
    binding: 'entity',
    entity: 'importmap',
    signature: { params: [['ExportIds', 'Edm.Boolean']], response: [['MappingsXml', 'Edm.String']] },
    handle: exportMappings(api),
  });
  register({
    name: 'AutoMapEntity',
    kind: 'action',
    signature: { params: [['EntityMapId', 'Edm.Guid']] },
    handle: async (c) => {
      // Mapping is customization metadata, so the customization privilege gate applies; the native AutoMapEntity
      // privilege is not documented.
      requireMetadataPrivilege(api, c, 'prvWriteEntity', 'entitymap');
      const id = argsOf(c).EntityMapId,
        map = (api.store.state.tables.entitymap ?? []).find((row) => sameId(row.entitymapid, id));
      if (!map)
        throw new DataError(`entitymap With Id = ${id} Does Not Exist`, 404, 'NotFound', { innerCode: '0x80040217' });
      const source = api.store.resolveMapping(map.sourceentityname),
        target = api.store.resolveMapping(map.targetentityname);
      await api.change(() =>
        api.store.transact(
          () => {
            const rows = (api.store.state.tables.attributemap ??= []);
            for (let i = rows.length - 1; i >= 0; i--)
              if (sameId(rows[i].entitymapid, map.entitymapid)) api.store.removeRow('attributemap', rows, i);
            for (const [name, definition] of Object.entries(source.fields ?? {}))
              if (
                name !== source.idColumn &&
                name !== target.idColumn &&
                target.fields?.[name]?.dataverseType === definition.dataverseType
              )
                api.store.insertRow('attributemap', rows, {
                  attributemapid: randomUUID(),
                  entitymapid: map.entitymapid,
                  sourceattributename: name,
                  targetattributename: name,
                });
          },
          { isolated: true },
        ),
      );
      return { status: 204 };
    },
  });
  register({
    name: 'GetHeaderColumnsImportFile',
    kind: 'function',
    binding: 'entity',
    entity: 'importfile',
    signature: { response: [['Columns', 'Collection(Edm.String)']] },
    handle: (c) =>
      reply(c, 'GetHeaderColumnsImportFile', {
        Columns: parsedRows(rowById(api, c, 'importfile', c.target.id)).columns,
      }),
  });
  register({
    name: 'GetDistinctValuesImportFile',
    kind: 'function',
    binding: 'entity',
    entity: 'importfile',
    signature: {
      params: [
        ['columnNumber', 'Edm.Int32'],
        ['pageNumber', 'Edm.Int32'],
        ['recordsPerPage', 'Edm.Int32'],
      ],
      response: [['Values', 'Collection(Edm.String)']],
    },
    handle: (c) => {
      const args = argsOf(c),
        parsed = parsedRows(rowById(api, c, 'importfile', c.target.id)),
        column = Number(args.columnNumber);
      if (!Number.isInteger(column) || column < 1 || column > parsed.columns.length)
        throw invalid('columnNumber is outside the parsed columns.');
      return reply(c, 'GetDistinctValuesImportFile', {
        Values: pageRows(
          [...new Set(parsed.rows.map((row) => row[column - 1] ?? ''))],
          args.pageNumber,
          args.recordsPerPage,
        ),
      });
    },
  });
  register({
    name: 'RetrieveParsedDataImportFile',
    kind: 'function',
    csdl: `<ComplexType Name="StringCollection"><Property Name="Items" Type="Collection(Edm.String)" Nullable="false" /></ComplexType><ComplexType Name="RetrieveParsedDataImportFileResponse"><Property Name="Values" Type="Collection(mscrm.StringCollection)" /></ComplexType><Function Name="RetrieveParsedDataImportFile"><Parameter Name="ImportFileId" Type="Edm.Guid" Nullable="false" /><Parameter Name="PagingInfo" Type="mscrm.PagingInfo" /><ReturnType Type="mscrm.RetrieveParsedDataImportFileResponse" Nullable="false" /></Function>`,
    handle: (c) => {
      const args = argsOf(c),
        rows = parsedRows(rowById(api, c, 'importfile', args.ImportFileId)).rows;
      return reply(c, 'RetrieveParsedDataImportFile', {
        Values: pageRows(rows, args.PagingInfo?.PageNumber, args.PagingInfo?.Count).map((Items) => ({ Items })),
      });
    },
  });
}

function installRetentionMessages(api) {
  // These actions are documented as executed only by Dataverse, so they are registered as internal messages.
  const params = {
    BulkRetain: [
      ['EntityName', 'Edm.String'],
      ['FetchXml', 'Edm.String'],
      ['PageSize', 'Edm.Int32'],
      ['OperationId', 'Edm.Guid'],
      ['PagingCookie', 'Edm.String'],
    ],
    Retain: [
      ['Target', 'mscrm.crmbaseentity'],
      ['OperationId', 'Edm.Guid'],
    ],
    RollbackRetain: [
      ['Target', 'mscrm.crmbaseentity'],
      ['OperationId', 'Edm.Guid'],
    ],
    PurgeRetainedContent: [
      ['EntityName', 'Edm.String'],
      ['PageSize', 'Edm.Int32'],
      ['OperationId', 'Edm.Guid'],
      ['IsMVPCalculatedFromRelatedEntities', 'Edm.Boolean'],
      ['MaxVersionToPurge', 'Edm.Int64'],
    ],
    ValidateRetentionConfig: [
      ['Target', 'mscrm.crmbaseentity'],
      ['EntityName', 'Edm.String'],
      ['FetchXml', 'Edm.String'],
      ['RetentionConfigId', 'Edm.Guid'],
    ],
  };
  for (const [name, values] of Object.entries(params))
    registerInternalMessage(api, {
      name,
      kind: 'action',
      binding: 'unbound',
      signature: {
        params: values,
        response:
          name === 'ValidateRetentionConfig'
            ? [
                ['IsValidationSuccessful', 'Edm.Boolean'],
                ['ErrorMessage', 'Edm.String'],
              ]
            : name === 'BulkRetain'
              ? [
                  ['PagingCookie', 'Edm.String'],
                  ['MaxMarkedVersion', 'Edm.Int64'],
                  ['HasMoreRecords', 'Edm.Boolean'],
                  ['FailedRecords', 'Edm.Int32'],
                  ['EntityCountCollection', 'mscrm.EntityRecordCountCollection'],
                ]
              : [
                  ...(name === 'PurgeRetainedContent' ? [['HasMoreRecords', 'Edm.Boolean']] : []),
                  ['EntityCountCollection', 'mscrm.EntityRecordCountCollection'],
                ],
      },
    });
  api.registry.register({
    name: 'ExportRetainedData',
    kind: 'action',
    binding: 'unbound',
    signature: {
      params: [
        ['LayoutXml', 'Edm.String'],
        ['FetchXml', 'Edm.String'],
      ],
      response: [['ExportedExcelId', 'Edm.Guid']],
    },
    handle: async (c) => {
      const input = argsOf(c),
        parsed = parseXmlDocument(String(input.FetchXml ?? ''), { root: 'fetch' });
      const logical = childNodes(parsed, 'entity')[0]?.attrs.name;
      if (!logical) throw invalid('FetchXml requires an entity.');
      authorize(api, c, logical, 'read');
      const xml = String(input.FetchXml).replace(/<fetch\b[^>]*>/i, (opening) =>
        opening.replace(/\s+datasource\s*=\s*(?:"[^"]*"|'[^']*')/i, '').replace(/>$/, ' datasource="retained">'),
      );
      // Column security as on every FetchXML read: a masked operand answers 0x80041155 and the workbook carries what the caller
      // receives (hidden columns null through datasourceRows, masked columns masked).
      const secured = api.store.recordPipeline?.secureInternal?.(c, logical, { fetchXml: xml }) ?? {};
      const view = { unmask: false, single: false };
      const result = api.store.fetchXml(xml, c.identity, secured);
      const rows = (result.entities ?? []).map(
        (row) => api.fieldSecurity?.mask?.(c.user, logical, row, { view }) ?? row,
      );
      const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
      const workbook = `<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Retained data"><Table><Row>${columns.map((name) => `<Cell><Data ss:Type="String">${xmlEscapeAttribute(name)}</Data></Cell>`).join('')}</Row>${rows.map((row) => `<Row>${columns.map((name) => `<Cell><Data ss:Type="String">${xmlEscapeAttribute(String(row[name]?.value ?? row[name] ?? ''))}</Data></Cell>`).join('')}</Row>`).join('')}</Table></Worksheet></Workbook>`;
      authorize(api, c, 'retaineddataexcel', 'create');
      const id = randomUUID();
      await api.change(() =>
        api.store.transact(
          () =>
            api.store.insertRow('retaineddataexcel', (api.store.state.tables.retaineddataexcel ??= []), {
              retaineddataexcelid: id,
              name: 'Retained data',
              excelcontent: Buffer.from(workbook).toString('base64'),
            }),
          { isolated: true },
        ),
      );
      return reply(c, 'ExportRetainedData', { ExportedExcelId: id });
    },
  });
}

export function install(api) {
  const { store, registry } = api;
  // DataStore's Dataverse-only delete collector includes cascaded rows, children first and root last.
  store.recycleDeleted = (entries, identity) => {
    const root = entries.at(-1);
    if (root && eligible(store.resolveMapping(root.logicalName)) && recycleBinEnabled(store, root.logicalName))
      writeReference(store, entries, identity);
  };
  store.datasourceRows = (source, logical, identity, context = {}) => {
    // Retained queries read one table; joins and aggregate functions are unsupported natively.
    // The Dataverse-only fourth argument comes from the planned query, so ordinary portal fetches are untouched.
    if (source === 'retained' && (context.plan?.aggregate || context.plan?.links?.length))
      throw invalid('Retained data queries support one table only; joins and aggregate functions are not supported.');
    const rows = source === 'bin' ? binRows(store, logical) : source === 'retained' ? retainedRows(store, logical) : [];
    const target = api.principals.byId(identity?.systemUserId ?? identity?.id),
      caller = api.principals.byId(identity?.dataverse?.callerId);
    if (!target) return [];
    const user =
      caller && caller.systemuserid !== target.systemuserid
        ? api.principals.effectivePrincipal(caller, target)
        : target;
    const filter = api.principals.readFilter({ user, entity: logical });
    return (filter ? rows.filter(filter) : rows).map((row) => api.fieldSecurity?.mask?.(user, logical, row) ?? row);
  };
  registry.register({
    name: 'GetEntitiesEligibleForRecycleBin',
    kind: 'action',
    binding: 'unbound',
    signature: { response: [['Result', 'Edm.String']] },
    handle: (c) =>
      reply(c, 'GetEntitiesEligibleForRecycleBin', {
        Result: JSON.stringify(
          Object.entries(store.state.mappings)
            .filter(([name, mapping]) => eligible({ logicalName: name, ...mapping }))
            .map(([name]) => name)
            .sort(),
        ),
      }),
  });
  installImportMessages(api);
  installRetentionMessages(api);

  registry.register({ name: 'Restore', kind: 'action', binding: 'unbound', handle: restore(api) });
  registry.register({ name: 'EmptyRecycleBin', kind: 'action', binding: 'unbound', handle: emptyRecycleBin(api) });
  registry.register({
    name: 'ParseImport',
    kind: 'action',
    binding: 'entity',
    entity: 'import',
    signature: { returns: 'mscrm.asyncoperation' },
    handle: asImportAction(api, 'ParseImport', OPERATION.importFileParse, ({ files }) => parseWork(api)({ files })),
  });
  registry.register({
    name: 'TransformImport',
    kind: 'action',
    binding: 'unbound',
    signature: { params: [['ImportId', 'Edm.Guid']], returns: 'mscrm.asyncoperation' },
    handle: asImportAction(api, 'TransformImport', OPERATION.import, ({ files }) => transformWork(api)({ files })),
  });
  registry.register({
    name: 'ImportRecordsImport',
    kind: 'action',
    binding: 'entity',
    entity: 'import',
    signature: { returns: 'mscrm.asyncoperation' },
    handle: asImportAction(api, 'ImportRecordsImport', OPERATION.import, ({ c, files }) =>
      importWork(api, c)({ files }),
    ),
  });
}

export const EXTENSION = { name: 'dataverse-data-messages', install };
