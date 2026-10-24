// Duplicate detection: seeded duplicate rule tables, the MSCRM.SuppressDuplicateDetection gate on create
// and update, the match operators, and the publish, unpublish and RetrieveDuplicates operations.
// The registry and hooks are exercised through a fake api.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DataStore, emptyState } from '../lib/data.mjs';
import { DataError } from '../lib/data-error.mjs';
import { install, parseDuplicateRuleXml, readDuplicateRuleSolution, reset } from '../lib/dataverse-duplicates.mjs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataverseError } from '../lib/dataverse-odata.mjs';

const ORIGIN = 'http://127.0.0.1:5555';
const VERSION = 'v9.2';
const ADMIN = { admin: true };
const GATE = { 'mscrm.suppressduplicatedetection': 'false' };
const DUPLICATE_MESSAGE =
  'A record was not created or updated because a duplicate of the current record already exists.';
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = { dataverseType: 'nvarchar' };
// Every privilege check passes unless a test replaces it.
const ALLOW_ALL = { authorize: () => 1, readFilter: () => null, privileges: () => new Map() };
const DENY = {
  ...ALLOW_ALL,
  authorize: () => {
    throw new DataError('Privilege denied', 403, 'PrivilegeDenied');
  },
};

async function setup({ principals = ALLOW_ALL } = {}) {
  const state = emptyState();
  state.mappings.widget = {
    logicalName: 'widget',
    entitySet: 'widgets',
    idColumn: 'widgetid',
    nameColumn: 'name',
    fields: { name: text, code: text, statecode: { dataverseType: 'int' } },
  };
  state.tables.widget = [];
  const store = new DataStore({ state });
  const ops = [];
  const hooks = {};
  const api = {
    store,
    principals,
    change: (fn) => fn(),
    log: () => {},
    registry: { register: (op) => ops.push(op) },
    recordHooks: { add: (name, fn) => (hooks[name] = fn) },
  };
  await install(api);
  return {
    api,
    store,
    hooks,
    mapping: store.state.mappings.widget,
    op: (name) => ops.find((o) => o.name === name),
    rows: () => store.state.tables.widget,
    rules: () => store.state.tables.duplicaterule,
  };
}

// Adds a widget rule with conditions; published unless the test says otherwise.
function addRule(t, rule) {
  const id = randomUUID();
  const published = rule.published ?? true;
  t.rules().push({
    duplicateruleid: id,
    name: 'rule',
    baseentityname: 'widget',
    matchingentityname: 'widget',
    excludeinactiverecords: rule.excludeInactive ?? false,
    iscasesensitive: rule.caseSensitive ?? false,
    statecode: published ? 1 : 0,
    statuscode: published ? 2 : 0,
  });
  for (const c of rule.conditions) {
    t.store.state.tables.duplicaterulecondition.push({
      duplicateruleconditionid: randomUUID(),
      regardingobjectid: id,
      baseattributename: c.base,
      matchingattributename: c.matching ?? c.base,
      operatorcode: c.op ?? 'ExactMatch',
      operatorparam: c.param ?? null,
      ignoreblankvalues: c.ignoreBlank ?? false,
    });
  }
  return id;
}

const write = (t, operation, data, headers = GATE, existing) =>
  t.hooks.beforeWrite({ headers }, t.mapping, { operation, data, existing });
const errorOf = (fn) => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
};
const target = (t, id) => ({ id, row: t.rules().find((r) => r.duplicateruleid === id) });

test('install seeds the duplicate rule tables as dataverseOnly and leaves a mapping it does not own', async () => {
  const store = new DataStore({ state: emptyState() });
  store.state.mappings.duplicaterulecondition = {
    logicalName: 'duplicaterulecondition',
    entitySet: 'custom',
    idColumn: 'custom_id',
    fields: {},
  };
  await install({ store, change: (fn) => fn(), registry: { register() {} }, recordHooks: { add() {} } });
  const rule = store.state.mappings.duplicaterule;
  assert.equal(rule.dataverseOnly, true);
  assert.equal(rule.userConfigured, true);
  assert.equal(rule.idColumn, 'duplicateruleid');
  assert.deepEqual(store.state.tables.duplicaterule, []);
  assert.equal(store.state.mappings.duplicaterulecondition.entitySet, 'custom');
  assert.equal(store.state.tables.duplicaterulecondition, undefined);
});

