import { pagedRecordsOf } from './record-tables.mjs';

const sources = new WeakMap();
/** Explicit row streams remain lazy until schema defaults have been applied. */
export const recordSources = (session = null) =>
  Object.freeze({
    table(rows, { primaryKey } = {}) {
      if (!rows || typeof rows[Symbol.iterator] !== 'function') throw TypeError('Record source must be iterable');
      if (primaryKey !== undefined && typeof primaryKey !== 'string') throw TypeError('Primary key must be a string');
      const source = Object.freeze({});
      sources.set(source, { rows, session, primaryKey });
      return source;
    },
  });

export const recordSourceOf = (value) => sources.get(value);

export function materializeRecordSource(value, project = (row) => row) {
  const source = sources.get(value),
    paged = pagedRecordsOf(value);
  if (!source && !paged) return value.map(project);
  const selected = source?.session ?? paged?.session;
  const session = typeof selected === 'function' ? selected() : selected;
  function* rows() {
    if (source) {
      for (const row of source.rows) yield project(row);
    } else for (let index = 0; index < paged.length; index++) yield project(paged.raw(index));
  }
  return session ? session.from(rows(), { primaryKey: source?.primaryKey ?? paged?.keyColumn }) : Array.from(rows());
}

export function finishRecordSources(body) {
  let tables;
  for (const [name, rows] of Object.entries(body?.tables ?? {}))
    if (sources.has(rows)) {
      tables ??= { ...body.tables };
      tables[name] = materializeRecordSource(rows);
    }
  return tables ? { ...body, tables } : body;
}
