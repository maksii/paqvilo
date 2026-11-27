// Adapter for the dataverse-cascade surface: a recorded hosted run of relationship cascades -> an invented Solution (the
// recorded tables and the exported EntityRelationship elements, cascade values as exported) loaded into Mirage's
// Dataverse Web API -> the recorded snapshots. One session serves one case file, as the hosted run did.
// Portable conversions, the same for every case (the recording made the same ones):
//   - an owner is named by role: caller (the signed-in application user) or assignee (the second user);
//   - a record id is named by its key ({parent}, {link}, ...), a lookup to the parent reads "parent";
//   - object type codes in an error text read <code> (each environment numbers its custom tables).
import { entityXml, relationshipsXml, solutionWebApi } from '../../support/solution-web-api.mjs';

const ROWS = ['child', 'link', 'customActive', 'customInactive'];

function solutionFiles(schema) {
  const lookups = new Map(schema.tables.map((table) => [table, []]));
  for (const relationship of schema.relationships)
    if (relationship.type === 'OneToMany') lookups.get(relationship.referencing).push(relationship.lookup);
  const files = {};
  for (const table of schema.tables)
    files[`Entities/${table}/Entity.xml`] = entityXml({
      table,
      set: `${table}s`,
      name: 'inv_name',
      attributes: [['inv_name', 'nvarchar'], ...lookups.get(table).map((lookup) => [lookup, 'lookup'])],
    });
  files['Other/Relationships/relationships.xml'] = relationshipsXml(schema.relationships);
  return files;
}

/**
 * Opens one session per case file.
 * @param {{ surface: string, suite: string }} _context frozen names of the case file; this adapter needs none
 */
export async function open(_context) {
  let session = null;
  const ids = {};
  const users = {};
  const set = (table) => `${table}s`;
  const tables = {
    parent: 'inv_parent',
    child: 'inv_child',
    link: 'inv_link',
    customActive: 'inv_custom',
    customInactive: 'inv_custom',
    tag: 'inv_tag',
  };
  const record = (key) => `${set(tables[key])}(${ids[key]})`;
  const keyOf = new Map();
  const token = (id) => {
    if (id == null) return null;
    const lower = String(id).toLowerCase();
    return users[lower] ?? (keyOf.get(lower) === 'parent' ? 'parent' : (keyOf.get(lower) ?? `unknown:${id}`));
  };
  const owner = (id) => {
    const lower = String(id ?? '').toLowerCase();
    return users[lower] ?? token(id);
  };
  const text = (message) => {
    let result = String(message).replace(/ObjectTypeCode: \d+/g, 'ObjectTypeCode: <code>');
    for (const [id, key] of keyOf) result = result.replace(new RegExp(id, 'gi'), `{${key}}`);
    return result;
  };
  const error = (body) => (body?.error ? { code: body.error.code, message: text(body.error.message) } : null);
  const LOOKUPS = {
    child: ['_inv_parentid_value'],
    link: ['_inv_refparentid_value', '_inv_restrictparentid_value'],
    customActive: ['_inv_parentid_value'],
    customInactive: ['_inv_parentid_value'],
  };
  async function snapshot() {
    const { call } = session;
    const parent = await call(`${record('parent')}?$select=_ownerid_value`);
    const state = { parent: parent.status === 200 ? owner(parent.body._ownerid_value) : 'gone' };
    for (const key of ROWS) {
      const columns = ['_ownerid_value', ...LOOKUPS[key], ...(key.startsWith('custom') ? ['statecode'] : [])];
      const answer = await call(`${record(key)}?$select=${columns.join(',')}`);
      if (answer.status !== 200) {
        state[key] = { error: error(answer.body) };
        continue;
      }
      const row = {};
      for (const column of columns)
        row[column] =
          column === 'statecode'
            ? answer.body.statecode
            : column === '_ownerid_value'
              ? owner(answer.body[column])
              : token(answer.body[column]);
      state[key] = row;
    }
    const tag = await call(`${record('tag')}?$select=_ownerid_value`);
    state.tag = tag.status === 200 ? owner(tag.body._ownerid_value) : 'gone';
    const links = await call(`${record('tag')}/inv_parent_tag?$select=inv_parentid`);
    state.tagLinks = links.status === 200 ? links.body.value.length : 'gone';
    return state;
  }
  async function create(key, body) {
    const created = await session.call(`${set(tables[key])}?$select=${tables[key]}id`, {
      method: 'POST',
      headers: { prefer: 'return=representation' },
      body: { inv_name: key, ...body },
    });
    if (created.status !== 201) throw new Error(`${key}: HTTP ${created.status} ${JSON.stringify(created.body)}`);
    ids[key] = created.body[`${tables[key]}id`];
    keyOf.set(String(ids[key]).toLowerCase(), key);
  }
  const steps = {
    async setup(input) {
      session = await solutionWebApi(solutionFiles(input.schema));
      const { call } = session;
      const caller = (await call('WhoAmI')).body.UserId;
      users[String(caller).toLowerCase()] = 'caller';
      const unit = (await call('businessunits?$select=businessunitid&$filter=_parentbusinessunitid_value eq null')).body
        .value[0].businessunitid;
      const user = await call('systemusers?$select=systemuserid', {
        method: 'POST',
        headers: { prefer: 'return=representation' },
        body: {
          firstname: 'Invented',
          lastname: 'Assignee',
          domainname: 'assignee@invented.example',
          'businessunitid@odata.bind': `/businessunits(${unit})`,
        },
      });
      if (user.status !== 201) throw new Error(`assignee: HTTP ${user.status} ${JSON.stringify(user.body)}`);
      users[String(user.body.systemuserid).toLowerCase()] = 'assignee';
      users.assignee = user.body.systemuserid;
      await create('parent', {});
      const bind = `/${set('inv_parent')}(${ids.parent})`;
      await create('child', { 'inv_parentid@odata.bind': bind });
      await create('link', { 'inv_refparentid@odata.bind': bind, 'inv_restrictparentid@odata.bind': bind });
      await create('customActive', { 'inv_parentid@odata.bind': bind });
      await create('customInactive', { 'inv_parentid@odata.bind': bind });
      await create('tag', {});
      const inactive = await call(record('customInactive'), { method: 'PATCH', body: { statecode: 1, statuscode: 2 } });
      if (inactive.status !== 204)
        throw new Error(`deactivate: HTTP ${inactive.status} ${JSON.stringify(inactive.body)}`);
      const associate = await call(`${record('parent')}/inv_parent_tag/$ref`, {
        method: 'POST',
        body: { '@odata.id': `${session.base}${record('tag')}` },
      });
      if (associate.status >= 300)
        throw new Error(`associate: HTTP ${associate.status} ${JSON.stringify(associate.body)}`);
      return { state: await snapshot() };
    },
    async assign(input) {
      const answer = await session.call(record('parent'), {
        method: 'PATCH',
        body: { 'ownerid@odata.bind': `/systemusers(${users[input.to]})` },
      });
      return { status: answer.status, error: error(answer.body), state: await snapshot() };
    },
    async delete() {
      const answer = await session.call(record('parent'), { method: 'DELETE' });
      return { status: answer.status, error: error(answer.body), state: await snapshot() };
    },
    async clear(input) {
      const answer = await session.call(`${record(input.row)}/${input.lookup}/$ref`, { method: 'DELETE' });
      return { status: answer.status };
    },
  };
  return {
    async run(input) {
      const step = steps[input.op];
      if (!step) throw new Error(`Unknown cascade replay step ${input.op}.`);
      return step(input);
    },
    async close() {
      await session?.close();
    },
  };
}