test('install registers the three operations on their documented bindings', async () => {
  const t = await setup();
  assert.deepEqual(
    ['PublishDuplicateRule', 'UnpublishDuplicateRule', 'RetrieveDuplicates'].map((name) => {
      const op = t.op(name);
      return [op.name, op.kind, op.binding, op.entity];
    }),
    [
      ['PublishDuplicateRule', 'action', 'entity', 'duplicaterule'],
      ['UnpublishDuplicateRule', 'action', 'unbound', undefined],
      ['RetrieveDuplicates', 'function', 'unbound', undefined],
    ],
  );
});

test('a create or update is checked only when MSCRM.SuppressDuplicateDetection is false', async () => {
  const t = await setup();
  addRule(t, { conditions: [{ base: 'code' }] });
  t.rows().push({ widgetid: ID(10), code: 'A1', statecode: 0 }, { widgetid: ID(11), code: 'B2', statecode: 0 });
  assert.equal(
    errorOf(() => write(t, 'create', { code: 'A1' }, {})),
    null,
  );
  assert.equal(
    errorOf(() => write(t, 'create', { code: 'A1' }, { 'mscrm.suppressduplicatedetection': 'true' })),
    null,
  );
  const error = errorOf(() => write(t, 'create', { code: 'A1' }, { 'MSCRM.SuppressDuplicateDetection': 'False' }));
  assert.ok(error instanceof DataError);
  assert.equal(error.status, 412);
  assert.equal(error.message, DUPLICATE_MESSAGE);
  assert.deepEqual(error.details, { innerCode: '0x80040333' });
  const http = dataverseError(error, { requestId: 'r' });
  assert.deepEqual(
    [http.status, http.body.error.code, http.body.error.message],
    [412, '0x80040333', DUPLICATE_MESSAGE],
  );
  assert.ok(errorOf(() => write(t, 'update', { code: 'A1' }, GATE, t.rows()[1])) instanceof DataError);
  assert.equal(
    errorOf(() => write(t, 'delete', {}, GATE, t.rows()[0])),
    null,
  );
});

test("a solution's duplicaterules folder imports rules with their state and conditions, and the rule then applies", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'invented-duplicates-'));
  try {
    const folder = join(dir, 'duplicaterules', 'invented_rule');
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, 'duplicaterule.xml'),
      `<duplicaterule uniquename="invented_rule">
  <baseentityname>widget</baseentityname>
  <description>Invented rule</description>
  <excludeinactiverecords>1</excludeinactiverecords>
  <iscasesensitive>0</iscasesensitive>
  <matchingentityname>widget</matchingentityname>
  <name>Invented widget rule</name>
  <duplicaterulecondition><baseattributename>code</baseattributename><matchingattributename>code</matchingattributename><operatorcode>0</operatorcode><ignoreblankvalues>1</ignoreblankvalues></duplicaterulecondition>
</duplicaterule>`,
    );
    const rows = await readDuplicateRuleSolution(join(dir, 'duplicaterules'));
    assert.equal(rows.duplicaterule.length, 1);
    assert.deepEqual(
      [rows.duplicaterule[0].statecode, rows.duplicaterule[0].statuscode],
      [1, 2],
      'no state in the file: published',
    );
    assert.deepEqual(
      rows.duplicaterulecondition.map((c) => [c.baseattributename, c.operatorcode, c.ignoreblankvalues]),
      [['code', 0, true]],
    );
    const t = await setup();
    t.rules().push(...rows.duplicaterule);
    t.store.state.tables.duplicaterulecondition.push(...rows.duplicaterulecondition);
    t.rows().push({ widgetid: ID(10), code: 'A1', statecode: 0 });
    assert.ok(errorOf(() => write(t, 'create', { code: 'A1' })) instanceof DataError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a rule file with statecode 0 imports as a draft (statuscode 1)', () => {
  const xml = `<duplicaterule uniquename="invented_draft"><baseentityname>widget</baseentityname><matchingentityname>widget</matchingentityname><name>Draft</name><statecode>0</statecode></duplicaterule>`;
  const rule = parseDuplicateRuleXml(xml).duplicaterule;
  assert.deepEqual([rule.statecode, rule.statuscode], [0, 1]);
});

