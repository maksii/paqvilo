// @test-kind contract: deploy.mjs plans exactly what --apply writes, keeps secure configuration secrets, and verify-live.mjs --cleanup deletes only its own run's rows, against an injected in-memory Dataverse client.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deployPlugins, installedReadiness, profileReadiness } from '../deploy.mjs';
import { cleanupRun, depthFault, foreignSynchronousSteps, qualificationExitCode } from '../verify-live.mjs';
import { id, assemblyDifferences, fieldDifferences } from '../registration.mjs';

// An in-memory Web API: rows keyed `set(id)`, lookups stored as `_name_value`, every write recorded.
function fakeDataverse() {
  const rows = new Map();
  const membership = new Set();
  const writes = [];
  const store = (key, body) => {
    const row = rows.get(key) ?? {};
    for (const [k, v] of Object.entries(body)) {
      if (k.endsWith('@odata.bind')) {
        const attr = k.slice(0, -11).toLowerCase().replace('eventhandler_plugintype', 'eventhandler');
        row[`_${attr}_value`] = /\(([^)]+)\)$/.exec(v)[1];
      } else row[k] = v;
    }
    rows.set(key, row);
  };
  // The guards' rules for a Delete Dataverse runs as SYSTEM under its root ObjectModel Delete. ChainNodeGuard: the node
  // carries a registered-step seal and the request tag names the node's own operation. EvidenceWriteGuard: the tag names
  // a maintenance intent of the event's run that binds the event, its operation and its payload hash.
  const guardRefusal = (key, tag) => {
    const row = rows.get(key);
    if (!row) return null;
    if (
      key.startsWith('pqvd_chainnodes(') &&
      (!/^ChainStep:/.test(row.pqvd_configstatus ?? '') || tag !== `CO-OP:${row._pqvd_operationid_value}`)
    )
      return 'chain node mutations require configured SDK identity.';
    if (!key.startsWith('pqvd_pluginevents(')) return null;
    const intent = rows.get(`pqvd_testoperations(${/^CO-OWNED-EVIDENCE-DELETE:(.+)$/.exec(tag ?? '')?.[1]})`);
    const original = rows.get(`pqvd_testoperations(${row._pqvd_operationid_value})`);
    const bound =
      intent?.pqvd_caseid === `ARCHIVE-OWNED-EVENT:${row.pqvd_plugineventid}` &&
      intent.pqvd_name === `SHA256:${row.pqvd_payloadhash}` &&
      intent.pqvd_pairkey === row._pqvd_operationid_value &&
      intent.pqvd_expectedmessage === 'Delete' &&
      intent.pqvd_roottable === 'pqvd_pluginevent' &&
      intent.pqvd_lane === 183270002 &&
      intent._pqvd_runid_value === original?._pqvd_runid_value;
    return bound ? null : 'server evidence is write restricted.';
  };
  const client = {
    async list(path) {
      if (path.startsWith('solutioncomponents?'))
        return [...membership].map((m) => ({ componenttype: Number(m.split('/')[0]), objectid: m.split('/')[1] }));
      const name = /name eq '([^']+)'/.exec(path)?.[1];
      if (path.startsWith('sdkmessages?')) return [{ sdkmessageid: id(`message/${name}`) }];
      if (path.startsWith('sdkmessagefilters?')) {
        const table = /primaryobjecttypecode eq '([^']+)'/.exec(path)[1];
        return table === 'unfiltered'
          ? []
          : [{ sdkmessagefilterid: id(`filter/${table}`), iscustomprocessingstepallowed: true }];
      }
      const [, set, field, value] = /^(\w+)\?.*\$filter=(\w+) eq (\S+)$/.exec(path);
      return [...rows]
        .filter(([key, row]) => key.startsWith(`${set}(`) && row[field] === value)
        .map(([, row]) => structuredClone(row));
    },
    async optional(path) {
      const row = rows.get(path.split('?')[0]);
      return row ? structuredClone(row) : null;
    },
    async get(path) {
      if (path.startsWith('EntityDefinitions'))
        return { Privileges: [{ PrivilegeType: 'Read', Name: 'prvReadpqvd_chainnode' }] };
      return this.optional(path);
    },
    async request(path, { method, body }) {
      writes.push({ method, path, body });
      if (path === 'AddSolutionComponent') membership.add(`${body.ComponentType}/${body.ComponentId}`);
      else if (method === 'POST') store(`${path}(${Object.values(body)[0]})`, body);
      else if (method === 'PATCH') store(path, body);
      else if (method === 'DELETE') {
        const [key, query = ''] = path.split('?');
        const refusal = guardRefusal(key, new URLSearchParams(query).get('tag'));
        if (refusal) throw Object.assign(new Error(`CO ${refusal}`), { status: 400 });
        if (!rows.delete(key)) throw Object.assign(new Error('missing'), { status: 404 });
        client.onDelete?.(key);
      }
      return { data: null };
    },
  };
  return { client, rows, writes, store };
}

