// @test-kind tooling: synthetic write-volume, keyset traversal, cascade and permission scaling gate for the reusable runtime
// Write-volume gate (runtime-performance.md, "Write-volume gate"): bulk creates, key upserts, single-record reads,
// key-set paging with a concurrent insert, a 1,000-child cascade and a deep share graph, each run at N and 2N rows.
// It asserts work, never time, through three measures of each operation:
// - the work the store counts (DataStore#work: rows that the counted scans and index builds visit, key-index lookups);
// - the array elements that JavaScript visits during the operation, whoever calls it (see arrayVisitCounter): Array
//   callbacks, searches, iterator steps, copies and sort passes, so a per-row scan outside the counted loops is seen too;
// - the array elements moved in place (block moves): those that splice, shift, unshift and copyWithin shift.
// Loops over a Map or a Set, indexed `for` loops and string scans are outside every measure.
// On the first two measures an O(n) path does at most twice its work at 2N plus a constant, a per-row scan of a growing
// array (O(n^2)) does about four times as much, and a single-record read does the same work at both sizes. Block moves
// have the same linear bound in a scenario that deletes no rows. A table is an ordered array, so removing a row moves
// the rows behind it, natively, in one block: a scenario that deletes k rows from a table of n rows may move at most the
// tail behind each removed row once (tailMoves), computed from its sizes at N and at 2N, and a second move per row
// fails. Paging is measured per page, and its most expensive page is compared, so a one-off cost on one page is not
// averaged away. Times are printed as diagnostics only. Mirage unit validation runs this file in its own process; run
// it alone with:
//   node --test mirage/test-volume/write-volume.test.mjs
// The record handlers run in process (no HTTP).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import {
  DEPTH,
  createPrincipals,
  ensureSecurityModel,
  privilegeId,
  privilegeName,
  uuidV5,
} from '../lib/dataverse-security.mjs';
import { organizationPrincipalContext } from '../lib/dataverse-principal-context.mjs';
import { parseDataverseRoute, parsePrefer } from '../lib/dataverse-odata.mjs';
import { createRecordHandlers } from '../lib/dataverse-records.mjs';
import { createChangeLog } from '../lib/dataverse-changes.mjs';
import { seed as seedStandardTables } from '../lib/dataverse-standard.mjs';

const ORIGIN = 'http://127.0.0.1:5555';
const ORG = '77777777-7777-4777-8777-777777777700';
const ADMIN_OID = '77777777-7777-4777-8777-777777777701';
const READER_OID = '77777777-7777-4777-8777-777777777702';
const SETTINGS = {
  organizationId: ORG,
  tenantId: 'tenant-volume',
  uniqueName: 'inventedvolume',
  friendlyName: 'Invented Volume',
  version: '9.2.25041.00000',
  users: [
    { objectId: ADMIN_OID, upn: 'admin@example.test', displayName: 'Admin', roles: ['System Administrator'] },
    { objectId: READER_OID, upn: 'reader@example.test', displayName: 'Reader', roles: [] },
  ],
};
const N = 2500;
// Linear work at 2N is at most twice the work at N plus this many fixed visits (an index built once, a seeded table read
// once); quadratic work at 2N is about four times the work at N, far above the bound.
const FIXED = 1000;
// The change log drops its oldest entries in one block move once it holds more than its limit: a commit moves at most
// this many entries, and each measured operation is one commit.
const CHANGE_LOG_LIMIT = 10_000;
// The most elements that deleting k rows from a table of n rows can move with one tail move per removed row: the j-th
// removal (from 0) leaves n - j - 1 rows, at most all of them behind the removed one.
const tailMoves = (k, n) => k * n - (k * (k + 1)) / 2;