test("the organization's isduplicatedetectionenabled switches the check off; a missing flag leaves it on", async () => {
  const t = await setup();
  addRule(t, { conditions: [{ base: 'code' }] });
  t.rows().push({ widgetid: ID(10), code: 'A1', statecode: 0 });
  t.store.state.tables.organization = [{ organizationid: ID(1), isduplicatedetectionenabled: false }];
  assert.equal(
    errorOf(() => write(t, 'create', { code: 'A1' }, GATE)),
    null,
  );
  t.store.state.tables.organization[0].isduplicatedetectionenabled = true;
  assert.ok(errorOf(() => write(t, 'create', { code: 'A1' }, GATE)) instanceof DataError);
});

test('ExactMatch ignores case unless the rule is case-sensitive', async () => {
  const loose = await setup();
  addRule(loose, { conditions: [{ base: 'code' }] });
  loose.rows().push({ widgetid: ID(10), code: 'Abc', statecode: 0 });
  assert.ok(errorOf(() => write(loose, 'create', { code: 'ABC' })) instanceof DataError);

  const strict = await setup();
  addRule(strict, { caseSensitive: true, conditions: [{ base: 'code' }] });
  strict.rows().push({ widgetid: ID(10), code: 'Abc', statecode: 0 });
  assert.equal(
    errorOf(() => write(strict, 'create', { code: 'ABC' })),
    null,
  );
  assert.ok(errorOf(() => write(strict, 'create', { code: 'Abc' })) instanceof DataError);
});

test('SameFirst and SameLast compare N characters and never match a shorter value', async () => {
  const first = await setup();
  addRule(first, { conditions: [{ base: 'name', op: 'SameFirst', param: 3 }] });
  first
    .rows()
    .push({ widgetid: ID(10), name: 'Contoso Ltd', statecode: 0 }, { widgetid: ID(11), name: 'Co', statecode: 0 });
  assert.ok(errorOf(() => write(first, 'create', { name: 'Conan' })) instanceof DataError);
  assert.equal(
    errorOf(() => write(first, 'create', { name: 'Cosmo' })),
    null,
  );
  assert.equal(
    errorOf(() => write(first, 'create', { name: 'Col' })),
    null,
  );

  const last = await setup();
  addRule(last, { conditions: [{ base: 'name', op: 'SameLast', param: 3 }] });
  last.rows().push({ widgetid: ID(10), name: 'Acme Ltd', statecode: 0 });
  assert.ok(errorOf(() => write(last, 'create', { name: 'Corp Ltd' })) instanceof DataError);
  assert.equal(
    errorOf(() => write(last, 'create', { name: 'Corp Inc' })),
    null,
  );
});

test('operators outside the documented seven are rejected', async () => {
  const t = await setup();
  addRule(t, { conditions: [{ base: 'code', op: 7 }] });
  t.rows().push({ widgetid: ID(10), code: 'A1', statecode: 0 });
  const error = errorOf(() => write(t, 'create', { code: 'A1' }));
  assert.ok(error instanceof DataError);
  assert.equal(error.status, 400);
});

test('blank values never match in a single-condition rule and match only when blanks are not ignored', async () => {
  const single = await setup();
  addRule(single, { conditions: [{ base: 'code' }] });
  single.rows().push({ widgetid: ID(10), code: '', statecode: 0 });
  assert.equal(
    errorOf(() => write(single, 'create', { code: '' })),
    null,
  );

  const lenient = await setup();
  addRule(lenient, { conditions: [{ base: 'name' }, { base: 'code', ignoreBlank: false }] });
  lenient.rows().push({ widgetid: ID(10), name: 'Acme', code: '', statecode: 0 });
  assert.ok(errorOf(() => write(lenient, 'create', { name: 'Acme' })) instanceof DataError);

  const strict = await setup();
  addRule(strict, { conditions: [{ base: 'name' }, { base: 'code', ignoreBlank: true }] });
  strict.rows().push({ widgetid: ID(10), name: 'Acme', code: '', statecode: 0 });
  assert.equal(
    errorOf(() => write(strict, 'create', { name: 'Acme' })),
    null,
  );
});

