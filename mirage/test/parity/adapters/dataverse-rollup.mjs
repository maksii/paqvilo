// Adapter for the dataverse-rollup surface: a recorded hosted rollup run (the parent and child schema, the exported rollup
// definitions, the parent hierarchy with the parents' own values, the child rows and one operation) -> a Mirage Dataverse Web API seeded through the
// same requests the recorder made (parents in order with their hierarchy bind, children with their parent bind, a child
// deactivated by statecode) -> the answers in the recorder's shape. Row keys (P1, c1) become invented GUIDs here; each
// case starts its own runtime, so no case reads another's writes.
import { EXTENSION } from '../../../lib/dataverse-rollup.mjs';
import { contractModuleFixture } from '../../contract-module-fixture.mjs';

const keyIds = new Map();
// One invented GUID per recorder key, stable for the process.
const idOf = (key) => {
  if (!keyIds.has(key)) keyIds.set(key, `f6f60000-0000-4000-8000-${String(keyIds.size + 1).padStart(12, '0')}`);
  return keyIds.get(key);
};

// A recorded column type as a field: 'dateonly' is a date and time column with the DateOnly behaviour.
const fieldOf = (type, extra = {}) =>
  type === 'dateonly'
    ? { dataverseType: 'datetime', dateTimeBehavior: 'DateOnly', ...extra }
    : { dataverseType: type, ...extra };

function mappingsOf({ schema, definitions }) {
  const { parent, child } = schema;
  const parentSet = parent.entitySet;
  const fields = Object.fromEntries(
    definitions.map(({ column, type, formula }) => [
      column,
      fieldOf(type, { columnMetadata: { sourceType: 2, formulaDefinition: formula } }),
    ]),
  );
  // The parent's own columns (a recording before the source-filter shapes names none).
  const parentFields = Object.fromEntries(
    Object.entries(parent.columns ?? {}).map(([column, type]) => [column, fieldOf(type)]),
  );
  const childFields = Object.fromEntries(
    Object.entries(child.columns).map(([column, type]) => [
      column,
      type === 'picklist'
        ? { dataverseType: type, options: child.options[column].map((value) => ({ value, label: String(value) })) }
        : fieldOf(type),
    ]),
  );
  return {
    parentSet,
    childSet: child.entitySet,
    mappings: {
      [parent.table]: {
        logicalName: parent.table,
        entitySet: parentSet,
        idColumn: parent.idColumn,
        fields: {
          ...fields,
          ...parentFields,
          [parent.hierarchy.column]: { dataverseType: 'lookup', targets: [parent.table] },
        },
        relationships: {
          [parent.hierarchy.column]: {
            entity: parent.table,
            from: parent.hierarchy.column,
            to: parent.idColumn,
            many: false,
            schemaName: parent.hierarchy.schemaName,
          },
        },
      },
      [child.table]: {
        logicalName: child.table,
        entitySet: child.entitySet,
        idColumn: child.idColumn,
        fields: {
          ...childFields,
          [child.link.column]: { dataverseType: 'lookup', targets: [parent.table] },
          statecode: { dataverseType: 'int' },
          statuscode: { dataverseType: 'int' },
        },
        relationships: {
          [child.link.column]: {
            entity: parent.table,
            from: child.link.column,
            to: parent.idColumn,
            many: false,
            schemaName: child.link.schemaName,
          },
        },
      },
    },
  };
}

// The bodies the recorder posted: a parent with its own values and hierarchy bind, a child with its values and parent bind.
const parentBody = (schema, key, hierarchyParent, values, parentSet) => ({
  [schema.parent.idColumn]: idOf(key),
  ...values,
  ...(hierarchyParent
    ? { [`${schema.parent.hierarchy.column}@odata.bind`]: `/${parentSet}(${idOf(hierarchyParent)})` }
    : {}),
});
const childBody = (schema, key, parent, values, parentSet) => ({
  [schema.child.idColumn]: idOf(key),
  ...values,
  [`${schema.child.link.column}@odata.bind`]: `/${parentSet}(${idOf(parent)})`,
});

// A recorded observed setting (create-state runs) is the site's observation, as the simulator passes it to the store.
async function seed(input, after, observed = null) {
  const { schema } = input;
  const { parentSet, childSet, mappings } = mappingsOf(input);
  const fixture = await contractModuleFixture({ after }, { extension: EXTENSION, mappings, tables: {} });
  if (observed) fixture.store.setObserved(observed);
  const { request, json } = fixture;
  const minimal = { prefer: 'return=minimal' };
  for (const { key, hierarchyParent, values } of input.parents)
    await json(
      await request('POST', `/${parentSet}`, parentBody(schema, key, hierarchyParent, values, parentSet), minimal),
      204,
    );
  for (const { key, parent, values } of input.children)
    await json(await request('POST', `/${childSet}`, childBody(schema, key, parent, values, parentSet), minimal), 204);
  for (const { key, statecode } of input.children)
    if (statecode !== undefined && statecode !== 0)
      await json(await request('PATCH', `/${childSet}(${idOf(key)})`, { statecode, statuscode: 2 }, minimal), 204);
  return { ...fixture, parentSet, childSet };
}

const calculate = async ({ request }, parentSet, key, column) => {
  const target = encodeURIComponent(JSON.stringify({ '@odata.id': `${parentSet}(${idOf(key)})` }));
  const response = await request('GET', `/CalculateRollupField(Target=@t,FieldName=@f)?@t=${target}&@f='${column}'`);
  const body = await response.json();
  return {
    status: response.status,
    state: body[`${column}_state`],
    ...(Object.hasOwn(body, column) ? { value: body[column] } : {}),
  };
};

