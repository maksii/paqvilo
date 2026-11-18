// @test-kind contract: provisioning reruns retain a complete journal for the compiled action plan without repeating writes
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DataverseClient } from '../lense/dataverse/client.mjs';
import { compileManifest, validateManifest } from '../lense/dataverse/manifest.mjs';
import {
  planManifest,
  applyManifest,
  checkKeys,
  publishManifest,
  compatible,
  scopeSolutionRoots,
} from '../lense/dataverse/provision.mjs';
import {
  parseRegistrationOutput,
  parseCredentialFile,
  publicConnection,
  environmentOrigin,
  privateJson,
  tokenProvider,
} from '../lense/dataverse/connection.mjs';
import { tempDir, loopbackServer } from './fixture.mjs';

const CLI_HANG_GUARD_MS = 170_000; // hang guard only: a blocked synchronous child cannot be ended by the test runner

function fixtureManifest() {
  const manifest = {
    schemaVersion: 1,
    publisher: {
      uniqueName: 'fictionalpublisher',
      friendlyName: 'Fictional Publisher',
      prefix: 'tst',
      optionValuePrefix: 12345,
    },
    solutions: [{ uniqueName: 'FictionalSchema', friendlyName: 'Fictional schema', version: '1.0.0.0' }],
    choices: [
      {
        name: 'tst_kind',
        label: 'Kind',
        solution: 'FictionalSchema',
        options: [
          { value: 123450000, label: 'First' },
          { value: 123450001, label: 'Second' },
        ],
      },
    ],
    tables: [
      {
        name: 'tst_node',
        entitySetName: 'tst_nodes',
        label: 'Node',
        pluralLabel: 'Nodes',
        ownership: 'organization',
        solution: 'FictionalSchema',
        primaryName: { name: 'tst_name', label: 'Name', maxLength: 160 },
        columns: [
          { name: 'tst_code', label: 'Code', type: 'string', maxLength: 40, required: 'required' },
          { name: 'tst_kind', label: 'Kind', type: 'choice', choice: 'tst_kind' },
          { name: 'tst_notes', label: 'Notes', type: 'memo', maxLength: 262144 },
          { name: 'tst_date', label: 'Date', type: 'datetime', behavior: 'DateOnly' },
        ],
        keys: [{ name: 'tst_node_code', columns: ['tst_code'] }],
      },
      {
        name: 'tst_leaf',
        entitySetName: 'tst_leaves',
        label: 'Leaf',
        pluralLabel: 'Leaves',
        ownership: 'user',
        solution: 'FictionalSchema',
        primaryName: { name: 'tst_name', label: 'Name', maxLength: 160 },
        columns: [],
      },
    ],
    relationships: [
      {
        name: 'tst_node_leaves',
        kind: 'oneToMany',
        parent: 'tst_node',
        child: 'tst_leaf',
        solution: 'FictionalSchema',
        lookup: { name: 'tst_nodeid', label: 'Node', required: 'required' },
      },
      {
        name: 'tst_node_peers',
        kind: 'manyToMany',
        parent: 'tst_node',
        child: 'tst_node',
        intersectName: 'tst_nodepeer',
        intersectColumns: ['tst_nodeone', 'tst_nodetwo'],
        solution: 'FictionalSchema',
      },
    ],
  };
  manifest.tables[0].columns.push({ name: 'tst_flag', label: 'Flag', type: 'boolean' });
  manifest.tables[0].keys[0].columns = ['tst_code', 'tst_date'];
  manifest.forms = [
    {
      id: 'fa140000-0000-4000-8000-000000000001',
      table: 'tst_node',
      name: 'Fictional Node',
      solution: 'FictionalSchema',
      formXml: '<form><tabs/></form>',
    },
  ];
  return manifest;
}