test('excludeInactiveRecords skips inactive matching rows', async () => {
  const excluding = await setup();
  addRule(excluding, { excludeInactive: true, conditions: [{ base: 'code' }] });
  excluding.rows().push({ widgetid: ID(10), code: 'A1', statecode: 1 });
  assert.equal(
    errorOf(() => write(excluding, 'create', { code: 'A1' })),
    null,
  );

  const including = await setup();
  addRule(including, { conditions: [{ base: 'code' }] });
  including.rows().push({ widgetid: ID(10), code: 'A1', statecode: 1 });
  assert.ok(errorOf(() => write(including, 'create', { code: 'A1' })) instanceof DataError);
});

test('an update is not a duplicate of its own row', async () => {
  const t = await setup();
  addRule(t, { conditions: [{ base: 'code' }] });
  const self = { widgetid: ID(10), code: 'A1', statecode: 0 };
  t.rows().push(self, { widgetid: ID(11), code: 'B2', statecode: 0 });
  assert.equal(
    errorOf(() => write(t, 'update', { code: 'A1' }, GATE, self)),
    null,
  );
  assert.ok(errorOf(() => write(t, 'update', { code: 'A1' }, GATE, t.rows()[1])) instanceof DataError);
});

test('only published rules apply, and publishing is limited to five per table', async () => {
  const t = await setup();
  const ids = Array.from({ length: 6 }, () => addRule(t, { published: false, conditions: [{ base: 'code' }] }));
  t.rows().push({ widgetid: ID(10), code: 'A1', statecode: 0 });
  assert.equal(
    errorOf(() => write(t, 'create', { code: 'A1' })),
    null,
  );

  const publish = t.op('PublishDuplicateRule').handle;
  const unpublish = t.op('UnpublishDuplicateRule').handle;
  const statusOf = (id) => t.rules().find((r) => r.duplicateruleid === id).statuscode;

  for (const id of ids.slice(0, 5))
    assert.equal((await publish({ target: target(t, id), identity: ADMIN })).status, 200);
  assert.equal(statusOf(ids[0]), 2);
  await assert.rejects(
    publish({ target: target(t, ids[5]), identity: ADMIN }),
    (e) => e instanceof DataError && e.status === 400,
  );
  assert.equal(statusOf(ids[5]), 0);
  assert.ok(errorOf(() => write(t, 'create', { code: 'A1' }, GATE)) instanceof DataError);

  assert.equal((await unpublish({ body: { DuplicateRuleId: ids[0] }, identity: ADMIN })).status, 204);
  assert.equal(statusOf(ids[0]), 0);
  await publish({ target: target(t, ids[5]), identity: ADMIN });
  assert.equal(statusOf(ids[5]), 2);
});

test('RetrieveDuplicates returns matching rows except the record itself, paged by Count', async () => {
  const t = await setup();
  addRule(t, { conditions: [{ base: 'code' }] });
  t.rows().push(
    { widgetid: ID(10), code: 'X', statecode: 0 },
    { widgetid: ID(20), code: 'X', statecode: 0 },
    { widgetid: ID(30), code: 'Y', statecode: 0 },
    { widgetid: ID(40), code: 'X', statecode: 0 },
  );
  const retrieve = t.op('RetrieveDuplicates').handle;
  const business = { LogicalName: 'widget', widgetid: ID(20), code: 'X' };
  const all = await retrieve({
    params: { BusinessEntity: business, MatchingEntityName: 'widget' },
    origin: ORIGIN,
    version: VERSION,
  });
  assert.equal(all.status, 200);
  assert.deepEqual(
    all.body.value.map((r) => r.widgetid),
    [ID(10), ID(40)],
  );
  const second = await retrieve({
    params: { BusinessEntity: business, MatchingEntityName: 'widget', PagingInfo: { Count: 1, PageNumber: 2 } },
    origin: ORIGIN,
    version: VERSION,
  });
  assert.deepEqual(
    second.body.value.map((r) => r.widgetid),
    [ID(40)],
  );
});