async function stored({ request, parentSet }, input) {
  const columns = input.definitions.map(({ column }) => column);
  const select = columns.flatMap((column) => [column, `${column}_state`]).join(',');
  const result = {};
  for (const { key } of input.parents) {
    const row = await (await request('GET', `/${parentSet}(${idOf(key)})?$select=${select}`)).json();
    result[key] = Object.fromEntries(
      columns.map((column) => [column, { value: row[column] ?? null, state: row[`${column}_state`] }]),
    );
  }
  return result;
}

// ---- Create-state runs (designer-saved and Web API-created columns, summary-F6 DATA-04c2)
//
// A recorded sequence of steps over one runtime: seed, reads, a column's mass calculation, child writes, new parents and
// children, the hourly rollup job. Mirage's own clock is set to one distinct time per mass calculation and per hourly job,
// so a read records each _date as its kind, as the capture did: null, "created" (the row's createdon within 2 s), "mass"
// (that column's mass calculation) or "entity" (the hourly job). The hosted hourly job is Mirage's recalculateStale.
const STEP_TIMES = Date.UTC(2001, 0, 1);

async function createState(input, after) {
  const { schema } = input;
  const runtime = await seed(
    { ...input, parents: input.seed.parents, children: input.seed.children },
    after,
    input.observed,
  );
  const { request, json, api, parentSet, childSet } = runtime;
  const minimal = { prefer: 'return=minimal' };
  const columns = input.definitions.map(({ column }) => column);
  const parents = input.seed.parents.map(({ key }) => key);
  const massTimes = {};
  let entityTime = null;
  let tick = 0;
  const at = () => new Date(STEP_TIMES + 60_000 * ++tick).toISOString();
  const kindOf = (row, column) => {
    const date = row[`${column}_date`];
    if (!date) return null;
    if (Math.abs(Date.parse(date) - Date.parse(row.createdon)) <= 2000) return 'created';
    if (Date.parse(date) === Date.parse(massTimes[column])) return 'mass';
    return Date.parse(date) === Date.parse(entityTime) ? 'entity' : 'other';
  };
  // The rollup module reads api.clock for the time it stamps; the step runs at its own time and the clock is restored.
  const atTime = async (iso, fn) => {
    const clock = api.clock;
    api.clock = () => Date.parse(iso);
    try {
      return await fn();
    } finally {
      api.clock = clock;
    }
  };
  const output = {};
  const steps = {
    seed: async () => {},
    async read({ label }) {
      const select = ['createdon', ...columns.flatMap((column) => [column, `${column}_state`, `${column}_date`])].join(
        ',',
      );
      output[label] = {};
      for (const key of parents) {
        const row = await (await request('GET', `/${parentSet}(${idOf(key)})?$select=${select}`)).json();
        output[label][key] = Object.fromEntries(
          columns.map((column) => [
            column,
            { value: row[column] ?? null, state: row[`${column}_state`], date: kindOf(row, column) },
          ]),
        );
      }
    },
    async mass({ column }) {
      massTimes[column] = at();
      await atTime(massTimes[column], () => api.rollups.massCalculate(schema.parent.table, column));
    },
    async 'entity-job'() {
      entityTime = at();
      await atTime(entityTime, () => api.rollups.recalculateStale());
    },
    async 'write-child'({ key, values }) {
      await json(await request('PATCH', `/${childSet}(${idOf(key)})`, values, minimal), 204);
    },
    async 'create-parent'({ key, hierarchyParent, values }) {
      await json(
        await request('POST', `/${parentSet}`, parentBody(schema, key, hierarchyParent, values, parentSet), minimal),
        204,
      );
      parents.push(key);
    },
    async 'create-child'({ key, parent, values }) {
      await json(
        await request('POST', `/${childSet}`, childBody(schema, key, parent, values, parentSet), minimal),
        204,
      );
    },
  };
  for (const step of input.steps) await steps[step.kind](step);
  return output;
}

const OPERATIONS = {
  stored,
  async calculate(runtime, input) {
    const result = {};
    for (const { key } of input.parents) {
      result[key] = {};
      for (const { column } of input.definitions)
        result[key][column] = await calculate(runtime, runtime.parentSet, key, column);
    }
    return result;
  },
  async write(runtime, input) {
    const response = await runtime.request(
      'PATCH',
      `/${runtime.parentSet}(${idOf(input.target)})`,
      { [input.column]: input.value },
      { prefer: 'return=minimal' },
    );
    const row = await (
      await runtime.request('GET', `/${runtime.parentSet}(${idOf(input.target)})?$select=${input.column}`)
    ).json();
    return { status: response.status, value: row[input.column] ?? null };
  },
  async 'update-calculate'(runtime, input) {
    const response = await runtime.request('PATCH', `/${runtime.childSet}(${idOf(input.child)})`, input.values, {
      prefer: 'return=minimal',
    });
    return {
      updateStatus: response.status,
      ...(await calculate(runtime, runtime.parentSet, input.target, input.column)),
    };
  },
};

/**
 * Opens a session for one case file; each case seeds its own runtime from its recorded input.
 * @param {{ surface: string, suite: string }} _context frozen names of the case file; this adapter needs none
 * @returns {Promise<{ run: Function, close: Function }>} session whose run returns the operation's answers
 */
export async function open(_context) {
  const cleanups = [];
  return {
    async run(input, _context) {
      if (input.operation === 'create-state') return createState(input, (fn) => cleanups.push(fn));
      const operation = OPERATIONS[input.operation];
      if (!operation) throw new Error(`Unknown recorded rollup operation ${input.operation}.`);
      return operation(await seed(input, (fn) => cleanups.push(fn), input.observed), input);
    },
    async close() {
      for (const cleanup of cleanups.reverse()) await cleanup();
    },
  };
}