async function serverFixture(t) {
  const state = {
    publishers: [],
    solutions: [],
    forms: new Map(),
    choices: new Map(),
    tables: new Map(),
    relationships: [],
    components: [],
    requests: [],
    organisationId: randomUUID(),
    failCreate: false,
    platformPrimaryNameLength: null, // the primary-name MaxLength a table create stores, when the platform overrides it
    retainPrimaryNameUpdate: true,
    tableUpdates: [],
  };
  const send = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  const handle = async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : null;
    const url = new URL(req.url, 'http://fixture.local');
    const route = decodeURIComponent(url.pathname).replace('/api/data/v9.2/', '');
    state.requests.push({ route, method: req.method, body, solution: req.headers['mscrm.solutionuniquename'] });
    assert.equal(req.headers.authorization, 'Bearer invented-token');
    if (req.method === 'POST' && state.failCreate && route === 'EntityDefinitions')
      return send(res, 503, { error: { message: 'do-not-print-private-server-response' } });
    if (req.method === 'GET') {
      if (route === 'WhoAmI')
        return send(res, 200, {
          OrganizationId: state.organisationId,
          UserId: randomUUID(),
          BusinessUnitId: randomUUID(),
        });
      if (route.startsWith('systemforms(')) {
        const row = state.forms.get(route.match(/\(([^)]+)\)/)[1]);
        return row ? send(res, 200, row) : send(res, 404, {});
      }
      if (route === 'publishers' || route === 'solutions') {
        const filter = url.searchParams.get('$filter'),
          name = filter.match(/eq '([^']+)'/)?.[1];
        return send(res, 200, { value: state[route].filter((row) => row.uniquename === name) });
      }
      if (route === 'solutioncomponents') {
        const filter = url.searchParams.get('$filter');
        return send(res, 200, {
          value: state.components.filter(
            (c) =>
              (!filter.includes('objectid eq') || filter.includes(c.objectid)) &&
              filter.includes(c._solutionid_value) &&
              (!filter.includes('componenttype eq') || filter.endsWith(' ' + c.componenttype)),
          ),
        });
      }
      if (route.startsWith('GlobalOptionSetDefinitions(')) {
        const found = state.choices.get(route.match(/Name='([^']+)'/)[1]);
        return found ? send(res, 200, found) : send(res, 404, {});
      }
      if (route === 'RelationshipDefinitions')
        return send(res, 200, {
          value: state.relationships.filter(
            (r) => r.SchemaName === url.searchParams.get('$filter').match(/eq '([^']+)'/)[1],
          ),
        });
      if (route.startsWith('EntityDefinitions(')) {
        const table = state.tables.get(route.match(/LogicalName='([^']+)'/)[1]);
        if (!table) return send(res, 404, {});
        if (route.includes('/Attributes(')) {
          const name = route.match(/Attributes\(LogicalName='([^']+)'/)[1],
            attribute = table.Attributes.find((a) => a.LogicalName === name);
          const value = attribute ? structuredClone(attribute) : null;
          if (
            value?.['@odata.type'] === 'Microsoft.Dynamics.CRM.BooleanAttributeMetadata' &&
            url.searchParams.get('$expand') !== 'OptionSet'
          )
            delete value.OptionSet;
          return value ? send(res, 200, value) : send(res, 404, {});
        }
        if (route.endsWith('/Keys'))
          return send(res, 200, {
            value: table.Keys.filter((k) => k.SchemaName === url.searchParams.get('$filter').match(/eq '([^']+)'/)[1]),
          });
        return send(res, 200, table);
      }
      return send(res, 404, {});
    }
    if (req.method === 'POST') {
      let id = randomUUID();
      const actual = structuredClone(body);
      if (route === 'publishers') {
        actual.publisherid = id;
        state.publishers.push(actual);
      } else if (route === 'systemforms') {
        assert.ok(body.formid);
        assert.equal(body.systemformid, undefined);
        id = body.formid;
        state.forms.set(id, actual);
      } else if (route === 'solutions') {
        actual.solutionid = id;
        actual._publisherid_value = body['publisherid@odata.bind'].match(/\(([^)]+)\)/)[1];
        state.solutions.push(actual);
      } else if (route === 'GlobalOptionSetDefinitions') {
        actual.MetadataId = id;
        state.choices.set(body.Name, actual);
      } else if (route === 'EntityDefinitions') {
        actual.MetadataId = id;
        actual.LogicalName = body.SchemaName.toLowerCase();
        actual.Keys = [];
        for (const attribute of actual.Attributes) {
          attribute.MetadataId = randomUUID();
          attribute.LogicalName = attribute.SchemaName.toLowerCase();
          if (attribute.IsPrimaryName && state.platformPrimaryNameLength)
            attribute.MaxLength = state.platformPrimaryNameLength;
        }
        state.tables.set(actual.LogicalName, actual);
      } else if (route.endsWith('/Attributes')) {
        const table = state.tables.get(route.match(/LogicalName='([^']+)'/)[1]);
        actual.MetadataId = id;
        actual.LogicalName = body.SchemaName.toLowerCase();
        if (body['GlobalOptionSet@odata.bind']) {
          const choiceId = body['GlobalOptionSet@odata.bind'].match(/\(([0-9a-f-]{36})\)/)?.[1];
          assert.ok(choiceId, 'choice writes must bind a resolved MetadataId');
          actual.GlobalOptionSet = [...state.choices.values()].find((c) => c.MetadataId === choiceId);
        }
        table.Attributes.push(actual);
      } else if (route === 'RelationshipDefinitions') {
        actual.MetadataId = id;
        state.relationships.push(actual);
        if (body.Lookup)
          state.tables.get(body.ReferencingEntity).Attributes.push({
            ...body.Lookup,
            IsAuditEnabled: { Value: false },
            MetadataId: randomUUID(),
            LogicalName: body.Lookup.SchemaName.toLowerCase(),
          });
      } else if (route.endsWith('/Keys')) {
        actual.MetadataId = id;
        actual.KeyAttributes.reverse();
        actual.EntityKeyIndexStatus = 'Pending';
        state.tables.get(route.match(/LogicalName='([^']+)'/)[1]).Keys.push(actual);
      } else if (route === 'AddSolutionComponent') {
        const sid = state.solutions.find((s) => s.uniquename === body.SolutionUniqueName).solutionid,
          existing = state.components.find(
            (c) =>
              c.objectid === body.ComponentId && c.componenttype === body.ComponentType && c._solutionid_value === sid,
          );
        // As observed on Dataverse: a whole table root (behaviour 0) lists none of its subcomponents separately.
        const wholeRootOf = (table) =>
          state.components.some(
            (c) =>
              c.componenttype === 1 &&
              c.rootcomponentbehavior === 0 &&
              c._solutionid_value === sid &&
              c.objectid === table?.MetadataId,
          );
        const ownerTable = (id) =>
          [...state.tables.values()].find(
            (table) =>
              table.Attributes.some((a) => a.MetadataId === id) ||
              table.Keys.some((k) => k.MetadataId === id) ||
              state.relationships.some((r) => r.MetadataId === id && r.ReferencingEntity === table.LogicalName) ||
              state.forms.get(id)?.objecttypecode === table.LogicalName,
          );
        if (body.ComponentType === 1 && body.DoNotIncludeSubcomponents === false) {
          if (existing) existing.rootcomponentbehavior = 0;
          const table = [...state.tables.values()].find((t) => t.MetadataId === body.ComponentId);
          state.components = state.components.filter(
            (c) => c.componenttype === 1 || c._solutionid_value !== sid || ownerTable(c.objectid) !== table,
          );
        }
        if (body.ComponentType !== 1 && wholeRootOf(ownerTable(body.ComponentId))) return send(res, 200, {});
        if (!existing)
          state.components.push({
            solutioncomponentid: randomUUID(),
            objectid: body.ComponentId,
            componenttype: body.ComponentType,
            _solutionid_value: sid,
            ...(body.ComponentType === 1 ? { rootcomponentbehavior: body.DoNotIncludeSubcomponents ? 1 : 0 } : {}),
          });
        return send(res, 200, {});
      } else if (route === 'RemoveSolutionComponent') {
        assert.equal(body.SolutionComponent['@odata.type'], 'Microsoft.Dynamics.CRM.solutioncomponent');
        const id = body.SolutionComponent.solutioncomponentid,
          sid = state.solutions.find((s) => s.uniquename === body.SolutionUniqueName).solutionid;
        assert.ok(
          state.components.some(
            (c) => c.objectid === id && c.componenttype === body.ComponentType && c._solutionid_value === sid,
          ),
          'the Web API entity wrapper carries object identity, not membership PK',
        );
        state.components = state.components.filter(
          (c) => !(c.objectid === id && c.componenttype === body.ComponentType && c._solutionid_value === sid),
        );
        return send(res, 200, {});
      } else if (route === 'PublishXml') return send(res, 200, {});
      else return send(res, 400, { error: { message: 'unsupported fixture route' } });
      res.writeHead(204, {
        'OData-EntityId': `http://${req.headers.host}/api/data/v9.2/${route}(${id})`,
      });
      return res.end();
    }
    if (req.method === 'PUT' && /^EntityDefinitions\([0-9a-f-]{36}\)$/.test(route)) {
      const table = [...state.tables.values()].find((t) => route.includes(t.MetadataId));
      assert.equal(req.headers['mscrm.mergelabels'], 'true');
      assert.equal(body['@odata.type'], 'Microsoft.Dynamics.CRM.EntityMetadata');
      assert.equal(body.Attributes, undefined, 'a table update does not carry its columns');
      state.tableUpdates.push(body);
      for (const name of ['DisplayName', 'DisplayCollectionName', 'Description']) table[name] = body[name];
      return send(res, 204, {});
    }
    if (req.method === 'PUT' && route.includes('/Attributes(')) {
      const table = state.tables.get(route.match(/LogicalName='([^']+)'/)[1]),
        id = route.match(/Attributes\(([0-9a-f-]+)\)/)[1],
        index = table.Attributes.findIndex((a) => a.MetadataId === id);
      assert.equal(req.headers['mscrm.mergelabels'], 'true');
      assert.ok(
        ['Microsoft.Dynamics.CRM.LookupAttributeMetadata', 'Microsoft.Dynamics.CRM.StringAttributeMetadata'].includes(
          body['@odata.type'],
        ),
      );
      if (body['@odata.type'] === 'Microsoft.Dynamics.CRM.StringAttributeMetadata' && !state.retainPrimaryNameUpdate)
        return send(res, 204, {});
      table.Attributes[index] = body;
      return send(res, 200, {});
    }
    send(res, 405, {});
  };
  const client = new DataverseClient({
    environmentUrl: await loopbackServer(t, handle),
    allowLoopback: true,
    token: async () => 'invented-token',
  });
  return { state, client };
}

