import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { digest } from './manifest.mjs';
import { privateJson } from './connection.mjs';

const identifier = /^[a-z][a-z0-9_]*$/i,
  guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ensure = (ok, message) => {
  if (!ok) throw new Error(`Invalid data catalogue: ${message}`);
};
const literal = (value) => (typeof value === 'string' ? `'${value.replaceAll("'", "''")}'` : String(value));
const xmlEscape = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
const normalizeValue = (value) =>
  typeof value === 'string' && guid.test(value)
    ? value.toLowerCase()
    : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
      ? new Date(value).toISOString()
      : value;
const canonical = (value) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, normalizeValue(v)]),
    ),
  );
// Subtract occurrences, not unique values: joins may legitimately repeat rows.
const subtractRows = (left, right) => {
  const counts = new Map();
  for (const key of right) counts.set(key, (counts.get(key) ?? 0) + 1);
  return left.filter((key) => {
    const count = counts.get(key) ?? 0;
    if (!count) return true;
    counts.set(key, count - 1);
    return false;
  });
};
export function validateCatalogue(input) {
  const c = structuredClone(input);
  ensure(
    c.schemaVersion === 1 && c.datasetId && c.version && Number.isFinite(Date.parse(c.clock)),
    'version, identity and fixed clock required',
  );
  ensure(
    Array.isArray(c.tables) && Array.isArray(c.records) && Array.isArray(c.associations) && Array.isArray(c.queries),
    'tables/records/associations/queries required',
  );
  const tables = new Map(),
    records = new Map(),
    ids = new Set();
  for (const t of c.tables) {
    ensure(
      identifier.test(t.name) && identifier.test(t.entitySet) && identifier.test(t.primaryId) && !tables.has(t.name),
      'table identity',
    );
    tables.set(t.name, t);
  }
  for (const r of c.records) {
    ensure(
      r.key && guid.test(r.id) && tables.has(r.table) && !records.has(r.key) && !ids.has(r.id.toLowerCase()),
      'record identity',
    );
    records.set(r.key, r);
    ids.add(r.id.toLowerCase());
    r.fields ??= {};
    r.refs ??= {};
    r.deferredRefs ??= [];
    for (const [field, value] of Object.entries(r.fields))
      ensure(
        identifier.test(field) &&
          field !== tables.get(r.table).primaryId &&
          (value === null ||
            ['string', 'number', 'boolean'].includes(typeof value) ||
            (Array.isArray(value) && value.every(Number.isInteger))),
        'scalar field',
      );
    for (const field of r.deferredRefs) ensure(field in r.refs, 'deferred reference missing');
    if (r.external)
      ensure(
        Object.keys(r.external.match ?? {}).length > 0 &&
          Object.keys(r.external.match).every((k) => identifier.test(k)),
        'external match',
      );
  }
  const seen = new Set();
  for (const r of c.records) {
    for (const [field, key] of Object.entries(r.refs)) {
      ensure(identifier.test(field) && (key === null || records.has(key)), 'unknown lookup target');
      ensure(
        key === null || r.deferredRefs.includes(field) || seen.has(key),
        'forward/cyclic lookup must be explicitly deferred',
      );
      ensure(!(field in r.fields), 'lookup cannot also be scalar');
    }
    seen.add(r.key);
  }
  const keyValues = new Set();
  for (const r of c.records)
    for (const fields of tables.get(r.table).keys ?? []) {
      const values = fields.map((f) => r.fields[f] ?? (r.refs[f] ? records.get(r.refs[f]).id : null));
      if (values.every((v) => v !== null && v !== undefined)) {
        const key = JSON.stringify([r.table, fields, values]);
        ensure(!keyValues.has(key), 'duplicate business key');
        keyValues.add(key);
      }
    }
  const associationKeys = new Set();
  for (const a of c.associations) {
    ensure(
      identifier.test(a.relationship) &&
        records.has(a.from) &&
        Array.isArray(a.to) &&
        a.to.every((k) => records.has(k)) &&
        new Set(a.to).size === a.to.length,
      'association references',
    );
    const key = a.relationship + ':' + a.from;
    ensure(!associationKeys.has(key), 'duplicate association group');
    associationKeys.add(key);
  }
  const queryIds = new Set();
  for (const q of c.queries) {
    ensure(
      q.id &&
        !queryIds.has(q.id) &&
        tables.has(q.table) &&
        /^\s*<fetch\b/i.test(q.fetchXml) &&
        !/<!(?:DOCTYPE|ENTITY)/i.test(q.fetchXml) &&
        Array.isArray(q.expected),
      'query definition',
    );
    ensure(
      Number.isInteger(q.pageSize ?? 50) && (q.pageSize ?? 50) > 0 && (q.pageSize ?? 50) <= 5000,
      'query page size',
    );
    queryIds.add(q.id);
  }
  return c;
}
export async function readCatalogue(file) {
  return validateCatalogue(JSON.parse(await fs.readFile(file, 'utf8')));
}