test('publish returns a JobId and commits the rule through a transaction', async () => {
  const t = await setup();
  const id = addRule(t, { published: false, conditions: [{ base: 'code' }] });
  const before = t.store.revision;
  const result = await t
    .op('PublishDuplicateRule')
    .handle({ target: target(t, id), identity: ADMIN, user: ADMIN, origin: ORIGIN, version: VERSION });
  assert.match(result.body.JobId, GUID_RE);
  assert.equal(
    result.body['@odata.context'],
    `${ORIGIN}/api/data/${VERSION}/$metadata#Microsoft.Dynamics.CRM.PublishDuplicateRuleResponse`,
  );
  assert.equal(t.rules().find((r) => r.duplicateruleid === id).statuscode, 2);
  assert.ok(t.store.revision > before);
});

test('publish and unpublish need the write privilege, and a refused call leaves the rule as it was', async () => {
  const t = await setup({ principals: DENY });
  const id = addRule(t, { published: false, conditions: [{ base: 'code' }] });
  const before = t.store.revision;
  await assert.rejects(
    t.op('PublishDuplicateRule').handle({ target: target(t, id), identity: ADMIN, user: ADMIN }),
    (e) => e.status === 403,
  );
  await assert.rejects(
    t.op('UnpublishDuplicateRule').handle({ body: { DuplicateRuleId: id }, identity: ADMIN, user: ADMIN }),
    (e) => e.status === 403,
  );
  assert.equal(t.rules().find((r) => r.duplicateruleid === id).statuscode, 0);
  assert.equal(t.store.revision, before);
});

test('RetrieveDuplicates needs read on the matching table', async () => {
  const t = await setup({ principals: DENY });
  addRule(t, { conditions: [{ base: 'code' }] });
  t.rows().push({ widgetid: ID(10), code: 'X', statecode: 0 });
  const business = { LogicalName: 'widget', widgetid: ID(20), code: 'X' };
  await assert.rejects(
    t.op('RetrieveDuplicates').handle({
      user: ADMIN,
      params: { BusinessEntity: business, MatchingEntityName: 'widget' },
      origin: ORIGIN,
      version: VERSION,
    }),
    (e) => e.status === 403,
  );
});

test('RetrieveDuplicates leaves out rows the caller cannot read, before paging', async () => {
  const t = await setup({ principals: { ...ALLOW_ALL, readFilter: () => (row) => row.widgetid !== ID(10) } });
  addRule(t, { conditions: [{ base: 'code' }] });
  t.rows().push({ widgetid: ID(10), code: 'X', statecode: 0 }, { widgetid: ID(40), code: 'X', statecode: 0 });
  const business = { LogicalName: 'widget', widgetid: ID(20), code: 'X' };
  const result = await t.op('RetrieveDuplicates').handle({
    user: ADMIN,
    params: { BusinessEntity: business, MatchingEntityName: 'widget' },
    origin: ORIGIN,
    version: VERSION,
  });
  assert.deepEqual(
    result.body.value.map((r) => r.widgetid),
    [ID(40)],
  );
  const none = await setup({ principals: { ...ALLOW_ALL, readFilter: () => () => false } });
  addRule(none, { conditions: [{ base: 'code' }] });
  none.rows().push({ widgetid: ID(10), code: 'X', statecode: 0 });
  const empty = await none.op('RetrieveDuplicates').handle({
    user: ADMIN,
    params: { BusinessEntity: business, MatchingEntityName: 'widget' },
    origin: ORIGIN,
    version: VERSION,
  });
  assert.deepEqual(empty.body.value, []);
});