async function fixture() {
  const state = emptyState();
  state.mappings.x_item = {
    logicalName: 'x_item',
    entitySet: 'x_items',
    idColumn: 'x_itemid',
    nameColumn: 'x_name',
    alternateKeys: [{ name: 'x_item_code', attributes: ['x_code'] }],
    fields: {
      x_name: { dataverseType: 'nvarchar' },
      x_code: { dataverseType: 'nvarchar' },
      x_rank: { dataverseType: 'int' },
      ownerid: { dataverseType: 'owner' },
    },
    relationships: {
      x_children: { entity: 'x_child', many: true, from: 'x_itemid', to: 'x_parentid', cascade: { delete: 'Cascade' } },
    },
  };
  state.mappings.x_child = {
    logicalName: 'x_child',
    entitySet: 'x_children',
    idColumn: 'x_childid',
    nameColumn: 'x_name',
    fields: { x_name: { dataverseType: 'nvarchar' }, x_parentid: { dataverseType: 'lookup' } },
    relationships: {
      x_parent: { entity: 'x_item', many: false, from: 'x_parentid', to: 'x_itemid', cascade: { delete: 'Cascade' } },
    },
  };
  state.tables.x_item = [];
  state.tables.x_child = [];
  const store = new DataStore({ state });
  // The standard tables give a delete the relationship volume of a real organization (thousands of relationships).
  await store.transact(() => seedStandardTables(store));
  await ensureSecurityModel(store, SETTINGS);
  const principals = createPrincipals(store, SETTINGS);
  const handlers = createRecordHandlers({
    store,
    change: (fn) => fn(),
    principals,
    metadataFields: () => undefined,
    changes: createChangeLog(store, { limit: CHANGE_LOG_LIMIT }),
  });
  const as = (user) => {
    const context = organizationPrincipalContext(store, user);
    return async (method, path, { body, headers = {} } = {}) => {
      const url = new URL(path.startsWith('http') ? path : `/api/data/v9.2/${path}`, ORIGIN);
      const response = await handlers.handle({
        method,
        route: parseDataverseRoute(url.pathname),
        url,
        origin: ORIGIN,
        version: 'v9.2',
        prefer: parsePrefer(headers.prefer),
        headers,
        body,
        user,
        caller: user,
        identity: context.identity,
        requestId: 'volume',
      });
      assert.ok(response.status < 400, `${method} ${path} answered ${response.status}`);
      return response.body;
    };
  };
  const admin = principals.byObjectId(ADMIN_OID),
    reader = principals.byObjectId(READER_OID);
  return { store, principals, admin, reader, send: as(admin), read: as(reader) };
}

const targets = (n, from = 0) =>
  Array.from({ length: n }, (_, i) => ({
    x_name: `Item ${from + i}`,
    x_code: `K${from + i}`,
    x_rank: (from + i) % 97,
  }));
const total = (work) => work.rowsVisited + work.indexLookups;
const shown = ({ work, ms }) =>
  `${work.rowsVisited} rows visited, ${work.indexLookups} index lookups, ${work.arrayVisits} array elements visited, ` +
  `${work.arrayMoves} array elements moved, ${Math.round(ms)} ms`;

// A relative array position as the shifting methods resolve it, within 0..length.
const position = (value, length, fallback) => {
  if (value === undefined) return fallback;
  const at = Math.trunc(Number(value)) || 0;
  return at < 0 ? Math.max(0, length + at) : Math.min(length, at);
};