async function context(input, client) {
  const catalogue = validateCatalogue(input),
    tables = new Map(),
    ids = new Map(catalogue.records.map((r) => [r.key, r.id]));
  for (const declared of catalogue.tables) {
    const actual = await client.get(
      `EntityDefinitions(LogicalName='${declared.name}')?$select=LogicalName,EntitySetName,PrimaryIdAttribute`,
    );
    if (actual.EntitySetName !== declared.entitySet || actual.PrimaryIdAttribute !== declared.primaryId)
      throw new Error(`Data metadata differs for ${declared.name}.`);
    const keys = await client.list(`EntityDefinitions(LogicalName='${declared.name}')/Keys`);
    for (const key of declared.keys ?? [])
      if (
        !keys.some(
          (k) =>
            JSON.stringify([...k.KeyAttributes].sort()) === JSON.stringify([...key].sort()) &&
            k.EntityKeyIndexStatus === 'Active',
        )
      )
        throw new Error(`An alternate key on ${declared.name} is absent or not Active.`);
    const relationships = await client.list(
      `EntityDefinitions(LogicalName='${declared.name}')/ManyToOneRelationships?$select=ReferencingAttribute,ReferencedEntity,ReferencingEntityNavigationPropertyName`,
    );
    tables.set(declared.name, { ...declared, relationships });
  }
  const externalRows = new Map();
  for (const r of catalogue.records.filter((r) => r.external)) {
    const t = tables.get(r.table),
      filter = Object.entries(r.external.match)
        .map(([k, v]) => `${k} eq ${literal(v)}`)
        .join(' and ');
    const rows = await client.list(`${t.entitySet}?$filter=${encodeURIComponent(filter)}`);
    if (rows.length > 1) throw new Error(`External reference ${r.key} is ambiguous.`);
    if (rows[0]) {
      ids.set(r.key, rows[0][t.primaryId]);
      externalRows.set(r.key, rows[0]);
    }
  }
  return {
    catalogue,
    tables,
    ids,
    externalRows,
    client,
    relationshipCache: new Map(),
    present: new Set(externalRows.keys()),
  };
}
function expectedFields(r, ctx) {
  const fields = { ...r.fields };
  for (const [field, key] of Object.entries(r.refs)) fields[`_${field}_value`] = key === null ? null : ctx.ids.get(key);
  return fields;
}
function payload(r, ctx, { deferred = false } = {}) {
  const t = ctx.tables.get(r.table),
    body = deferred
      ? {}
      : Object.fromEntries(
          Object.entries(r.fields).map(([field, value]) => [field, Array.isArray(value) ? value.join(',') : value]),
        );
  for (const [field, key] of Object.entries(r.refs))
    if (r.deferredRefs.includes(field) === deferred) {
      const target = key === null ? null : ctx.catalogue.records.find((r) => r.key === key);
      const candidates = t.relationships.filter(
        (rel) => rel.ReferencingAttribute === field && (!target || rel.ReferencedEntity === target.table),
      );
      const rel = candidates.length === 1 ? candidates[0] : null;
      if (!rel?.ReferencingEntityNavigationPropertyName)
        throw new Error(`Lookup navigation unavailable: ${r.table}.${field}.`);
      body[rel.ReferencingEntityNavigationPropertyName + '@odata.bind'] = target
        ? `/${ctx.tables.get(target.table).entitySet}(${ctx.ids.get(key)})`
        : null;
    }
  return body;
}
function equal(actual, expected) {
  if (actual === undefined) actual = null;
  if (typeof expected === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(expected))
    return actual === expected || actual === expected + 'T00:00:00Z' || actual === expected + 'T00:00:00.000Z';
  if (Array.isArray(expected))
    return (
      String(actual ?? '')
        .split(',')
        .filter(Boolean)
        .map(Number)
        .sort()
        .join(',') === [...expected].sort().join(',')
    );
  return normalizeValue(actual) === normalizeValue(expected);
}
function differences(r, actual, ctx, { allowPending = false } = {}) {
  return Object.entries(expectedFields(r, ctx))
    .filter(
      ([field, wanted]) =>
        !(allowPending && r.deferredRefs.some((f) => field === `_${f}_value`) && actual[field] == null) &&
        !equal(actual[field], wanted),
    )
    .map(([field, expected]) => ({ field, expected, actual: actual[field] ?? null }));
}
async function fetchRecord(r, ctx) {
  const t = ctx.tables.get(r.table);
  return ctx.client.optional(
    `${t.entitySet}(${ctx.ids.get(r.key)})?$select=${[t.primaryId, ...Object.keys(expectedFields(r, ctx))].join(',')}`,
  );
}
async function associationState(a, ctx) {
  let rows = ctx.relationshipCache.get(a.relationship);
  if (!rows) {
    rows = await ctx.client.list(
      `RelationshipDefinitions/Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata?$filter=SchemaName eq '${a.relationship}'`,
    );
    ctx.relationshipCache.set(a.relationship, rows);
  }
  if (rows.length !== 1) throw new Error(`Association relationship unavailable: ${a.relationship}.`);
  const rel = rows[0],
    from = ctx.catalogue.records.find((r) => r.key === a.from),
    side = rel.Entity1LogicalName === from.table ? 1 : rel.Entity2LogicalName === from.table ? 2 : 0;
  if (!side) throw new Error('Association source table mismatch.');
  const targetTable = rel[side === 1 ? 'Entity2LogicalName' : 'Entity1LogicalName'],
    nav = rel[`Entity${side}NavigationPropertyName`],
    t = ctx.tables.get(targetTable);
  if (!t || !nav || a.to.some((k) => ctx.catalogue.records.find((r) => r.key === k).table !== targetTable))
    throw new Error('Association target/navigation mismatch.');
  const route = `${ctx.tables.get(from.table).entitySet}(${ctx.ids.get(a.from)})/${nav}`;
  const current = ctx.present.has(from.key) ? await ctx.client.list(`${route}?$select=${t.primaryId}`) : [];
  return {
    route,
    targetTable,
    actual: current.map((r) => r[t.primaryId].toLowerCase()),
    expected: a.to.map((k) => ctx.ids.get(k).toLowerCase()),
  };
}
async function planWithContext(ctx) {
  const records = [],
    associations = [];
  for (const r of ctx.catalogue.records) {
    if (ctx.externalRows.has(r.key)) {
      records.push({ key: r.key, id: ctx.ids.get(r.key), status: 'external' });
      continue;
    }
    const actual = await fetchRecord(r, ctx),
      drift = actual ? differences(r, actual, ctx, { allowPending: true }) : [];
    if (actual) ctx.present.add(r.key);
    if (!actual) {
      const t = ctx.tables.get(r.table);
      for (const key of t.keys ?? []) {
        const fields = key.map((f) =>
          r.fields[f] !== undefined ? [f, r.fields[f]] : r.refs[f] ? [`_${f}_value`, ctx.ids.get(r.refs[f])] : null,
        );
        if (fields.every((f) => f && f[1] != null)) {
          const filter = fields.map(([f, v]) => `${f} eq ${f.startsWith('_') ? v : literal(v)}`).join(' and ');
          const matches = await ctx.client.list(
            `${t.entitySet}?$select=${t.primaryId}&$filter=${encodeURIComponent(filter)}`,
          );
          if (matches.length)
            drift.push({ field: 'business-key', expected: r.id, actual: matches.map((m) => m[t.primaryId]) });
        }
      }
    }
    records.push({
      key: r.key,
      id: ctx.ids.get(r.key),
      status: drift.length ? 'drift' : actual ? 'exists' : 'create',
      differences: drift,
    });
  }
  for (const a of ctx.catalogue.associations) {
    const state = await associationState(a, ctx);
    associations.push({
      relationship: a.relationship,
      from: a.from,
      missing: state.expected.filter((id) => !state.actual.includes(id)),
      extra: state.actual.filter((id) => !state.expected.includes(id)),
    });
  }
  return {
    schemaVersion: 1,
    datasetId: ctx.catalogue.datasetId,
    version: ctx.catalogue.version,
    catalogueHash: digest(ctx.catalogue),
    mode: 'remote-read-only',
    records,
    associations,
    summary: {
      create: records.filter((r) => r.status === 'create').length,
      exists: records.filter((r) => r.status === 'exists').length,
      external: records.filter((r) => r.status === 'external').length,
      drift: records.filter((r) => r.status === 'drift').length,
      missingAssociations: associations.reduce((n, a) => n + a.missing.length, 0),
      extraAssociations: associations.reduce((n, a) => n + a.extra.length, 0),
    },
    resolvedIds: Object.fromEntries(ctx.ids),
  };
}
export async function planData(input, { client } = {}) {
  const c = validateCatalogue(input);
  if (!client)
    return {
      schemaVersion: 1,
      mode: 'offline',
      datasetId: c.datasetId,
      version: c.version,
      catalogueHash: digest(c),
      records: c.records.length,
      associations: c.associations.reduce((n, a) => n + a.to.length, 0),
      queries: c.queries.length,
    };
  return planWithContext(await context(c, client));
}
export async function applyData(input, { client, expectedOrganisationId, journalFile, onProgress = () => {} }) {
  const identity = await client.verify(expectedOrganisationId),
    ctx = await context(input, client),
    plan = await planWithContext(ctx);
  if (plan.summary.drift || plan.summary.extraAssociations)
    throw new Error(
      'Existing fixture data/associations differ. Inspect data-plan; additive loading will not overwrite or remove them.',
    );
  const journal = {
    schemaVersion: 1,
    datasetId: ctx.catalogue.datasetId,
    version: ctx.catalogue.version,
    catalogueHash: plan.catalogueHash,
    identity,
    startedAt: new Date().toISOString(),
    state: 'Running',
    resolvedIds: plan.resolvedIds,
    entries: [],
  };
  if (journalFile) await privateJson(journalFile, journal, true);
  const step = async (key, run) => {
    journal.pending = key;
    if (journalFile) await privateJson(journalFile, journal);
    const status = await run();
    const entry = { key, status, finishedAt: new Date().toISOString() };
    journal.entries.push(entry);
    delete journal.pending;
    if (journalFile) await privateJson(journalFile, journal);
    onProgress(entry);
  };
  try {
    for (const r of ctx.catalogue.records)
      await step(`record:${r.key}`, async () => {
        if (ctx.externalRows.has(r.key)) return 'external';
        const actual = await fetchRecord(r, ctx);
        if (actual) {
          if (differences(r, actual, ctx, { allowPending: true }).length)
            throw new Error(`Fixture changed during loading: ${r.key}.`);
          return 'exists';
        }
        await client.request(`${ctx.tables.get(r.table).entitySet}(${ctx.ids.get(r.key)})`, {
          method: 'PATCH',
          ifNoneMatch: '*',
          body: payload(r, ctx),
        });
        ctx.present.add(r.key);
        return 'created';
      });
    for (const r of ctx.catalogue.records.filter((r) => r.deferredRefs.length))
      await step(`deferred:${r.key}`, async () => {
        const actual = await fetchRecord(r, ctx);
        if (!actual) throw new Error('Deferred fixture disappeared.');
        const drift = differences(r, actual, ctx);
        if (!drift.length) return 'exists';
        if (drift.some((d) => d.actual !== null || !r.deferredRefs.some((f) => d.field === `_${f}_value`)))
          throw new Error(`Deferred fixture changed: ${r.key}.`);
        await client.request(`${ctx.tables.get(r.table).entitySet}(${ctx.ids.get(r.key)})`, {
          method: 'PATCH',
          ifMatch: actual['@odata.etag'] ?? '*',
          body: payload(r, ctx, { deferred: true }),
        });
        return 'linked';
      });
    for (const a of ctx.catalogue.associations)
      await step(`association:${a.relationship}:${a.from}`, async () => {
        const s = await associationState(a, ctx);
        if (s.actual.some((id) => !s.expected.includes(id))) throw new Error('Association changed during loading.');
        let added = 0;
        for (const id of s.expected.filter((id) => !s.actual.includes(id))) {
          await client.request(s.route + '/$ref', {
            method: 'POST',
            body: { '@odata.id': client.url(`${ctx.tables.get(s.targetTable).entitySet}(${id})`) },
          });
          added++;
        }
        return added ? `linked:${added}` : 'exists';
      });
    journal.state = 'Created';
    journal.finishedAt = new Date().toISOString();
    if (journalFile) await privateJson(journalFile, journal);
    return journal;
  } catch (error) {
    journal.state = error.code === 'UNKNOWN_COMMIT' ? 'UnknownCommit' : 'Interrupted';
    journal.error = { code: error.code ?? 'DATA_LOAD_STOPPED', message: error.message };
    if (journalFile) await privateJson(journalFile, journal);
    throw error;
  }
}
export async function compareData(input, { client }) {
  const ctx = await context(input, client),
    records = [],
    associations = [];
  for (const r of ctx.catalogue.records) {
    if (ctx.externalRows.has(r.key)) continue;
    const actual = await fetchRecord(r, ctx);
    if (actual) ctx.present.add(r.key);
    const drift = actual ? differences(r, actual, ctx) : [{ field: 'record', expected: r.id, actual: null }];
    if (drift.length) records.push({ key: r.key, differences: drift });
  }
  for (const a of ctx.catalogue.associations) {
    const s = await associationState(a, ctx);
    const missing = s.expected.filter((id) => !s.actual.includes(id)),
      extra = s.actual.filter((id) => !s.expected.includes(id));
    if (missing.length || extra.length)
      associations.push({ relationship: a.relationship, from: a.from, missing, extra });
  }
  return {
    schemaVersion: 1,
    datasetId: ctx.catalogue.datasetId,
    version: ctx.catalogue.version,
    catalogueHash: digest(ctx.catalogue),
    identity: await client.verify(),
    checkedRecords: ctx.catalogue.records.length - ctx.externalRows.size,
    checkedAssociationGroups: ctx.catalogue.associations.length,
    resolvedIds: Object.fromEntries(ctx.ids),
    records,
    associations,
    passed: !records.length && !associations.length,
    finishedAt: new Date().toISOString(),
  };
}