test('RetrieveDuplicates formats rows as a normal read: lookups as _x_value, secured columns masked', async () => {
  const t = await setup();
  t.mapping.fields.ownerid = { dataverseType: 'lookup' };
  t.mapping.fields.secret = text;
  t.api.fieldSecurity = { mask: (user, logical, row) => ({ ...row, secret: undefined }) };
  addRule(t, { conditions: [{ base: 'code' }] });
  t.rows().push({
    widgetid: ID(10),
    code: 'X',
    statecode: 0,
    ownerid: { id: ID(99), logical_name: 'systemuser', name: '' },
    secret: 'S3CRET',
  });
  const business = { LogicalName: 'widget', widgetid: ID(20), code: 'X' };
  const result = await t.op('RetrieveDuplicates').handle({
    user: ADMIN,
    params: { BusinessEntity: business, MatchingEntityName: 'widget' },
    origin: ORIGIN,
    version: VERSION,
  });
  const [row] = result.body.value;
  assert.equal(row._ownerid_value, ID(99));
  assert.equal(
    row._ownerid_value_associatednavigationproperty ??
      row['_ownerid_value@Microsoft.Dynamics.CRM.associatednavigationproperty'],
    'ownerid',
  );
  assert.equal(row.ownerid, undefined);
  assert.equal(row.secret ?? null, null);
});

test('same date, same date and time, and the two pick list operators match as documented', async () => {
  const stamp = { dataverseType: 'datetime' };
  const color = {
    dataverseType: 'picklist',
    options: [
      { value: 1, label: 'Red' },
      { value: 2, label: 'Red' },
      { value: 3, label: 'Blue' },
    ],
  };
  for (const [op, stored, dup, other] of [
    [3, '2026-10-19T09:00:00Z', '2026-10-19T17:30:00Z', '2026-10-20T09:00:00Z'],
    [4, '2026-10-19T09:00:00Z', '2026-10-19T09:00:00Z', '2026-10-19T17:30:00Z'],
  ]) {
    const t = await setup();
    t.mapping.fields.stamp = stamp;
    addRule(t, { conditions: [{ base: 'stamp', op }] });
    t.rows().push({ widgetid: ID(10), stamp: stored, statecode: 0 });
    assert.ok(errorOf(() => write(t, 'create', { stamp: dup })) instanceof DataError, `operator ${op} duplicate`);
    assert.equal(
      errorOf(() => write(t, 'create', { stamp: other })),
      null,
      `operator ${op} distinct`,
    );
  }
  for (const [op, dup, other] of [
    [5, 2, 3],
    [6, 1, 2],
  ]) {
    const t = await setup();
    t.mapping.fields.color = color;
    addRule(t, { conditions: [{ base: 'color', op }] });
    t.rows().push({ widgetid: ID(10), color: 1, statecode: 0 });
    assert.ok(errorOf(() => write(t, 'create', { color: dup })) instanceof DataError, `operator ${op} duplicate`);
    assert.equal(
      errorOf(() => write(t, 'create', { color: other })),
      null,
      `operator ${op} distinct`,
    );
  }
});

test('RetrieveDuplicates honours a PagingCookie offset and rejects a malformed one', async () => {
  const t = await setup();
  addRule(t, { conditions: [{ base: 'code' }] });
  t.rows().push(
    { widgetid: ID(10), code: 'X', statecode: 0 },
    { widgetid: ID(20), code: 'X', statecode: 0 },
    { widgetid: ID(30), code: 'Y', statecode: 0 },
    { widgetid: ID(40), code: 'X', statecode: 0 },
  );
  const retrieve = t.op('RetrieveDuplicates').handle;
  const business = { LogicalName: 'widget', widgetid: ID(20), code: 'X' };
  const request = (PagingInfo) => ({
    params: { BusinessEntity: business, MatchingEntityName: 'widget', PagingInfo },
    origin: ORIGIN,
    version: VERSION,
  });
  const cookie = Buffer.from(JSON.stringify({ offset: 1 })).toString('base64url');
  const page = await retrieve(request({ Count: 1, PagingCookie: cookie }));
  assert.deepEqual(
    page.body.value.map((r) => r.widgetid),
    [ID(40)],
  );
  await assert.rejects(retrieve(request({ Count: 1, PagingCookie: 'bogus!' })), (e) => e.status === 400);
});