const who = {
  applicationUserId: '11111111-1111-4111-a111-111111111111',
  businessUnitId: '22222222-2222-4222-a222-222222222222',
};
const registry = {
  schemaVersion: 1,
  solution: 'LabSolution',
  assemblies: [
    { name: 'Lab.Observation', project: 'Observation', types: ['Observer', 'EchoLabContext'] },
    { name: 'Lab.Guards', project: 'Guards', types: ['Guard'] },
  ],
  steps: [
    {
      key: 'Observer/lab_probe/Update/40/10/0',
      type: 'Observer',
      table: 'lab_probe',
      message: 'Update',
      stage: 40,
      order: 10,
      mode: 0,
      secureProfile: 'A',
      images: ['Before'],
      imageColumns: ['lab_name', 'lab_counter'],
    },
    {
      key: 'Guard/lab_probe/Create/20/5/0',
      type: 'Guard',
      table: 'lab_probe',
      message: 'Create',
      stage: 20,
      order: 5,
      mode: 0,
      disabled: true,
    },
    {
      key: 'Guard/unfiltered/Create/20/5/0',
      type: 'Guard',
      table: 'unfiltered',
      message: 'Create',
      stage: 20,
      order: 5,
      mode: 0,
    },
  ],
  readiness: {},
};
const build = (text) => {
  const bytes = Buffer.from(text);
  return {
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    identity: { available: true, version: '1.0.0.0', publicKeyToken: '70fb5a9b55e65c6c' },
  };
};
const builds = () =>
  new Map([
    ['Lab.Observation', build('observation v1')],
    ['Lab.Guards', build('guards v1')],
  ]);
const states = (rows) => Object.fromEntries(rows.map((row) => [row.key, row.status]));

test('an empty environment plans every component as create and apply writes exactly the plan', async () => {
  const env = fakeDataverse();
  const plan = await deployPlugins({ client: env.client, who, registry, builds: builds() });
  assert.equal(env.writes.length, 0, 'the plan writes nothing');
  assert.ok(plan.rows.every((row) => row.status === 'create'));
  assert.deepEqual(
    plan.unsupported.map((step) => step.key),
    ['Guard/unfiltered/Create/20/5/0'],
  );
  assert.deepEqual(
    plan.rows.filter((row) => row.secret).map((row) => [row.key, row.secret]),
    [['secure/Observer/lab_probe/Update/40/10/0', 'will set']],
  );
  const applied = await deployPlugins({ client: env.client, who, registry, builds: builds(), apply: true });
  assert.deepEqual(states(applied.rows), states(plan.rows), 'apply records the planned states');
  const assembly = env.rows.get(`pluginassemblies(${id('assembly/Lab.Guards')})`);
  assert.equal(assembly.publickeytoken, '70fb5a9b55e65c6c', 'the token comes from the build, never empty');
  const step = env.rows.get(`sdkmessageprocessingsteps(${id('step/Guard/lab_probe/Create/20/5/0')})`);
  assert.equal(step.statecode, 1, 'a disabled step is disabled after create');
  assert.doesNotMatch(JSON.stringify(applied), /syntheticSecret/, 'no secret value reaches the rows');
});