function pageFetchXml(xml, page, count, cookie) {
  ensure(/^\s*<fetch\b/i.test(xml) && !/<!(?:DOCTYPE|ENTITY)/i.test(xml), 'invalid FetchXML');
  return xml.replace(/<fetch\b([^>]*)>/i, (_all, attrs) => {
    if (/\btop\s*=/i.test(attrs)) throw new Error('Paged queries cannot use top.');
    return `<fetch${attrs.replace(/\s+(?:page|count|paging-cookie)\s*=\s*(?:"[^"]*"|'[^']*')/gi, '')} page="${page}" count="${count}"${cookie ? ` paging-cookie="${xmlEscape(cookie)}"` : ''}>`;
  });
}
export async function retrieveFetchXml(client, { entitySet, fetchXml, pageSize = 50, maxPages = 2000 }) {
  const rows = [],
    pages = [];
  let cookie;
  for (let page = 1; page <= maxPages; page++) {
    const xml = pageFetchXml(fetchXml, page, pageSize, cookie),
      result = await client.request(`${entitySet}?fetchXml=${encodeURIComponent(xml)}`, {
        prefer:
          'odata.include-annotations="Microsoft.Dynamics.CRM.fetchxmlpagingcookie,Microsoft.Dynamics.CRM.morerecords"',
      }),
      data = result.data;
    if (!Array.isArray(data?.value)) throw new Error('Expected FetchXML collection.');
    rows.push(...data.value);
    const more = data['@Microsoft.Dynamics.CRM.morerecords'];
    pages.push({ page, count: data.value.length, moreRecords: more ?? null, fetchXml: xml });
    if (more === false || (more === undefined && data.value.length < pageSize)) return { rows, pages };
    if (more !== true && more !== undefined) throw new Error('Invalid FetchXML more-records annotation.');
    const encoded = data['@Microsoft.Dynamics.CRM.fetchxmlpagingcookie']?.match(
      /\bpagingcookie\s*=\s*["']([^"']+)["']/i,
    )?.[1];
    cookie = encoded ? decodeURIComponent(decodeURIComponent(encoded)) : undefined;
    if (!cookie && rows.length >= 50_000) throw new Error('Simple FetchXML paging reached the 50,000-row bound.');
  }
  throw new Error('FetchXML page bound exceeded.');
}
export async function runDataQueries(input, { client }) {
  const ctx = await context(input, client),
    results = [];
  const resolve = (value) =>
    typeof value === 'string' && value.startsWith('@ref:') ? ctx.ids.get(value.slice(5)) : value;
  for (const q of ctx.catalogue.queries) {
    const operationId = randomUUID(),
      markerUtc = new Date().toISOString(),
      xml = q.fetchXml
        .replaceAll('{{operationId}}', operationId)
        .replaceAll('{{markerUtc}}', markerUtc)
        .replace(/\{\{ref:([^}]+)\}\}/g, (_all, key) => {
          if (!ctx.ids.has(key)) throw new Error('Unknown query reference.');
          return ctx.ids.get(key);
        });
    try {
      const data = await retrieveFetchXml(client, {
        entitySet: ctx.tables.get(q.table).entitySet,
        fetchXml: xml,
        pageSize: q.pageSize ?? 50,
      });
      const fields = q.columns ?? Object.keys(q.expected[0] ?? {});
      const actual = data.rows.map((row) => Object.fromEntries(fields.map((f) => [f, row[f] ?? null]))),
        expected = q.expected.map((row) => Object.fromEntries(fields.map((f) => [f, resolve(row[f]) ?? null])));
      const actualKeys = actual.map(canonical).sort(),
        expectedKeys = expected.map(canonical).sort();
      results.push({
        id: q.id,
        operationId,
        status: JSON.stringify(actualKeys) === JSON.stringify(expectedKeys) ? 'Passed' : 'Failed',
        count: actual.length,
        expectedCount: expected.length,
        missing: subtractRows(expectedKeys, actualKeys),
        unexpected: subtractRows(actualKeys, expectedKeys),
        rows: actual,
        pages: data.pages,
      });
    } catch (error) {
      results.push({
        id: q.id,
        operationId,
        status: 'Error',
        error: { code: error.code ?? 'QUERY_FAILED', message: error.message },
        fetchXml: xml,
      });
    }
  }
  return {
    schemaVersion: 1,
    datasetId: ctx.catalogue.datasetId,
    version: ctx.catalogue.version,
    catalogueHash: digest(ctx.catalogue),
    execution: 'Dataverse application identity; fixture integrity only, not Power Pages permission evaluation',
    identity: await client.verify(),
    passed: results.every((r) => r.status === 'Passed'),
    results,
    finishedAt: new Date().toISOString(),
  };
}