// The second and third measures, while installed, whoever calls the methods. This file runs alone in its own process
// (the test runner isolates each file), so the measured call is the only code that runs.
// Visits: a callback method counts its callback calls (an early exit stops counting where it stops), a search counts
// the elements up to its match, an iterator counts its steps (for...of, spread, Array.from, new Set(array)), a copy the
// elements it copies (splice counts the elements it removes), and a sort one pass (n log n comparisons would not be
// linear). Moves: splice counts the elements it shifts (none when it removes as many as it inserts), shift and unshift
// the elements they shift, copyWithin the elements it copies.
const CALLBACK_METHODS = [
  'every',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flatMap',
  'forEach',
  'map',
  'reduce',
  'reduceRight',
  'some',
];
const ITERATORS = ['values', 'keys', 'entries', Symbol.iterator];
function arrayVisitCounter() {
  const saved = new Map();
  let visits = 0,
    moves = 0;
  // The wrappers pass their arguments on with Reflect.apply: a spread would step an array iterator and count itself.
  const replace = (name, wrap) => {
    const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, name);
    saved.set(name, descriptor);
    Object.defineProperty(Array.prototype, name, { ...descriptor, value: wrap(descriptor.value) });
  };
  const install = () => {
    for (const name of CALLBACK_METHODS)
      replace(
        name,
        (original) =>
          function (...args) {
            const callback = args[0];
            if (typeof callback === 'function')
              args[0] = function (...values) {
                visits++;
                return Reflect.apply(callback, this, values);
              };
            return Reflect.apply(original, this, args);
          },
      );
    for (const name of ['includes', 'indexOf'])
      replace(
        name,
        (original) =>
          function (...args) {
            const found = Reflect.apply(saved.get('indexOf').value, this, args);
            visits += found < 0 ? this.length : found + 1;
            return Reflect.apply(original, this, args);
          },
      );
    replace(
      'lastIndexOf',
      (original) =>
        function (...args) {
          const found = Reflect.apply(original, this, args);
          visits += found < 0 ? this.length : this.length - found;
          return found;
        },
    );
    replace(
      'splice',
      (original) =>
        function (...args) {
          const length = this.length,
            start = position(args[0], length, 0);
          if (args.length) {
            const removed =
              args.length < 2
                ? length - start
                : Math.min(length - start, Math.max(0, Math.trunc(Number(args[1])) || 0));
            visits += removed;
            if (removed !== Math.max(0, args.length - 2)) moves += length - start - removed;
          }
          return Reflect.apply(original, this, args);
        },
    );
    replace(
      'shift',
      (original) =>
        function () {
          moves += Math.max(0, this.length - 1);
          return original.call(this);
        },
    );
    replace(
      'unshift',
      (original) =>
        function (...args) {
          if (args.length) moves += this.length;
          return Reflect.apply(original, this, args);
        },
    );
    replace(
      'copyWithin',
      (original) =>
        function (...args) {
          const length = this.length,
            target = position(args[0], length, 0),
            start = position(args[1], length, 0),
            end = position(args[2], length, length);
          moves += Math.max(0, Math.min(end - start, length - target));
          return Reflect.apply(original, this, args);
        },
    );
    for (const name of ['slice', 'concat', 'sort', 'toSorted', 'reverse', 'join'])
      replace(
        name,
        (original) =>
          function (...args) {
            const result = Reflect.apply(original, this, args);
            visits += Array.isArray(result) ? result.length : this.length;
            return result;
          },
      );
    for (const name of ITERATORS)
      replace(
        name,
        (original) =>
          function () {
            const iterator = original.call(this);
            const counted = Object.create(Iterator.prototype);
            counted.next = () => {
              visits++;
              return iterator.next();
            };
            return counted;
          },
      );
  };
  const remove = () => {
    saved.forEach((descriptor, name) => Object.defineProperty(Array.prototype, name, descriptor));
    saved.clear();
  };
  return {
    async count(fn) {
      visits = 0;
      moves = 0;
      install();
      let counted;
      try {
        await fn();
      } finally {
        counted = { visits, moves };
        remove();
      }
      return counted;
    },
  };
}
const arrayVisits = arrayVisitCounter();

// The store's work, the array elements visited and moved (and, as a diagnostic, the time) of `fn`.
async function measured(store, fn) {
  const before = store.work,
    started = performance.now();
  const { visits, moves } = await arrayVisits.count(fn);
  const ms = performance.now() - started,
    after = store.work;
  return {
    work: {
      rowsVisited: after.rowsVisited - before.rowsVisited,
      indexLookups: after.indexLookups - before.indexLookups,
      arrayVisits: visits,
      arrayMoves: moves,
    },
    ms,
  };
}
// Runs `run(size)` on fresh fixtures at N and 2N. `run` answers the measured work of the operation and the number of
// items it handled at that size; the work must cover at least those items (the counters see the operation). A linear
// operation stays within twice its work at N plus FIXED; a `constant` one does exactly the same work at both sizes.
// A run that deletes rows answers `moveCeiling`, the most elements its removals may move (tailMoves); its moves are
// held to that ceiling at each size instead of the linear bound.
async function scales(t, name, run, { constant = false } = {}) {
  const small = await run(N),
    large = await run(2 * N);
  t.diagnostic(`${name}: N=${N}: ${shown(small)}; 2N=${2 * N}: ${shown(large)}`);
  assert.ok(total(small.work) >= small.items, `${name}: the counters saw the operation at N (${shown(small)})`);
  assert.ok(
    small.work.arrayVisits >= small.items,
    `${name}: the array measure saw the operation at N (${shown(small)})`,
  );
  if (constant) {
    assert.deepEqual(large.work, small.work, `${name} did more work in a larger table`);
    return;
  }
  assert.ok(
    total(large.work) <= 2 * total(small.work) + FIXED,
    `${name}: the counted work grew faster than linearly from ${N} to ${2 * N} rows: ${shown(small)} -> ${shown(large)}`,
  );
  assert.ok(
    large.work.arrayVisits <= 2 * small.work.arrayVisits + FIXED,
    `${name}: the array elements visited grew faster than linearly from ${N} to ${2 * N} rows: ` +
      `${shown(small)} -> ${shown(large)}`,
  );
  if (small.moveCeiling === undefined)
    assert.ok(
      large.work.arrayMoves <= 2 * small.work.arrayMoves + FIXED + CHANGE_LOG_LIMIT,
      `${name}: the array elements moved grew faster than linearly from ${N} to ${2 * N} rows: ` +
        `${shown(small)} -> ${shown(large)}`,
    );
  else
    for (const [size, result] of [
      [N, small],
      [2 * N, large],
    ])
      assert.ok(
        result.work.arrayMoves <= result.moveCeiling,
        `${name}: at ${size} rows the removals moved more than one tail per removed row ` +
          `(${result.moveCeiling} at most): ${shown(result)}`,
      );
}

