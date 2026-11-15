// Adapter for the tds-sql surface: recorded SQL Server batch -> Mirage's TDS SQL batch evaluator -> the recorded
// portable shape. Only `input.query` drives Mirage. Every recorded batch is a constant statement, so the catalog is
// empty and no table is scanned.
//
// Session context: a case's `input.context` (when its suite records one) is the SQL Server session the oracle run used
// (collation, language, dateFirst, options, product version and similar). It is recorded for the reader of the case
// file. This adapter does not apply it, because Mirage's evaluator has no session settings to apply. A case whose
// result depends on a non-default setting therefore shows up as a declared gap in known-gaps/tds-sql.json.
//
// Projection, the same for every case:
// - column: { name, sqlType }. precision and scale are added only for decimal and numeric, the types whose precision
//   and scale are part of the engine's type. Client-derived column metadata is not recorded.
// - value: NULL (null or undefined) -> { kind: 'null' }; int (a JS number) -> { kind: 'System.Int32', exact };
//   bigint (a BigInt) -> { kind: 'System.Int64', exact }; decimal ({ decimal } exact text, trailing zeros kept) ->
//   { kind: 'sql-decimal', exact }; float (a JS number) -> { kind: 'float64', roundtrip }, where roundtrip is the
//   shortest text that reads back the same double; character types, and sql_variant holding a string -> { kind:
//   'string', value }. Any other column type fails loudly rather than projecting a guess.
// - error: { number, severity (Mirage's class), state, line, message }. A field appears only when Mirage holds it, so a
//   field the engine reports and Mirage lacks is a pointer gap in known-gaps/tds-sql.json.
// Any exception without a numeric `number` propagates unchanged, so an internal failure is never recorded as a SQL
// result.
import { executeBatch } from '../../../lib/dataverse-tds-sql-eval.mjs';

const CHARACTER_TYPES = new Set(['char', 'nchar', 'varchar', 'nvarchar']);
const DECIMAL_TYPES = new Set(['decimal', 'numeric']);

function projectValue(value, column) {
  if (value === null || value === undefined) return { kind: 'null' };
  if (column.type === 'int') return { kind: 'System.Int32', exact: String(value) };
  if (column.type === 'bigint') return { kind: 'System.Int64', exact: String(value) };
  if (DECIMAL_TYPES.has(column.type)) {
    if (typeof value.decimal !== 'string') throw new Error(`tds-sql adapter expects {decimal} text for ${column.type}`);
    return { kind: 'sql-decimal', exact: value.decimal };
  }
  if (column.type === 'float') return { kind: 'float64', roundtrip: String(value) };
  if (CHARACTER_TYPES.has(column.type) || (column.type === 'sql_variant' && typeof value === 'string')) {
    return { kind: 'string', value };
  }
  throw new Error(`tds-sql adapter has no typed projection for SQL type ${column.type}`);
}

function projectColumn(column) {
  const out = { name: column.name, sqlType: column.type };
  if (DECIMAL_TYPES.has(column.type)) {
    out.precision = column.precision;
    out.scale = column.scale;
  }
  return out;
}

function projectResult(batch) {
  return {
    outcome: 'result',
    resultSets: batch.resultSets.map((set) => ({
      columns: set.columns.map(projectColumn),
      rows: set.rows.map((row) => row.map((value, index) => projectValue(value, set.columns[index]))),
    })),
  };
}

function projectError(error) {
  const out = { number: error.number };
  if (error.class !== undefined) out.severity = error.class;
  if (error.state !== undefined) out.state = error.state;
  if (error.line !== undefined) out.line = error.line;
  out.message = error.message;
  return { outcome: 'sql-error', errors: [out] };
}

/**
 * Runs the recorded batch through Mirage's TDS SQL evaluator and returns the recorded portable shape.
 * @param {{ query: string }} input recorded input of one case
 * @param {{ surface: string, suite: string }} _context frozen names of the case file; this adapter needs none
 * @returns {Promise<object>} `{ outcome: 'result', resultSets }` or `{ outcome: 'sql-error', errors }`
 */
export default async function run(input, _context) {
  try {
    return projectResult(await executeBatch(input.query, { catalog: { tables: new Map() }, scan: async () => [] }));
  } catch (error) {
    if (typeof error?.number !== 'number') throw error;
    return projectError(error);
  }
}