test('offline compiler orders dependencies and emits global bindings, ownership and lookup deep insert', () => {
  const plan = compileManifest(fixtureManifest());
  assert.equal(plan.actions[0].kind, 'publisher');
  assert.equal(plan.actions[1].kind, 'solution');
  const choice = plan.actions.find((a) => a.kind === 'choice');
  assert.equal(choice.route, 'GlobalOptionSetDefinitions');
  const typed = plan.actions.find((a) => a.key === 'column:tst_node.tst_kind');
  assert.equal(typed.body['GlobalOptionSet@odata.bind'], "/GlobalOptionSetDefinitions(Name='tst_kind')");
  const leaf = plan.actions.find((a) => a.key === 'table:tst_leaf');
  assert.equal(leaf.body.OwnershipType, 'UserOwned');
  assert.equal(leaf.body.Attributes[0].IsPrimaryName, true);
  const relation = plan.actions.find((a) => a.key === 'relationship:tst_node_leaves');
  assert.equal(relation.body.Lookup.SchemaName, 'tst_nodeid');
  assert.equal(relation.body.CascadeConfiguration.Delete, 'Restrict');
  assert.ok(plan.actions.findIndex((a) => a.kind === 'key') > plan.actions.findIndex((a) => a.kind === 'relationship'));
  assert.equal(plan.actions.find((a) => a.kind === 'key').solution, 'FictionalSchema');
  const form = plan.actions.find((a) => a.kind === 'form');
  assert.equal(form.body.formid, 'fa140000-0000-4000-8000-000000000001');
  assert.equal(form.body.systemformid, undefined);
});

test('table notes and activities flags reach the entity payload and default to false', () => {
  const manifest = fixtureManifest();
  manifest.tables[0].notes = true;
  manifest.tables[0].activities = true;
  const plan = compileManifest(manifest);
  const node = plan.actions.find((a) => a.key === 'table:tst_node').body,
    leaf = plan.actions.find((a) => a.key === 'table:tst_leaf').body;
  assert.equal(node.HasNotes, true);
  assert.equal(node.HasActivities, true);
  assert.equal(leaf.HasNotes, false);
  assert.equal(leaf.HasActivities, false);
  manifest.tables[0].notes = 'yes';
  assert.throws(() => compileManifest(manifest), /notes must be boolean/);
});

test('published XML syntax normalizes without hiding filter, value or ordering drift', () => {
  const expected = {
    savedqueryid: 'fa140000-0000-4000-8000-000000000002',
    fetchxml:
      '<fetch><entity name="tst_node"><attribute name="tst_nodeid"/><filter><condition attribute="tst_code" operator="eq" value="x &amp; y"/></filter></entity></fetch>',
  };
  const actual = {
    ...expected,
    fetchxml:
      '<fetch savedqueryid="fa140000-0000-4000-8000-000000000002">\n<entity name="tst_node"><attribute name="tst_nodeid" /><filter><condition value="x &amp; y" operator="eq" attribute="tst_code" /></filter></entity></fetch>',
  };
  assert.equal(compatible(actual, expected), true);
  assert.equal(compatible({ ...actual, fetchxml: actual.fetchxml.replace('x &amp; y', 'other') }, expected), false);
  assert.equal(
    compatible({ ...actual, fetchxml: actual.fetchxml.replace('operator="eq"', 'operator="ne"') }, expected),
    false,
  );
});
test('manifest rejects invalid references, unsupported keys, excessive indices and solution cycles', () => {
  const duplicate = fixtureManifest();
  duplicate.tables[0].columns.push({ ...duplicate.tables[0].columns[0] });
  assert.throws(() => validateManifest(duplicate), /duplicate column/);
  const missing = fixtureManifest();
  missing.tables[0].columns[1].choice = 'tst_missing';
  assert.throws(() => validateManifest(missing), /missing/);
  const key = fixtureManifest();
  key.tables[0].keys[0].columns = ['tst_notes'];
  assert.throws(() => validateManifest(key), /unsupported memo/);
  const large = fixtureManifest();
  large.tables[0].columns[0].maxLength = 1000;
  assert.throws(() => validateManifest(large), /900-byte/);
  const cycle = fixtureManifest();
  cycle.solutions[0].dependsOn = ['Future'];
  assert.throws(() => validateManifest(cycle), /dependency order/);
});