test('an installed registration that matches plans all unchanged and apply writes nothing', async () => {
  const env = fakeDataverse();
  await deployPlugins({ client: env.client, who, registry, builds: builds(), apply: true });
  const secure = `sdkmessageprocessingstepsecureconfigs(${id('secure/Observer/lab_probe/Update/40/10/0')})`;
  const secret = env.rows.get(secure).secureconfig;
  env.writes.length = 0;
  const plan = await deployPlugins({ client: env.client, who, registry, builds: builds() });
  assert.ok(
    plan.rows.every((row) => row.status === 'unchanged'),
    JSON.stringify(plan.rows.filter((row) => row.status !== 'unchanged')),
  );
  assert.deepEqual(
    plan.rows.filter((row) => row.secret).map((row) => row.secret),
    ['kept'],
  );
  const applied = await deployPlugins({ client: env.client, who, registry, builds: builds(), apply: true });
  assert.deepEqual(states(applied.rows), states(plan.rows));
  assert.deepEqual(env.writes, [], 'no re-upload, no secret rotation, no patch');
  assert.equal(env.rows.get(secure).secureconfig, secret, 'the existing secret is kept');
});

test('readiness comes from the installed steps, so a read-only plan of an installed lab reports it', async () => {
  const lab = {
    ...registry,
    assemblies: [
      { name: 'Lab.Guards', project: 'Guards', types: ['OperationIntentGuard', 'ChainA', 'ChainB', 'ChainC'] },
    ],
    steps: ['OperationIntentGuard', 'ChainA', 'ChainB', 'ChainC'].map((type) => ({
      key: `${type}/lab_probe/Update/40/1/0`,
      type,
      table: 'lab_probe',
      message: 'Update',
      stage: 40,
      order: 1,
      mode: 0,
    })),
  };
  const labBuilds = () => new Map([['Lab.Guards', build('guards v1')]]);
  const env = fakeDataverse();
  const none = { transactionalCapture: false, operationGuard: false, probeABC: false };
  const empty = await deployPlugins({ client: env.client, who, registry: lab, builds: labBuilds() });
  assert.deepEqual(installedReadiness(lab, empty.rows, false), none, 'nothing installed, nothing ready');
  const applied = await deployPlugins({ client: env.client, who, registry: lab, builds: labBuilds(), apply: true });
  const all = { transactionalCapture: true, operationGuard: true, probeABC: true };
  assert.deepEqual(installedReadiness(lab, applied.rows, true), all);
  const plan = await deployPlugins({ client: env.client, who, registry: lab, builds: labBuilds() });
  assert.deepEqual(installedReadiness(lab, plan.rows, false), all, 'a read-only plan of the installed lab');
  env.rows.delete(`sdkmessageprocessingsteps(${id('step/ChainB/lab_probe/Update/40/1/0')})`);
  const missing = await deployPlugins({ client: env.client, who, registry: lab, builds: labBuilds() });
  assert.deepEqual(installedReadiness(lab, missing.rows, false), {
    transactionalCapture: false,
    operationGuard: true,
    probeABC: false,
  });
});

test('profile readiness blocks P05 only until the owner team exists and never blocks the P09 depth cases', async () => {
  const env = fakeDataverse();
  const empty = await deployPlugins({ client: env.client, who, registry, builds: builds() });
  const before = profileReadiness(empty.rows, false);
  assert.ok(!before.supportedProfiles.includes('P05'));
  assert.ok(before.blockedProfiles.some((p) => p.startsWith('P05 ')));
  await deployPlugins({ client: env.client, who, registry, builds: builds(), apply: true });
  const plan = await deployPlugins({ client: env.client, who, registry, builds: builds() });
  const installed = profileReadiness(plan.rows, false);
  for (const profile of ['P05', 'P09']) {
    assert.ok(installed.supportedProfiles.includes(profile), profile);
    assert.ok(!installed.blockedProfiles.some((p) => p.startsWith(`${profile} `)), profile);
  }
  assert.deepEqual(
    installed.blockedProfiles.map((p) => p.split(' ')[0]),
    ['P08', 'P13', 'P14'],
  );
});