// @test-kind contract: DataStore#work is the store's own read-only work count; a caller only reads a copy
test('the work counters count a table scan and an index lookup, and callers only get a copy', async () => {
  const { send, store } = await fixture();
  const { Ids: ids } = await send('POST', 'x_items/Microsoft.Dynamics.CRM.CreateMultiple', {
    body: { Targets: targets(3) },
  });
  const rows = store.state.tables.x_item,
    mapping = store.state.mappings.x_item;
  store.rowIndex(mapping, rows, ids[0]);
  const before = store.work,
    copy = store.work;
  copy.rowsVisited = -1;
  copy.indexLookups = -1;
  assert.deepEqual(store.work, before, 'a changed copy leaves the counters as they are');
  // A key the index answers is one lookup; a non-string key is a scan of every row.
  assert.equal(store.rowIndex(mapping, rows, ids[1]), 1);
  assert.equal(store.rowIndex(mapping, rows, 42), -1);
  const after = store.work;
  assert.deepEqual(
    { rowsVisited: after.rowsVisited - before.rowsVisited, indexLookups: after.indexLookups - before.indexLookups },
    { rowsVisited: 3, indexLookups: 1 },
  );
});

// @test-kind contract: the array measures count the elements scans visit and the elements in-place shifts move, then remove themselves
test('the array measures count visited and moved elements and leave Array.prototype as they found it', async () => {
  const before = Object.getOwnPropertyDescriptors(Array.prototype);
  const rows = Array.from({ length: 10 }, (_, i) => i);
  let sum = 0;
  const counted = await arrayVisits.count(() => {
    rows.includes(4); // stops at its match: 5 visits
    rows.find((row) => row === 2); // three callback calls: 3 visits
    for (const row of rows) sum += row; // ten steps and the final one: 11 visits
    rows.splice(7, 1); // removes one (1 visit) and moves the two behind it: 2 moves
    rows.splice(9, 0, 'end'); // inserts at the end: no move
    rows.splice(0, 1, 'first'); // replaces in place: 1 visit, no move
    rows.shift(); // moves the nine behind the first: 9 moves
    rows.unshift('a'); // moves all nine: 9 moves
    rows.copyWithin(0, 6); // copies the last four: 4 moves
  });
  assert.equal(sum, 45);
  assert.deepEqual(counted, { visits: 5 + 3 + 11 + 1 + 1, moves: 2 + 9 + 9 + 4 });
  assert.deepEqual(rows, [6, 8, 9, 'end', 4, 5, 6, 8, 9, 'end']);
  assert.deepEqual(Object.getOwnPropertyDescriptors(Array.prototype), before);
});

// @test-kind contract: the move ceiling of k removals from a table of n rows is one tail per removed row
test('the move ceiling is the largest tail behind each removed row', () => {
  // Three removals from seven rows: at most 6, then 5, then 4 rows behind the removed one.
  assert.equal(tailMoves(3, 7), 6 + 5 + 4);
  assert.equal(tailMoves(7, 7), 6 + 5 + 4 + 3 + 2 + 1);
  assert.equal(tailMoves(1, 1), 0);
});