test('remote plan is read-only; apply creates, retains membership and has a mutation-free rerun', async (t) => {
  const { state, client } = await serverFixture(t),
    manifest = fixtureManifest();
  const before = await planManifest(manifest, { client });
  assert.equal(before.summary.drift, 0);
  assert.equal(
    before.summary.create,
    compileManifest(manifest).actions.length,
    'an empty organisation lacks every action',
  );
  assert.ok(state.requests.every((r) => r.method === 'GET'));
  const result = await applyManifest(manifest, { client, expectedOrganisationId: state.organisationId });
  assert.equal(result.state, 'Created');
  assert.equal(state.tables.size, 2);
  assert.equal(state.relationships.length, 2);
  assert.ok(state.components.some((c) => c.componenttype === 14));
  assert.ok(
    state.components.some((c) => c.componenttype === 60 && c.objectid === 'fa140000-0000-4000-8000-000000000001'),
  );
  const posts = state.requests.filter((r) => r.method === 'POST').length;
  const again = await applyManifest(manifest, { client, expectedOrganisationId: state.organisationId });
  const expectedActionKeys = compileManifest(manifest)
    .actions.map((action) => action.key)
    .sort();
  assert.ok(expectedActionKeys.length > 0);
  assert.deepEqual(again.entries.map((entry) => entry.key).sort(), expectedActionKeys);
  assert.ok(again.entries.every((e) => e.status === 'exists'));
  assert.equal(again.state, 'Unchanged', 'a run that wrote nothing does not report Created');
  assert.equal(state.requests.filter((r) => r.method === 'POST').length, posts);
  assert.equal((await checkKeys(manifest, client)).ready, false);
  state.tables.get('tst_node').Keys[0].EntityKeyIndexStatus = 'Active';
  assert.equal((await checkKeys(manifest, client)).ready, true);
  await publishManifest(manifest, client);
  assert.match(state.requests.at(-1).body.ParameterXml, /<entity>tst_node<\/entity>/);
  assert.ok(!state.requests.some((r) => r.route === 'PublishAllXml'));
});

test('solution scoping replaces IncludeAll membership without deleting metadata and retains explicit components', async (t) => {
  const { state, client } = await serverFixture(t),
    manifest = fixtureManifest();
  await applyManifest(manifest, { client, expectedOrganisationId: state.organisationId });
  const before = state.components.map((c) => ({ ...c }));
  for (const c of state.components.filter((c) => c.componenttype === 1)) c.rootcomponentbehavior = 0;
  const metadataCount = state.tables.size,
    requestCount = state.requests.length;
  const journal = [];
  const scoped = await scopeSolutionRoots(manifest, client, { onProgress: (e) => journal.push(e) });
  assert.equal(scoped.changedRoots, 2);
  assert.equal(state.tables.size, metadataCount);
  assert.ok(state.components.filter((c) => c.componenttype === 1).every((c) => c.rootcomponentbehavior === 1));
  for (const c of before)
    assert.ok(
      state.components.some(
        (a) =>
          a.objectid === c.objectid &&
          a.componenttype === c.componenttype &&
          a._solutionid_value === c._solutionid_value,
      ),
    );
  assert.ok(
    state.requests
      .slice(requestCount)
      .filter((r) => r.method === 'POST')
      .every((r) => ['RemoveSolutionComponent', 'AddSolutionComponent'].includes(r.route)),
  );
  assert.equal(journal[0].state, 'before-membership-replacement');
  const posts = state.requests.filter((r) => r.method === 'POST').length;
  assert.equal((await scopeSolutionRoots(manifest, client)).changedRoots, 0);
  assert.equal(state.requests.filter((r) => r.method === 'POST').length, posts);
});

// @test-kind security+contract: drift and organisation mismatch block writes before mutation
test('drift and organisation mismatch block writes before mutation', async (t) => {
  const { state, client } = await serverFixture(t),
    manifest = fixtureManifest();
  await applyManifest(manifest, { client, expectedOrganisationId: state.organisationId });
  const writes = state.requests.filter((r) => r.method === 'POST').length;
  state.tables.get('tst_node').Attributes.find((a) => a.SchemaName === 'tst_code').MaxLength = 100;
  await assert.rejects(
    applyManifest(manifest, { client, expectedOrganisationId: state.organisationId }),
    /incompatible component\(s\): column:tst_node\.tst_code \(MaxLength\)/,
  );
  await assert.rejects(applyManifest(manifest, { client, expectedOrganisationId: randomUUID() }), /differs/);
  assert.equal(state.requests.filter((r) => r.method === 'POST').length, writes);
});

// @test-kind contract: a remote plan names each declared property that differs, with declared and actual values
test('remote plan names the drifted property with its declared and actual values', async (t) => {
  const { state, client } = await serverFixture(t),
    manifest = fixtureManifest();
  await applyManifest(manifest, { client, expectedOrganisationId: state.organisationId });
  state.tables.get('tst_node').Attributes.find((a) => a.LogicalName === 'tst_name').MaxLength = 850;
  state.tables.get('tst_node').Attributes.find((a) => a.LogicalName === 'tst_code').MaxLength = 100;
  const plan = await planManifest(manifest, { client });
  const differences = Object.fromEntries(
    plan.actions.filter((a) => a.status === 'drift').map((a) => [a.key, a.differences]),
  );
  assert.deepEqual(differences, {
    'table:tst_node': [{ property: 'Attributes[tst_name].MaxLength', declared: 160, actual: 850 }],
    'column:tst_node.tst_code': [{ property: 'MaxLength', declared: 40, actual: 100 }],
  });
  assert.ok(plan.actions.filter((a) => a.status !== 'drift').every((a) => a.differences === undefined));
  await assert.rejects(
    scopeSolutionRoots(manifest, client),
    /before solution scoping: table:tst_node \(Attributes\[tst_name\]\.MaxLength\) differs/,
  );
});