test('every duplicate operation carries CSDL with its documented binding and types', async () => {
  const t = await setup();
  const csdl = (name) => t.op(name).csdl;
  assert.ok(csdl('PublishDuplicateRule').includes('<Action Name="PublishDuplicateRule" IsBound="true">'));
  assert.ok(csdl('PublishDuplicateRule').includes('<ReturnType Type="mscrm.asyncoperation" Nullable="false" />'));
  assert.ok(
    csdl('UnpublishDuplicateRule').includes('<Parameter Name="DuplicateRuleId" Type="Edm.Guid" Nullable="false" />'),
  );
  assert.ok(csdl('RetrieveDuplicates').includes('<Parameter Name="PagingInfo" Type="mscrm.PagingInfo" />'));
  assert.ok(
    csdl('RetrieveDuplicates').includes('<ReturnType Type="Collection(mscrm.crmbaseentity)" Nullable="false" />'),
  );
});

test('reset(api) re-seeds the duplicate rule tables after a wipe', async () => {
  const t = await setup();
  for (const logical of ['duplicaterule', 'duplicaterulecondition']) {
    delete t.store.state.mappings[logical];
    delete t.store.state.tables[logical];
  }
  await reset(t.api);
  assert.equal(t.store.state.mappings.duplicaterule.dataverseOnly, true);
  assert.deepEqual(t.store.state.tables.duplicaterule, []);
  assert.deepEqual(t.store.state.tables.duplicaterulecondition, []);
});

// BulkDetectDuplicates (an asynchronous system job, operationtype 8) and CompoundUpdateDuplicateDetectionRule (one write).
// The fake system job returns the next id and keeps the work for the test to run, as dataverse-async runs it on a later tick.
function fakeSystemJobs(t, ids = [ID(99)]) {
  const jobs = [];
  t.api.systemJob = async (job, work) => {
    const id = ids[jobs.length];
    jobs.push({ job, id, work });
    return id;
  };
  return jobs;
}
const detect = (t, body = { Query: { EntityName: 'widget' } }) =>
  t
    .op('BulkDetectDuplicates')
    .handle({ origin: ORIGIN, version: VERSION, user: ADMIN, caller: { systemuserid: ID(7) }, body });
const threePairRows = (t) =>
  t
    .rows()
    .push(
      { widgetid: ID(1), name: 'A', code: 'a' },
      { widgetid: ID(2), name: 'B', code: 'a' },
      { widgetid: ID(3), name: 'C', code: 'b' },
    );

test('BulkDetectDuplicates submits one detection job that counts the duplicate pairs of the published rules', async () => {
  const t = await setup();
  addRule(t, { conditions: [{ base: 'code' }] });
  threePairRows(t);
  const jobs = fakeSystemJobs(t);
  const res = await detect(t, { Query: { EntityName: 'widget' }, JobName: 'Nightly' });
  assert.equal(res.status, 200);
  assert.equal(res.body.JobId, ID(99));
  assert.deepEqual(jobs[0].job, { name: 'Nightly', operationtype: 8, callerId: ID(7) });
  assert.equal(await jobs[0].work(), '2 duplicate records detected for widget');
  assert.equal(t.rows().length, 3, 'detection writes no widget rows');
});

test('BulkDetectDuplicates writes one duplicaterecord row per detected pair, linked to the job', async () => {
  const t = await setup();
  const rule = addRule(t, { conditions: [{ base: 'code' }] });
  threePairRows(t);
  const jobs = fakeSystemJobs(t);
  await detect(t);
  await jobs[0].work();
  const dups = t.store.state.tables.duplicaterecord;
  // Rows A and B match, so each one is a base record with the other as the duplicate (both directions, in scan order).
  assert.equal(dups.length, 2);
  assert.deepEqual(
    dups.map((r) => [r.baserecordid.id, r.duplicaterecordid.id]),
    [
      [ID(1), ID(2)],
      [ID(2), ID(1)],
    ],
  );
  for (const row of dups) {
    assert.equal(row.asyncoperationid.id, ID(99));
    assert.equal(row.duplicateruleid.id, rule);
    assert.equal(row.baserecordidtypecode, 'widget');
    assert.equal(row.duplicaterecordidtypecode, 'widget');
    assert.match(row.duplicateid, GUID_RE);
    assert.ok(!Number.isNaN(Date.parse(row.createdon)));
  }
  assert.equal(new Set(dups.map((r) => r.duplicateid)).size, 2);
});