test('one rebuilt assembly is the one update and apply sends only its differing fields', async () => {
  const env = fakeDataverse();
  await deployPlugins({ client: env.client, who, registry, builds: builds(), apply: true });
  env.writes.length = 0;
  const rebuilt = builds();
  rebuilt.set('Lab.Guards', build('guards v2'));
  const plan = await deployPlugins({ client: env.client, who, registry, builds: rebuilt });
  assert.deepEqual(
    plan.rows.filter((row) => row.status !== 'unchanged'),
    [{ key: 'assembly/Lab.Guards', id: id('assembly/Lab.Guards'), status: 'update', changes: ['content hash'] }],
  );
  await deployPlugins({ client: env.client, who, registry, builds: rebuilt, apply: true });
  assert.deepEqual(env.writes, [
    {
      method: 'PATCH',
      path: `pluginassemblies(${id('assembly/Lab.Guards')})`,
      body: { content: Buffer.from('guards v2').toString('base64') },
    },
  ]);
});

test('missing steps and images plan as create and apply creates them without touching kept secrets', async () => {
  const env = fakeDataverse();
  await deployPlugins({ client: env.client, who, registry, builds: builds(), apply: true });
  const stepKey = 'step/Observer/lab_probe/Update/40/10/0';
  env.rows.delete(`sdkmessageprocessingsteps(${id(stepKey)})`);
  env.rows.delete(`sdkmessageprocessingstepimages(${id('image/Observer/lab_probe/Update/40/10/0/Before')})`);
  env.writes.length = 0;
  const plan = await deployPlugins({ client: env.client, who, registry, builds: builds() });
  assert.deepEqual(
    plan.rows.filter((row) => row.status !== 'unchanged').map((row) => [row.key, row.status]),
    [
      [stepKey, 'create'],
      ['image/Observer/lab_probe/Update/40/10/0/Before', 'create'],
    ],
  );
  await deployPlugins({ client: env.client, who, registry, builds: builds(), apply: true });
  assert.ok(env.writes.every((write) => !write.path.startsWith('sdkmessageprocessingstepsecureconfigs')));
  assert.deepEqual(
    env.writes.filter((write) => write.method === 'POST' && write.path !== 'AddSolutionComponent').map((w) => w.path),
    ['sdkmessageprocessingsteps', 'sdkmessageprocessingstepimages'],
  );
});

test('step configuration compares by member, ignores key order and names the differing members', () => {
  const installed = { configuration: JSON.stringify({ order: 5, schemaVersion: 1, allowOwnedEvidenceDeletion: true }) };
  assert.deepEqual(
    fieldDifferences(installed, {
      configuration: JSON.stringify({ schemaVersion: 1, order: 5, allowOwnedEvidenceDeletion: true }),
    }),
    [],
  );
  assert.deepEqual(
    fieldDifferences(installed, { configuration: JSON.stringify({ schemaVersion: 1, order: 5, chainStepIds: [] }) }),
    ['configuration.allowOwnedEvidenceDeletion', 'configuration.chainStepIds'],
  );
  assert.deepEqual(fieldDifferences({ defaultvalue: null }, { defaultvalue: '' }), [], 'Dataverse stores "" as null');
});

test('installed assembly comparison names content hash, version and public key token differences', () => {
  const local = build('same');
  const installed = { content: local.bytes.toString('base64'), version: '1.0.0.0', publickeytoken: '70fb5a9b55e65c6c' };
  assert.deepEqual(assemblyDifferences(local, installed), []);
  assert.deepEqual(assemblyDifferences(local, { ...installed, publickeytoken: '', version: '2.0.0.0' }), [
    'version',
    'publickeytoken',
  ]);
  assert.deepEqual(assemblyDifferences(build('other'), installed), ['content hash']);
  const unreflected = { ...local, identity: { available: false } };
  assert.deepEqual(assemblyDifferences(unreflected, { ...installed, version: '9.9.9.9' }), []);
});