// @test-kind contract: label-only drift is named in the plan, refused by apply, and changed only with updateLabels
test('apply --update-labels changes only the drifted display labels of declared tables and columns', async (t) => {
  const { state, client } = await serverFixture(t),
    manifest = fixtureManifest();
  await applyManifest(manifest, { client, expectedOrganisationId: state.organisationId });
  const node = state.tables.get('tst_node'),
    code = node.Attributes.find((a) => a.LogicalName === 'tst_code');
  const relabel = (labelled, name, text) => {
    labelled[name] = { LocalizedLabels: [{ Label: text, LanguageCode: 1033 }] };
  };
  relabel(node, 'DisplayName', 'Nodereference');
  relabel(node, 'DisplayCollectionName', 'Nodereferences');
  relabel(
    node.Attributes.find((a) => a.LogicalName === 'tst_name'),
    'DisplayName',
    'Old name',
  );
  relabel(code, 'DisplayName', 'Kode');
  const plan = await planManifest(manifest, { client });
  assert.equal(plan.summary.drift, 2);
  assert.equal(plan.summary.labelDrift, 2);
  const table = plan.actions.find((a) => a.key === 'table:tst_node');
  assert.equal(table.labelsOnly, true);
  assert.deepEqual(table.differences, [
    { property: 'DisplayName.LocalizedLabels[1033].Label', declared: 'Node', actual: 'Nodereference' },
    { property: 'DisplayCollectionName.LocalizedLabels[1033].Label', declared: 'Nodes', actual: 'Nodereferences' },
    { property: 'Attributes[tst_name].DisplayName.LocalizedLabels[1033].Label', declared: 'Name', actual: 'Old name' },
  ]);
  const writes = () => state.requests.filter((r) => r.method !== 'GET').length;
  const before = writes();
  await assert.rejects(
    applyManifest(manifest, { client, expectedOrganisationId: state.organisationId }),
    /2 incompatible component\(s\): table:tst_node \(DisplayName\.LocalizedLabels\[1033\]\.Label, .*Only display labels differ: rerun apply with --update-labels/,
  );
  assert.equal(writes(), before, 'without the option nothing is written');

  const journal = await applyManifest(manifest, {
    client,
    expectedOrganisationId: state.organisationId,
    updateLabels: true,
  });
  assert.equal(journal.state, 'Updated');
  assert.deepEqual(
    journal.entries.filter((e) => e.status === 'labels-updated').map((e) => e.key),
    ['table:tst_node', 'column:tst_node.tst_code'],
  );
  assert.equal(
    journal.entries.find((e) => e.key === 'column:tst_node.tst_code').labels[0].before,
    'Kode',
    'the journal keeps the replaced label',
  );
  assert.equal(state.tableUpdates.length, 1);
  assert.equal(code.MaxLength, 40);
  assert.equal(state.requests.filter((r) => r.method === 'POST' && r.route === 'EntityDefinitions').length, 2);
  assert.equal((await planManifest(manifest, { client })).summary.drift, 0);

  // A structural difference beside a label is never changed, with or without the option.
  relabel(node, 'DisplayName', 'Nodereference');
  node.Attributes.find((a) => a.LogicalName === 'tst_code').MaxLength = 41;
  const mixed = writes();
  const drifted = await planManifest(manifest, { client });
  assert.equal(drifted.summary.labelDrift, 1, 'only the table drifts in labels alone');
  await assert.rejects(
    applyManifest(manifest, { client, expectedOrganisationId: state.organisationId, updateLabels: true }),
    /1 incompatible component\(s\): column:tst_node\.tst_code \(MaxLength\)\. Inspect a remote plan/,
  );
  assert.equal(writes(), mixed);
});

// @test-kind observation: live developer environment, 2026-11-18: a table create stored the primary-name MaxLength as 850 for a declared 160; a follow-up attribute PUT set 160 and it persisted through publish
test('apply sets the declared primary-name length the platform overrode on create, and verifies it', async (t) => {
  const { state, client } = await serverFixture(t),
    manifest = fixtureManifest();
  state.platformPrimaryNameLength = 850;
  const journal = await applyManifest(manifest, { client, expectedOrganisationId: state.organisationId });
  assert.equal(journal.state, 'Created');
  for (const table of ['tst_node', 'tst_leaf']) {
    assert.equal(state.tables.get(table).Attributes.find((a) => a.LogicalName === 'tst_name').MaxLength, 160);
    assert.deepEqual(journal.entries.find((e) => e.key === `table:${table}`).primaryNameLength, {
      declared: 160,
      created: 850,
      updated: 160,
    });
  }
  const puts = state.requests.filter(
    (r) => r.method === 'PUT' && r.body['@odata.type'].endsWith('StringAttributeMetadata'),
  );
  assert.equal(puts.length, 2);
  assert.ok(puts.every((r) => r.solution === 'FictionalSchema' && r.body.MaxLength === 160));
  assert.equal((await planManifest(manifest, { client })).summary.drift, 0);
  state.platformPrimaryNameLength = null;
  const { state: kept, client: keptClient } = await serverFixture(t);
  const unchanged = await applyManifest(manifest, { client: keptClient, expectedOrganisationId: kept.organisationId });
  assert.ok(unchanged.entries.every((e) => e.primaryNameLength === undefined));
  assert.equal(
    kept.requests.filter((r) => r.method === 'PUT' && r.body['@odata.type'].endsWith('StringAttributeMetadata')).length,
    0,
  );
});

// @test-kind observation: live developer environment, 2026-11-18: the primary-name MaxLength stored on create differs from the declared one; apply must not continue when an update is not retained
test('apply stops and names the table when the platform does not retain the primary-name length', async (t) => {
  const { state, client } = await serverFixture(t);
  state.platformPrimaryNameLength = 850;
  state.retainPrimaryNameUpdate = false;
  await assert.rejects(
    applyManifest(fixtureManifest(), { client, expectedOrganisationId: state.organisationId }),
    /did not retain the declared primary-name maxLength 160 of tst_node \(it stores 850\)/,
  );
});

// @test-kind security+contract: solution scoping refuses metadata drift before replacing any membership
test('solution scoping refuses metadata drift before replacing any membership', async (t) => {
  const { state, client } = await serverFixture(t),
    manifest = fixtureManifest();
  await applyManifest(manifest, { client, expectedOrganisationId: state.organisationId });
  for (const c of state.components.filter((c) => c.componenttype === 1)) c.rootcomponentbehavior = 0;
  state.tables.get('tst_node').Attributes.find((a) => a.LogicalName === 'tst_code').MaxLength = 12;
  const posts = state.requests.filter((r) => r.method === 'POST').length;
  await assert.rejects(scopeSolutionRoots(manifest, client), /exist unchanged/);
  assert.equal(state.requests.filter((r) => r.method === 'POST').length, posts);
  assert.ok(state.components.filter((c) => c.componenttype === 1).every((c) => c.rootcomponentbehavior === 0));
});

test('remote plan lists the membership apply writes: root re-scoping and a missing primary-name membership', async (t) => {
  const { state, client } = await serverFixture(t),
    manifest = fixtureManifest();
  await applyManifest(manifest, { client, expectedOrganisationId: state.organisationId });
  const node = state.tables.get('tst_node'),
    primary = node.Attributes.find((a) => a.LogicalName === 'tst_name').MetadataId;
  state.components = state.components.filter((c) => c.objectid !== primary);
  state.components.find((c) => c.componenttype === 1 && c.objectid === node.MetadataId).rootcomponentbehavior = 0;
  const requests = state.requests.length;
  const plan = await planManifest(manifest, { client });
  assert.equal(plan.summary.rootScoping, 1);
  assert.equal(plan.summary.membershipAdd, 1);
  assert.equal(plan.summary.blocked, 0);
  assert.ok(state.requests.slice(requests).every((r) => r.method === 'GET'));
  const repaired = await applyManifest(manifest, { client, expectedOrganisationId: state.organisationId });
  assert.equal(repaired.state, 'Updated', 'membership repair without a create reports Updated');
});

test('a table declared includeAllSubcomponents keeps its whole root and apply converges to an empty plan', async (t) => {
  const { state, client } = await serverFixture(t),
    manifest = fixtureManifest();
  manifest.tables[1].includeAllSubcomponents = true;
  const rootOf = (table) =>
    state.components.find((c) => c.componenttype === 1 && c.objectid === state.tables.get(table).MetadataId);
  const created = await applyManifest(manifest, { client, expectedOrganisationId: state.organisationId });
  assert.equal(created.state, 'Created');
  assert.equal(rootOf('tst_leaf').rootcomponentbehavior, 0, 'the declared whole table keeps every subcomponent');
  assert.equal(rootOf('tst_node').rootcomponentbehavior, 1, 'other tables stay narrowed to their listed parts');
  const posts = () => state.requests.filter((r) => r.method === 'POST').length;
  for (let run = 0; run < 2; run++) {
    const plan = await planManifest(manifest, { client });
    assert.deepEqual(plan.membership, [], 'nothing pending after apply');
    const before = posts();
    const again = await applyManifest(manifest, { client, expectedOrganisationId: state.organisationId });
    assert.equal(again.state, 'Unchanged');
    assert.equal(posts(), before, 'a converged apply writes nothing');
  }
  // A narrowed whole table (for example by an older toolkit) is planned and applied as a widening, not a narrowing.
  rootOf('tst_leaf').rootcomponentbehavior = 1;
  const drifted = await planManifest(manifest, { client });
  assert.deepEqual(
    drifted.membership.map((e) => [e.operation, e.table, e.subcomponents]),
    [['membership:scope-root', 'tst_leaf', 'all']],
  );
  assert.equal(
    (await applyManifest(manifest, { client, expectedOrganisationId: state.organisationId })).state,
    'Updated',
  );
  assert.equal(rootOf('tst_leaf').rootcomponentbehavior, 0);
  assert.deepEqual((await planManifest(manifest, { client })).membership, []);
  manifest.tables[1].includeAllSubcomponents = 'yes';
  assert.throws(() => validateManifest(manifest), /includeAllSubcomponents must be boolean/);
});

test('remote plan blocks apply before its first write when a table root is undeclared', async (t) => {
  const { state, client } = await serverFixture(t),
    manifest = fixtureManifest(),
    stray = randomUUID();
  await applyManifest(manifest, { client, expectedOrganisationId: state.organisationId });
  state.components.push({
    solutioncomponentid: randomUUID(),
    objectid: stray,
    componenttype: 1,
    rootcomponentbehavior: 0,
    _solutionid_value: state.solutions[0].solutionid,
  });
  const plan = await planManifest(manifest, { client });
  assert.equal(plan.summary.blocked, 1);
  assert.deepEqual(
    plan.membership.filter((e) => e.operation === 'blocked').map((e) => e.objectId),
    [stray],
  );
  const requests = state.requests.length;
  await assert.rejects(
    applyManifest(manifest, { client, expectedOrganisationId: state.organisationId }),
    /Undeclared table root/,
  );
  assert.deepEqual(
    state.requests.slice(requests).filter((r) => r.method !== 'GET'),
    [],
  );
});

// @test-kind security+contract: mutations are not blindly retried and server responses do not leak through errors
test('mutations are not blindly retried and server responses do not leak through errors', async (t) => {
  const { state, client } = await serverFixture(t);
  state.failCreate = true;
  await assert.rejects(
    applyManifest(fixtureManifest(), { client }),
    (error) => error.status === 503 && !error.message.includes('private-server-response'),
  );
  assert.equal(state.requests.filter((r) => r.method === 'POST' && r.route === 'EntityDefinitions').length, 1);
  const failing = new DataverseClient({
    environmentUrl: 'https://fictional.crm.example',
    token: async () => 'invented-token',
    fetchImpl: async () => {
      throw new Error('invented-secret');
    },
  });
  await assert.rejects(
    failing.request('EntityDefinitions', { method: 'POST', body: {} }),
    (e) => e.code === 'UNKNOWN_COMMIT' && !e.message.includes('invented-secret'),
  );
});

test('acknowledged table and lookup creates reconcile transient metadata read absence without repeating writes', async (t) => {
  const { state, client } = await serverFixture(t),
    get = client.get.bind(client),
    missed = new Set();
  client.get = async (route) => {
    const newlyCreatedPrimary =
      route.includes("Attributes(LogicalName='tst_name')") &&
      state.tables.has(route.match(/LogicalName='([^']+)'/)?.[1]);
    const newlyCreatedLookup = route.includes("Attributes(LogicalName='tst_nodeid')") && state.relationships.length;
    if ((newlyCreatedPrimary || newlyCreatedLookup) && !missed.has(route)) {
      missed.add(route);
      const error = new Error('Invented metadata propagation delay');
      error.status = 404;
      throw error;
    }
    return get(route);
  };
  const journal = await applyManifest(fixtureManifest(), { client, expectedOrganisationId: state.organisationId });
  assert.equal(journal.state, 'Created');
  // Both new tables' primary name columns (plain and typed reads) and the one-to-many lookup (plain and typed reads)
  // were each read absent once.
  assert.deepEqual([...missed].sort(), [
    "EntityDefinitions(LogicalName='tst_leaf')/Attributes(LogicalName='tst_name')",
    "EntityDefinitions(LogicalName='tst_leaf')/Attributes(LogicalName='tst_name')/Microsoft.Dynamics.CRM.StringAttributeMetadata",
    "EntityDefinitions(LogicalName='tst_leaf')/Attributes(LogicalName='tst_nodeid')",
    "EntityDefinitions(LogicalName='tst_leaf')/Attributes(LogicalName='tst_nodeid')/Microsoft.Dynamics.CRM.LookupAttributeMetadata",
    "EntityDefinitions(LogicalName='tst_node')/Attributes(LogicalName='tst_name')",
    "EntityDefinitions(LogicalName='tst_node')/Attributes(LogicalName='tst_name')/Microsoft.Dynamics.CRM.StringAttributeMetadata",
  ]);
  assert.equal(state.requests.filter((r) => r.method === 'POST' && r.route === 'EntityDefinitions').length, 2);
  assert.equal(state.requests.filter((r) => r.method === 'POST' && r.route === 'RelationshipDefinitions').length, 2);
});

test('datetime manifest format is independent of behavior and participates in drift checks', () => {
  for (const behavior of ['UserLocal', 'TimeZoneIndependent'])
    for (const format of ['DateOnly', 'DateAndTime']) {
      const manifest = fixtureManifest(),
        column = manifest.tables[0].columns.find((c) => c.type === 'datetime');
      Object.assign(column, { behavior, format });
      const action = compileManifest(manifest).actions.find((a) => a.key === 'column:tst_node.tst_date');
      assert.equal(action.body.Format, format);
      assert.equal(action.body.DateTimeBehavior.Value, behavior);
      assert.equal(
        compatible({ ...action.body, Format: format === 'DateOnly' ? 'DateAndTime' : 'DateOnly' }, action.body),
        false,
      );
    }
  for (const [behavior, format] of [
    ['DateOnly', 'DateAndTime'],
    ['UserLocal', 'invalid'],
  ]) {
    const manifest = fixtureManifest();
    Object.assign(
      manifest.tables[0].columns.find((c) => c.type === 'datetime'),
      { behavior, format },
    );
    assert.throws(() => validateManifest(manifest), /format/);
  }
});

// @test-kind contract: schema mutations have a longer deadline while timeout outcomes still require reconciliation
test('schema mutations have a longer deadline while timeout outcomes still require reconciliation', async (t) => {
  // docs/dataverse-provisioning.md: reads allow 30 seconds, schema mutations 180 seconds.
  const defaults = new DataverseClient({ environmentUrl: 'https://fictional.crm.example', token: async () => '' });
  assert.deepEqual([defaults.timeoutMs, defaults.mutationTimeoutMs], [30_000, 180_000]);
  // Each request's deadline signal is recorded and expires as soon as the request is sent, so no real time passes.
  const deadlines = [];
  t.mock.method(AbortSignal, 'timeout', (ms) => {
    const controller = new AbortController();
    deadlines.push({ ms, expire: () => controller.abort(new DOMException('Invented deadline', 'TimeoutError')) });
    return controller.signal;
  });
  let requests = 0;
  const client = new DataverseClient({
    environmentUrl: 'https://fictional.crm.example',
    token: async () => 'invented-token',
    timeoutMs: 1_000,
    mutationTimeoutMs: 5_000,
    fetchImpl: (_url, { signal }) => {
      requests++;
      const settled = new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
      deadlines.at(-1).expire();
      return settled;
    },
  });
  await assert.rejects(client.get('EntityDefinitions'), (e) => e.code === 'READ_FAILED');
  await assert.rejects(
    client.request('EntityDefinitions', { method: 'POST', body: {} }),
    (e) => e.code === 'UNKNOWN_COMMIT',
  );
  assert.equal(requests, 2);
  assert.deepEqual(
    deadlines.map((deadline) => deadline.ms),
    [1_000, 5_000],
    'a read uses the read deadline and a mutation the longer mutation deadline',
  );
});

// @test-kind security+contract: API continuations cannot escape origin or path; connection output omits secrets
test('API continuations cannot escape origin or path; connection output omits secrets', () => {
  const client = new DataverseClient({
    environmentUrl: 'https://fictional.crm.example',
    token: async () => 'invented-token',
  });
  assert.throws(() => client.url('https://other.example/api/data/v9.2/tables'), /escaped/);
  assert.throws(() => client.url('../../sensitive'), /escaped/);
  assert.throws(() => environmentOrigin('https://user:password@fictional.crm.example'), /without credentials/);
  const publicValue = JSON.stringify(
    publicConnection({
      schemaVersion: 1,
      protectedSecret: 'never-print-this',
      clientSecret: 'never-print-this',
      credentialSource: 'dpapi',
    }),
  );
  assert.ok(!publicValue.includes('never-print-this'));
  assert.throws(() => parseRegistrationOutput('Error: tenant denied the request'), /reported an error/);
  const parsed = parseRegistrationOutput(
    'Tenant ID Application ID Client Secret Expiration\n11111111-1111-4111-8111-111111111111 22222222-2222-4222-8222-222222222222 invented-secret 1/1/2030 12:00 PM',
  );
  assert.equal(parsed.clientSecret, 'invented-secret');
});

// @test-kind contract: dataverse help lists its register, plan and export commands
test('dataverse help lists its register, plan and export commands', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url)), 'dataverse', '--help'],
    { encoding: 'utf8', windowsHide: true, timeout: CLI_HANG_GUARD_MS },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const command of ['register', 'plan', 'export'])
    assert.match(result.stdout, new RegExp(`^  ${command} +--`, 'm'));
});