test('CreateMultiple stays linear in the number of targets (primary and alternate key indexes)', async (t) => {
  await scales(t, 'CreateMultiple', async (n) => {
    const { send, store } = await fixture();
    const result = await measured(store, () =>
      send('POST', 'x_items/Microsoft.Dynamics.CRM.CreateMultiple', { body: { Targets: targets(n) } }),
    );
    assert.equal(store.state.tables.x_item.length, n);
    return { ...result, items: n };
  });
});

test('UpsertMultiple by alternate key stays linear in the number of targets', async (t) => {
  await scales(t, 'UpsertMultiple', async (n) => {
    const { send, store } = await fixture();
    await send('POST', 'x_items/Microsoft.Dynamics.CRM.CreateMultiple', { body: { Targets: targets(n) } });
    const result = await measured(store, () =>
      send('POST', 'x_items/Microsoft.Dynamics.CRM.UpsertMultiple', {
        body: {
          Targets: Array.from({ length: n }, (_, i) => ({
            '@odata.id': `x_items(x_code='K${i}')`,
            x_name: `Updated ${i}`,
          })),
        },
      }),
    );
    assert.equal(store.state.tables.x_item.length, n);
    assert.ok(store.state.tables.x_item.every((row) => row.x_name.startsWith('Updated')));
    return { ...result, items: n };
  });
});

test('single-record reads stay constant in the table size (index before the row-security filter)', async (t) => {
  await scales(
    t,
    'single-record read',
    async (n) => {
      const { send, store, principals, admin } = await fixture();
      const { Ids: ids } = await send('POST', 'x_items/Microsoft.Dynamics.CRM.CreateMultiple', {
        body: { Targets: targets(n) },
      });
      const filter = principals.readFilter({ user: admin, entity: 'x_item' }) ?? (() => true);
      const { identity } = organizationPrincipalContext(store, admin);
      const read = (id) => {
        const [row] = store.query('x_item', { $select: 'x_name,x_itemid' }, identity, undefined, {
          id,
          dialect: 'dataverse',
          backendRowsFilter: (name, candidate) => filter(candidate),
        }).value;
        assert.equal(row.x_itemid, id);
      };
      // The first read builds the primary-key index once; the reads after it are measured.
      read(ids[0]);
      const result = await measured(store, () => {
        for (let i = 0; i < 2000; i++) read(ids[(i * 37) % n]);
      });
      return { ...result, items: 2000 };
    },
    { constant: true },
  );
});

test('key-set paging visits every row once despite a concurrent insert, at a linear cost per page', async (t) => {
  await scales(t, 'paging (most expensive page)', async (n) => {
    const { send, store } = await fixture();
    const { Ids: originalIds } = await send('POST', 'x_items/Microsoft.Dynamics.CRM.CreateMultiple', {
      body: { Targets: targets(n) },
    });
    const seen = [],
      work = { rowsVisited: 0, indexLookups: 0, arrayVisits: 0, arrayMoves: 0 };
    let next = 'x_items?$select=x_name&$orderby=x_rank',
      ms = 0,
      inserted = false;
    while (next) {
      let page;
      // Only the page reads are measured, not the concurrent insert.
      const result = await measured(store, async () => {
        page = await send('GET', next, { headers: { prefer: 'odata.maxpagesize=500' } });
      });
      // Each measure keeps its most expensive page, so a one-off cost on any page is not averaged away.
      for (const name of Object.keys(work)) work[name] = Math.max(work[name], result.work[name]);
      ms = Math.max(ms, result.ms);
      seen.push(...page.value.map((row) => row.x_itemid));
      next = page['@odata.nextLink'];
      // A row that sorts before the cursor arrives after the first page: the offset would repeat a row.
      if (!inserted) {
        inserted = true;
        await send('POST', 'x_items', { body: { x_name: 'Late', x_code: 'LATE', x_rank: 0 } });
      }
    }
    assert.equal(seen.length, n);
    assert.equal(new Set(seen).size, n);
    assert.deepEqual([...seen].sort(), [...originalIds].sort());
    // Each page reads the whole result once (row security, then the key-set selection): every page costs O(n).
    return { work, ms, items: n };
  });
});