const run = '33333333-3333-4333-a333-333333333333';
const seal = '55555555-5555-4555-a555-555555555555';
function qualificationRun(name = 'Live SDK qualification 0b1c') {
  const env = fakeDataverse();
  env.store(`pqvd_testruns(${run})`, {
    pqvd_name: name,
    pqvd_suiteversion: 'plugin-v1',
    pqvd_environment: 'Dataverse.SDK.ApplicationIdentity',
  });
  const op = (n) => `44444444-4444-4444-a444-00000000000${n}`;
  for (const n of [1, 2])
    env.store(`pqvd_testoperations(${op(n)})`, { pqvd_testoperationid: op(n), _pqvd_runid_value: run });
  env.store('pqvd_crudprobes(p1)', {
    pqvd_crudprobeid: 'p1',
    _pqvd_runid_value: run,
    _pqvd_activeoperationid_value: op(2),
  });
  // n1 is sealed by its chain step; n2 is a DepthChain node, which does not copy the seal.
  env.store('pqvd_chainnodes(n1)', {
    pqvd_chainnodeid: 'n1',
    _pqvd_operationid_value: op(1),
    pqvd_configstatus: `ChainStep:${seal}`,
  });
  env.store('pqvd_chainnodes(n2)', {
    pqvd_chainnodeid: 'n2',
    _pqvd_operationid_value: op(1),
    _pqvd_parentnodeid_value: 'n1',
  });
  env.store('pqvd_pluginevents(e1)', {
    pqvd_plugineventid: 'e1',
    _pqvd_operationid_value: op(1),
    pqvd_payloadhash: 'a'.repeat(64),
  });
  env.store('pqvd_testruns(other)', { pqvd_name: 'Other run' });
  env.store('pqvd_pluginevents(e9)', { pqvd_plugineventid: 'e9', _pqvd_operationid_value: 'unrelated' });
  return { env, op };
}

test('verify-live cleanup plans the rows of one run without writing and deletes exactly them children first', async () => {
  const { env, op } = qualificationRun();
  const plan = await cleanupRun(env.client, run);
  assert.deepEqual(plan, {
    runId: run,
    state: 'CleanupPlan',
    seal: { chainNodes: 1 },
    create: { maintenanceIntents: 1 },
    delete: { chainNodes: 2, crudProbes: 1, pluginEvents: 1, testOperations: 2, testRuns: 1 },
  });
  assert.equal(env.writes.length, 0);
  const tag = `?tag=${encodeURIComponent(`CO-OP:${op(1)}`)}`;
  // Deleting the probe makes the observer record one more event for its active operation.
  env.client.onDelete = (path) => {
    if (path === 'pqvd_crudprobes(p1)')
      env.store('pqvd_pluginevents(e2)', {
        pqvd_plugineventid: 'e2',
        _pqvd_operationid_value: op(2),
        pqvd_payloadhash: 'b'.repeat(64),
      });
  };
  const result = await cleanupRun(env.client, run, { apply: true });
  assert.equal(result.deleted.pluginEvents, 2);
  assert.equal(result.deleted.testOperations, 4, 'the two operations and the two maintenance intents');
  assert.deepEqual(result.sealed, { chainNodes: 1 });
  assert.deepEqual(result.created, { maintenanceIntents: 2 });
  assert.deepEqual(env.writes[0].body, { pqvd_configstatus: `ChainStep:${seal}` });
  const intents = env.writes.filter((write) => write.method === 'POST').map((write) => write.body);
  assert.deepEqual(
    intents.map((intent) => [intent.pqvd_caseid, intent.pqvd_name, intent.pqvd_pairkey]),
    [
      ['ARCHIVE-OWNED-EVENT:e1', `SHA256:${'a'.repeat(64)}`, op(1)],
      ['ARCHIVE-OWNED-EVENT:e2', `SHA256:${'b'.repeat(64)}`, op(2)],
    ],
  );
  const evidenceTag = (n) =>
    `?tag=${encodeURIComponent(`CO-OWNED-EVIDENCE-DELETE:${intents[n].pqvd_testoperationid}`)}`;
  assert.deepEqual(
    env.writes.map((write) => `${write.method} ${write.path}`),
    [
      'PATCH pqvd_chainnodes(n2)',
      `DELETE pqvd_chainnodes(n2)${tag}`,
      `DELETE pqvd_chainnodes(n1)${tag}`,
      'DELETE pqvd_crudprobes(p1)',
      'POST pqvd_testoperations',
      `DELETE pqvd_pluginevents(e1)${evidenceTag(0)}`,
      'POST pqvd_testoperations',
      `DELETE pqvd_pluginevents(e2)${evidenceTag(1)}`,
      `DELETE pqvd_testoperations(${op(1)})`,
      `DELETE pqvd_testoperations(${op(2)})`,
      `DELETE pqvd_testoperations(${intents[0].pqvd_testoperationid})`,
      `DELETE pqvd_testoperations(${intents[1].pqvd_testoperationid})`,
      `DELETE pqvd_testruns(${run})`,
    ],
  );
  assert.deepEqual(
    [...env.rows.keys()].sort((a, b) => a.localeCompare(b)),
    ['pqvd_pluginevents(e9)', 'pqvd_testruns(other)'],
  );
});