// @test-kind contract: journal replacement survives a transient filesystem lock without repeating remote work
test('journal replacement survives a transient filesystem lock without repeating remote work', async () => {
  const directory = await tempDir('invented-dataverse-journal-'),
    file = path.join(directory, 'journal.json'),
    originalRename = fs.rename;
  let replacements = 0;
  try {
    await privateJson(file, { step: 1 }, true);
    fs.rename = async (...args) => {
      replacements++;
      if (replacements === 1) {
        const error = new Error('invented transient lock');
        error.code = 'EPERM';
        throw error;
      }
      return originalRename(...args);
    };
    await privateJson(file, { step: 2 });
    assert.equal(replacements, 2);
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).step, 2);
    assert.deepEqual(await fs.readdir(directory), ['journal.json']);
    await assert.rejects(privateJson(file, { step: 3 }, true), (e) => e.code === 'EEXIST');
  } finally {
    fs.rename = originalRename;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// @test-kind security+contract: credential import handles identity-bearing formats without treating secret ID as the value
test('credential import handles identity-bearing formats without treating secret ID as the value', () => {
  const clientId = '11111111-1111-4111-8111-111111111111',
    tenantId = '22222222-2222-4222-8222-222222222222',
    secretId = '33333333-3333-4333-8333-333333333333';
  const inputs = [
    JSON.stringify({ clientid: clientId, tenantid: tenantId, value: 'invented-value', secretid: secretId }),
    `clientid: ${clientId}\ntenantid: ${tenantId}\nvalue: invented-value\nsecretid: ${secretId}`,
    `clientid,tenantid,value,secretid\n${clientId},${tenantId},invented-value,${secretId}`,
    `${clientId}\n${tenantId}\ninvented-value\n${secretId}`,
  ];
  for (const input of inputs) {
    const parsed = parseCredentialFile(input);
    assert.equal(parsed.clientId, clientId);
    assert.equal(parsed.tenantId, tenantId);
    assert.equal(parsed.value, 'invented-value');
    assert.equal(parsed.secretId, secretId);
  }
  assert.deepEqual(parseCredentialFile('invented-value'), { value: 'invented-value' });
  assert.throws(
    () => parseCredentialFile(JSON.stringify({ clientId: 'invalid', value: 'invented-value' })),
    /invalid identity/,
  );
});

test('forms/views and later scalar columns preserve explicit solution ownership', () => {
  const manifest = fixtureManifest();
  manifest.solutions.push({
    uniqueName: 'FictionalExtension',
    friendlyName: 'Fictional extension',
    version: '1.0.0.0',
    dependsOn: ['FictionalSchema'],
  });
  manifest.tables[0].columns.push({
    name: 'tst_extra',
    label: 'Extra',
    type: 'string',
    maxLength: 40,
    solution: 'FictionalExtension',
  });
  manifest.forms = [
    {
      id: randomUUID(),
      name: 'Fixture form',
      table: 'tst_node',
      solution: 'FictionalExtension',
      formXml: '<form><tabs></tabs></form>',
    },
  ];
  manifest.views = [
    {
      id: randomUUID(),
      name: 'Fixture view',
      table: 'tst_node',
      solution: 'FictionalExtension',
      fetchXml: '<fetch><entity name="tst_node"></entity></fetch>',
      layoutXml: '<grid><row></row></grid>',
    },
  ];
  const plan = compileManifest(manifest);
  assert.equal(plan.actions.find((a) => a.key === 'column:tst_node.tst_extra').solution, 'FictionalExtension');
  assert.equal(plan.actions.find((a) => a.kind === 'form').body.type, 2);
  assert.equal(plan.actions.find((a) => a.kind === 'view').body.returnedtypecode, 'tst_node');
  assert.equal(plan.actions.at(-1).kind, 'view');
});

// @test-kind security+contract: response stream and JSON failures retain unknown mutation outcomes without leaking bodies
test('response stream and JSON failures retain unknown mutation outcomes without leaking bodies', async () => {
  for (const text of [
    async () => {
      throw new Error('invented-private-body');
    },
    async () => '<invented-private-body>',
  ]) {
    let requests = 0;
    const client = new DataverseClient({
      environmentUrl: 'https://fictional.crm.example',
      token: async () => 'invented-token',
      fetchImpl: async () => {
        requests++;
        return { ok: true, status: 200, headers: new Headers(), text };
      },
    });
    await assert.rejects(
      client.request('EntityDefinitions', { method: 'POST', body: {} }),
      (e) => e.code === 'UNKNOWN_COMMIT' && !e.message.includes('invented-private-body'),
    );
    await assert.rejects(
      client.get('EntityDefinitions'),
      (e) => e.code === 'READ_FAILED' && !e.message.includes('invented-private-body'),
    );
    assert.equal(requests, 2);
  }
});

// @test-kind contract: interrupted schema journals identify the pending action before its remote mutation
test('interrupted schema journals identify the pending action before its remote mutation', async (t) => {
  const { client, state } = await serverFixture(t);
  state.failCreate = true;
  const directory = await tempDir('invented-schema-journal-'),
    journalFile = path.join(directory, 'journal.json');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await assert.rejects(applyManifest(fixtureManifest(), { client, journalFile }), (e) => e.status === 503);
  const journal = JSON.parse(await fs.readFile(journalFile, 'utf8'));
  assert.equal(journal.state, 'Interrupted');
  assert.equal(journal.pending, 'table:tst_node');
  assert.ok(journal.entries.every((e) => e.key !== journal.pending));
});

test('remote schema planning honors optional empty manifest sections', async (t) => {
  const { client } = await serverFixture(t),
    manifest = fixtureManifest();
  for (const section of ['choices', 'tables', 'relationships', 'forms', 'views']) delete manifest[section];
  const plan = await planManifest(manifest, { client });
  assert.equal(plan.summary.create, 2);
  assert.equal(plan.actions.length, 2);
});

test('application authentication confines file-derived configuration to the fixed Entra origin', async () => {
  const connection = {
    tenantId: '11111111-1111-4111-8111-111111111111',
    clientId: '22222222-2222-4222-8222-222222222222',
    environmentUrl: 'https://fictional.crm.example',
    credentialSource: 'environment',
    secretEnvironmentVariable: 'PAQ_TEST_SYNTHETIC_OAUTH',
  };
  let calls = 0;
  const old = process.env.PAQ_TEST_SYNTHETIC_OAUTH;
  process.env.PAQ_TEST_SYNTHETIC_OAUTH = 'invented-secret';
  const fetchImpl = async (url, options) => {
    calls++;
    assert.equal(new URL(url).origin, 'https://login.microsoftonline.com');
    assert.equal(new URL(url).pathname, '/' + connection.tenantId + '/oauth2/v2.0/token');
    assert.equal(options.redirect, 'error');
    assert.equal(options.body.get('scope'), 'https://fictional.crm.example/.default');
    assert.equal(options.body.get('client_secret'), 'invented-secret');
    return { ok: true, json: async () => ({ access_token: 'invented-token', expires_in: 3600 }) };
  };
  try {
    for (const tenantId of ['../other', 'valid@malicious.example', 'invalid?path=redirect'])
      assert.throws(() => tokenProvider({ ...connection, tenantId }, { fetchImpl }), /GUID/);
    assert.throws(
      () => tokenProvider({ ...connection, environmentUrl: 'http://malicious.example' }, { fetchImpl }),
      /HTTPS/,
    );
    assert.equal(calls, 0);
    const token = tokenProvider(connection, { fetchImpl });
    assert.equal(await token(), 'invented-token');
    assert.equal(await token(), 'invented-token');
    assert.equal(calls, 1);
  } finally {
    if (old === undefined) delete process.env.PAQ_TEST_SYNTHETIC_OAUTH;
    else process.env.PAQ_TEST_SYNTHETIC_OAUTH = old;
  }
});

// @test-kind security+contract: unexpected OAuth transport and response failures never expose credential text
test('unexpected OAuth transport and response failures never expose credential text', async () => {
  const connection = {
    tenantId: '11111111-1111-4111-8111-111111111111',
    clientId: '22222222-2222-4222-8222-222222222222',
    environmentUrl: 'https://fictional.crm.example',
    credentialSource: 'environment',
    secretEnvironmentVariable: 'PAQ_TEST_SYNTHETIC_OAUTH',
  };
  const old = process.env.PAQ_TEST_SYNTHETIC_OAUTH;
  process.env.PAQ_TEST_SYNTHETIC_OAUTH = 'invented-secret';
  try {
    for (const fetchImpl of [
      async () => {
        throw new Error('invented-private-response');
      },
      async () => ({
        ok: true,
        json: async () => {
          throw new Error('invented-private-response');
        },
      }),
    ])
      await assert.rejects(
        tokenProvider(connection, { fetchImpl })(),
        (e) => e.message.includes('withheld') && !e.message.includes('invented-private-response'),
      );
  } finally {
    if (old === undefined) delete process.env.PAQ_TEST_SYNTHETIC_OAUTH;
    else process.env.PAQ_TEST_SYNTHETIC_OAUTH = old;
  }
});
