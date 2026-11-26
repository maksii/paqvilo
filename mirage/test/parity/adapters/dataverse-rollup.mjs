// Adapter for the dataverse-rollup surface: a recorded hosted rollup run (the parent and child schema, the exported rollup
// definitions, the parent hierarchy, the child rows and one operation) -> a Mirage Dataverse Web API seeded through the
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

function mappingsOf({ schema, definitions }) {
  const { parent, child } = schema;
  const parentSet = parent.entitySet;
  const fields = Object.fromEntries(
    definitions.map(({ column, type, formula }) => [
      column,
      { dataverseType: type, columnMetadata: { sourceType: 2, formulaDefinition: formula } },
    ]),
  );
  const childFields = Object.fromEntries(
    Object.entries(child.columns).map(([column, type]) => [
      column,
      type === 'picklist'
        ? { dataverseType: type, options: child.options[column].map((value) => ({ value, label: String(value) })) }
        : { dataverseType: type },
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
        fields: { ...fields, [parent.hierarchy.column]: { dataverseType: 'lookup', targets: [parent.table] } },
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

async function seed(input, after) {
  const { schema } = input;
  const { parentSet, childSet, mappings } = mappingsOf(input);
  const fixture = await contractModuleFixture({ after }, { extension: EXTENSION, mappings, tables: {} });
  const { request, json } = fixture;
  const minimal = { prefer: 'return=minimal' };
  for (const { key, hierarchyParent } of input.parents)
    await json(
      await request(
        'POST',
        `/${parentSet}`,
        {
          [schema.parent.idColumn]: idOf(key),
          ...(hierarchyParent
            ? { [`${schema.parent.hierarchy.column}@odata.bind`]: `/${parentSet}(${idOf(hierarchyParent)})` }
            : {}),
        },
        minimal,
      ),
      204,
    );
  for (const { key, parent, values } of input.children)
    await json(
      await request(
        'POST',
        `/${childSet}`,
        {
          [schema.child.idColumn]: idOf(key),
          ...values,
          [`${schema.child.link.column}@odata.bind`]: `/${parentSet}(${idOf(parent)})`,
        },
        minimal,
      ),
      204,
    );
  for (const { key, statecode } of input.children)
    if (statecode !== 0)
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
      const operation = OPERATIONS[input.operation];
      if (!operation) throw new Error(`Unknown recorded rollup operation ${input.operation}.`);
      return operation(await seed(input, (fn) => cleanups.push(fn)), input);
    },
    async close() {
      for (const cleanup of cleanups.reverse()) await cleanup();
    },
  };
}