test('verify-live cleanup refuses a run it did not create or one other rows depend on', async () => {
  const foreign = qualificationRun('Portal campaign run');
  await assert.rejects(cleanupRun(foreign.env.client, run, { apply: true }), /was not created by verify-live\.mjs/);
  assert.equal(foreign.env.writes.length, 0);
  const referenced = qualificationRun();
  referenced.env.store('pqvd_testresults(r1)', { pqvd_testresultid: 'r1', _pqvd_runid_value: run });
  await assert.rejects(cleanupRun(referenced.env.client, run, { apply: true }), /does not create; it is left alone/);
  assert.equal(referenced.env.writes.length, 0);
  await assert.rejects(cleanupRun(fakeDataverse().client, run), /was not found/);
});

test('verify-live cleanup writes nothing when a chain node has no sealed ancestor the chain guard accepts', async () => {
  const { env } = qualificationRun();
  env.store('pqvd_chainnodes(n1)', { pqvd_configstatus: null });
  await assert.rejects(
    cleanupRun(env.client, run, { apply: true }),
    /no sealed chain-step ancestor.*nothing was deleted/,
  );
  assert.equal(env.writes.length, 0);
});

test('verify-live exits 2 when any case failed and 0 only when every case passed', () => {
  assert.equal(qualificationExitCode([{ status: 'Passed' }, { status: 'Passed' }]), 0);
  assert.equal(qualificationExitCode([{ status: 'Passed' }, { status: 'Failed' }]), 2);
  assert.equal(qualificationExitCode([{ status: 'MissingBackendEvidence' }]), 2);
});

test('a depth case aborted by the suite budget is reported as such, not as a depth result', async () => {
  const rows = [
    { plugintypeid: { assemblyname: 'Lab.Guards' } },
    { plugintypeid: { assemblyname: 'Microsoft.Crm.ObjectModel' } },
    { plugintypeid: { assemblyname: 'Fictional.Recorder' } },
    { plugintypeid: { assemblyname: 'Fictional.Recorder' } },
  ];
  const foreign = await foreignSynchronousSteps({ list: async () => rows }, ['Lab.Guards']);
  assert.deepEqual(foreign, [{ assembly: 'Fictional.Recorder', steps: 2 }]);
  const budget = depthFault({ message: 'CO suite wall-clock budget exceeded.' }, true, foreign);
  assert.equal(budget.status, 'Failed');
  assert.equal(budget.outcome, 'SuiteBudgetExceeded');
  assert.match(budget.cause, /Fictional.Recorder/);
  const depth = depthFault({ message: 'This workflow job was canceled because ... an infinite loop.' }, true, []);
  assert.deepEqual(depth, { status: 'Passed', outcome: 'PlatformFault' });
  assert.equal(depthFault({ message: 'infinite loop' }, false, []).status, 'Failed', 'a fault without rollback fails');
});
