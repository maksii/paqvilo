// Adapter for the dataverse-calculated surface: a recorded hosted run of designer calculated columns -> an invented Solution
// (the recorded column types and the exported Formulas XAML) loaded into Mirage's Dataverse Web API -> the recorded reads.
// One session serves one case file, as the hosted run did: the setup case seeds the rows through the Web API, later
// cases read, write and query them in file order.
// Portable conversions, the same for every case:
//   - Mirage's clock is fixed at noon UTC of the recorded day (input.clock): the recorded creation times fall on that UTC
//     day, and the output keeps only that date (createdonDate);
//   - a record is answered without OData annotations, @odata.etag, @odata.context and its id, as the recording kept it.
import { entityXml, relationshipsXml, solutionWebApi } from '../../support/solution-web-api.mjs';

const xmlText = (text) => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

// The <attribute> body of one recorded column fact: { type, precision, options, sourceType, formula }.
function attributeBody({ precision, options, formula }) {
  let extra = '';
  if (precision !== undefined) extra += `<Accuracy>${precision}</Accuracy>`;
  if (options)
    extra +=
      '<optionset><OptionSetType>picklist</OptionSetType><options>' +
      options
        .map(
          (value) =>
            `<option value="${value}"><labels><label description="${value}" languagecode="1033" /></labels></option>`,
        )
        .join('') +
      '</options></optionset>';
  if (formula)
    extra += `<SourceType>1</SourceType><FormulaDefinitionFileName>/Formulas/${xmlText(formula)}</FormulaDefinitionFileName>`;
  return extra;
}

function solutionFiles(schema) {
  const { parent, child } = schema;
  const files = {};
  files[`Entities/${parent.table}/Entity.xml`] = entityXml({
    table: parent.table,
    set: parent.set,
    name: 'inv_name',

    attributes: Object.entries(parent.columns).map(([column, facts]) => [column, facts.type, attributeBody(facts)]),
  });
  const attributes = Object.entries(child.columns).map(([column, facts]) => [
    column,
    facts.type,
    attributeBody({ ...facts, options: child.options?.[column] }),
  ]);
  attributes.push([child.lookup.column, 'lookup', '']);
  for (const [column, facts] of Object.entries(child.calculated)) {
    const formula = `${child.table}-${column}.xaml`;
    files[`Entities/${child.table}/Formulas/${formula}`] = facts.xaml;
    attributes.push([column, facts.type, attributeBody({ precision: facts.precision, formula })]);
  }
  files[`Entities/${child.table}/Entity.xml`] = entityXml({
    table: child.table,
    set: child.set,
    name: 'inv_name',

    attributes,
  });
  files['Other/Relationships/relationships.xml'] = relationshipsXml([
    {
      schemaName: child.lookup.relationship,
      type: 'OneToMany',
      referencing: child.table,
      referenced: parent.table,
      lookup: child.lookup.column,
    },
  ]);
  return files;
}

const plain = (body) => Object.fromEntries(Object.entries(body ?? {}).filter(([key]) => !key.includes('@')));

/**
 * Opens one session per case file.
 * @param {{ surface: string, suite: string }} _context frozen names of the case file; this adapter needs none
 */
export async function open(_context) {
  let session = null;
  let schema = null;
  const ids = { parents: {}, children: {} };
  const record = (key) => `${schema.child.set}(${ids.children[key]})`;
  const steps = {
    async setup(input) {
      schema = input.schema;
      session = await solutionWebApi(solutionFiles(schema), { clock: Date.parse(`${input.clock}T12:00:00Z`) });
      const { call } = session;
      let parents = 0,
        children = 0;
      for (const key of input.parents) {
        const created = await call(`${schema.parent.set}?$select=${schema.parent.table}id`, {
          method: 'POST',
          headers: { prefer: 'return=representation' },
          body: { inv_name: key },
        });
        if (created.status !== 201)
          throw new Error(`parent ${key}: HTTP ${created.status} ${JSON.stringify(created.body)}`);
        ids.parents[key] = created.body[`${schema.parent.table}id`];
        parents += 1;
      }
      for (const { key, parent, values } of input.children) {
        const created = await call(`${schema.child.set}?$select=${schema.child.table}id`, {
          method: 'POST',
          headers: { prefer: 'return=representation' },
          body: {
            inv_name: key,
            [`${schema.child.lookup.column}@odata.bind`]: `/${schema.parent.set}(${ids.parents[parent]})`,
            ...values,
          },
        });
        if (created.status !== 201)
          throw new Error(`child ${key}: HTTP ${created.status} ${JSON.stringify(created.body)}`);
        ids.children[key] = created.body[`${schema.child.table}id`];
        children += 1;
      }
      for (const key of input.deactivate) {
        const answer = await call(record(key), { method: 'PATCH', body: { statecode: 1, statuscode: 2 } });
        if (answer.status !== 204) throw new Error(`deactivate ${key}: HTTP ${answer.status}`);
      }
      return { parents, children };
    },
    async read(input) {
      const answer = await session.call(`${record(input.child)}?$select=${input.select.join(',')}`);
      if (answer.status !== 200) return { status: answer.status, error: answer.body?.error ?? null };
      const body = plain(answer.body);
      const output = {};
      for (const column of input.select)
        if (column === 'createdon') output.createdonDate = body.createdon?.slice(0, 10) ?? null;
        else output[column] = body[column] ?? null;
      return output;
    },
    async patch(input) {
      const answer = await session.call(record(input.child), { method: 'PATCH', body: input.body });
      return { status: answer.status, error: answer.body?.error ?? null };
    },
    async query(input) {
      const query = new URLSearchParams({
        $select: input.select.join(','),
        $filter: input.filter,
        $orderby: input.orderby,
      });
      const answer = await session.call(`${schema.child.set}?${query}`);
      return {
        status: answer.status,
        rows: (answer.body?.value ?? []).map((row) => input.select.map((column) => row[column] ?? null)),
        error: answer.body?.error ?? null,
      };
    },
  };
  return {
    async run(input) {
      const step = steps[input.op];
      if (!step) throw new Error(`Unknown calculated replay step ${input.op}.`);
      return step(input);
    },
    async close() {
      await session?.close();
    },
  };
}