test("a rerun of BulkDetectDuplicates writes its own rows and keeps the earlier job's", async () => {
  const t = await setup();
  addRule(t, { conditions: [{ base: 'code' }] });
  threePairRows(t);
  const jobs = fakeSystemJobs(t, [ID(99), ID(98)]);
  await detect(t);
  await detect(t);
  await jobs[0].work();
  await jobs[1].work();
  const dups = t.store.state.tables.duplicaterecord;
  assert.equal(dups.length, 4);
  const jobOf = (id) => dups.filter((r) => r.asyncoperationid.id === id).length;
  assert.equal(jobOf(ID(99)), 2);
  assert.equal(jobOf(ID(98)), 2);
  assert.equal(new Set(dups.map((r) => r.duplicateid)).size, 4, "each job's rows get their own ids");
});

test('BulkDetectDuplicates refuses a query without an entity and an unknown entity', async () => {
  const t = await setup();
  const op = t.op('BulkDetectDuplicates');
  const call = (body) =>
    op.handle({ origin: ORIGIN, version: VERSION, user: ADMIN, caller: { systemuserid: ID(7) }, body });
  await assert.rejects(call({ Query: {} }), (e) => e.status === 400);
  await assert.rejects(call({ Query: { EntityName: 'gadget' } }), (e) => e.status === 404);
});

test('CompoundUpdateDuplicateDetectionRule updates the rule and its named conditions in one call, and a missing condition rolls the call back', async () => {
  const t = await setup();
  const ruleId = addRule(t, { conditions: [{ base: 'code' }] });
  const condition = t.store.state.tables.duplicaterulecondition[0];
  const op = t.op('CompoundUpdateDuplicateDetectionRule');
  const res = await op.handle({
    origin: ORIGIN,
    version: VERSION,
    user: ADMIN,
    identity: ADMIN,
    body: {
      Entity: { duplicateruleid: ruleId, name: 'Renamed', excludeinactiverecords: true, unknownColumn: 'ignored' },
      ChildEntities: [
        { duplicateruleconditionid: condition.duplicateruleconditionid, operatorcode: 1, ignoreblankvalues: true },
      ],
    },
  });
  assert.equal(res.status, 204);
  const rule = t.rules().find((r) => r.duplicateruleid === ruleId);
  assert.equal(rule.name, 'Renamed');
  assert.equal(rule.excludeinactiverecords, true);
  assert.equal('unknownColumn' in rule, false);
  const updated = t.store.state.tables.duplicaterulecondition.find(
    (r) => r.duplicateruleconditionid === condition.duplicateruleconditionid,
  );
  assert.equal(updated.operatorcode, 1);
  assert.equal(updated.ignoreblankvalues, true);
  await assert.rejects(
    op.handle({
      origin: ORIGIN,
      version: VERSION,
      user: ADMIN,
      identity: ADMIN,
      body: { Entity: { duplicateruleid: ID(404) } },
    }),
    (e) => e.status === 404,
  );
  await assert.rejects(
    op.handle({
      origin: ORIGIN,
      version: VERSION,
      user: ADMIN,
      identity: ADMIN,
      body: {
        Entity: { duplicateruleid: ruleId, name: 'Lost' },
        ChildEntities: [{ duplicateruleconditionid: ID(405), operatorcode: 2 }],
      },
    }),
    (e) => e.status === 404,
  );
  assert.equal(
    t.rules().find((r) => r.duplicateruleid === ruleId).name,
    'Renamed',
    'the rule change of the refused call is not kept',
  );
});

test('CompoundUpdateDuplicateDetectionRule is refused without write on the rule, and the rule is unchanged', async () => {
  const t = await setup({ principals: DENY });
  const ruleId = addRule(t, { conditions: [{ base: 'code' }] });
  await assert.rejects(
    t.op('CompoundUpdateDuplicateDetectionRule').handle({
      origin: ORIGIN,
      version: VERSION,
      user: ADMIN,
      body: { Entity: { duplicateruleid: ruleId, name: 'Denied' }, ChildEntities: [] },
    }),
    (e) => e.status === 403,
  );
  assert.equal(t.rules().find((r) => r.duplicateruleid === ruleId).name, 'rule');
});