test('a cascade delete of a 1,000-child tree stays linear in the number of children, with one tail move per removed row', async (t) => {
  await scales(t, 'cascade delete', async (n) => {
    const children = Math.round(n / 2.5); // 1,000 children at N; 2,000 at 2N
    const { send, store } = await fixture();
    const {
      Ids: [parent],
    } = await send('POST', 'x_items/Microsoft.Dynamics.CRM.CreateMultiple', { body: { Targets: targets(1) } });
    await send('POST', 'x_children/Microsoft.Dynamics.CRM.CreateMultiple', {
      body: {
        Targets: Array.from({ length: children }, (_, i) => ({
          x_name: `Child ${i}`,
          'x_parent@odata.bind': `/x_items(${parent})`,
        })),
      },
    });
    const result = await measured(store, () => send('DELETE', `x_items(${parent})`));
    assert.equal(store.state.tables.x_child.length, 0);
    assert.equal(store.state.tables.x_item.length, 0);
    // Every child of a table of `children` rows and the parent of a table of one row.
    return { ...result, items: children, moveCeiling: tailMoves(children, children) + tailMoves(1, 1) };
  });
});

// @test-kind security: only the exact Basic-depth shares to the reader's teams may appear in the paged result
test('a reader of a deep share graph sees every shared row at a linear cost', async (t) => {
  await scales(t, 'share graph read', async (n) => {
    const { store, principals, admin, reader, read } = await fixture();
    const noun = principals.privilegeNoun('x_item');
    const role = uuidV5(ORG, 'role:volume-share-reader'),
      teams = Array.from({ length: 12 }, (_, i) => uuidV5(ORG, `team:volume-${i}`));
    const ref = (logical, id) => ({ id, logical_name: logical });
    await store.transact(() => {
      const tables = store.state.tables;
      // Basic read only: the reader sees a row through a share with one of its teams.
      tables.role.push({
        roleid: role,
        name: 'Volume share reader',
        businessunitid: reader.businessunitid,
        organizationid: ref('organization', ORG),
      });
      tables.roleprivileges.push({
        roleprivilegeid: uuidV5(role, 'read'),
        roleid: ref('role', role),
        privilegeid: ref('privilege', privilegeId(ORG, privilegeName('read', noun))),
        privilegedepthmask: DEPTH.Basic,
      });
      tables.systemuserroles.push({
        systemuserroleid: uuidV5(role, reader.systemuserid),
        systemuserid: ref('systemuser', reader.systemuserid),
        roleid: ref('role', role),
      });
      for (const team of teams) {
        tables.team.push({
          teamid: team,
          name: `Volume team ${team.slice(-4)}`,
          teamtype: 0,
          businessunitid: reader.businessunitid,
          organizationid: ref('organization', ORG),
        });
        tables.teammembership.push({
          teammembershipid: uuidV5(team, reader.systemuserid),
          systemuserid: ref('systemuser', reader.systemuserid),
          teamid: ref('team', team),
        });
      }
      for (let i = 0; i < n; i++) {
        const id = uuidV5(ORG, `volume-row:${i}`);
        tables.x_item.push({
          x_itemid: id,
          x_name: `Shared ${i}`,
          x_code: `S${i}`,
          x_rank: i % 97,
          ownerid: ref('systemuser', admin.systemuserid),
          statecode: 0,
          statuscode: 1,
        });
        // Every second row is shared; the others stay invisible to the reader.
        if (i % 2 === 0)
          tables.principalobjectaccess.push({
            principalobjectaccessid: uuidV5(id, 'share'),
            principalid: ref('team', teams[i % teams.length]),
            objectid: id,
            objecttypecode: 'x_item',
            accessrightsmask: 1,
            inheritedaccessrightsmask: 0,
          });
      }
    });
    let visible = 0;
    const seen = [];
    const result = await measured(store, async () => {
      let next = 'x_items?$select=x_name';
      while (next) {
        const page = await read('GET', next, { headers: { prefer: 'odata.maxpagesize=5000' } });
        visible += page.value.length;
        seen.push(...page.value.map((row) => row.x_itemid));
        next = page['@odata.nextLink'];
      }
    });
    assert.equal(visible, n / 2);
    assert.equal(seen.length, new Set(seen).size, 'a shared row is visible exactly once');
    assert.ok(
      seen.every((id) => typeof id === 'string'),
      'the selected projection includes the primary key',
    );
    const expected = new Set(Array.from({ length: n / 2 }, (_, index) => uuidV5(ORG, `volume-row:${index * 2}`)));
    assert.equal(seen.length, expected.size);
    assert.ok(
      seen.every((id) => expected.has(id)),
      'the exact visible rows are the even-index shared ids',
    );
    return { ...result, items: n };
  });
});
