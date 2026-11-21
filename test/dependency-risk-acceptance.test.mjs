// @test-kind security: temporary user-approved risk acceptance fails closed on time, byte, advisory and development graph drift
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { auditedProjects, auditAllProjects, auditProject } from '../scripts/audit-dependencies.mjs';
import {
  matchesApprovedRiskInputs,
  readAuditInputs,
  temporaryRiskAcceptance,
  validateAuditReport,
} from '../scripts/dependency-risk-acceptance.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixtures = new URL('./fixtures/dependency-audit-risk/', import.meta.url);
const index = JSON.parse(fs.readFileSync(new URL('index.json', fixtures), 'utf8'));
// An applicable acceptance: the approved 2026-11-17 entry, pinned to trimmed copies of the approved manifests and locks
// under inputs/ (only the lock entries its findings name). The repository file itself holds no acceptance.
const policy = JSON.parse(fs.readFileSync(new URL('policy.json', fixtures), 'utf8'));
const inputDirectory = (project) => new URL(`inputs/${index.projects[project].file.replace(/\.json$/, '')}/`, fixtures);
const acceptedProjects = [
  '.',
  'examples/project/components/pcf-dataset-control',
  'examples/project/components/pcf-field-control',
  'examples/project/components/pcf-field-types',
  'examples/project/components/pcf-web-api-control',
];
const expiry = Date.parse('2026-11-24T00:00:00Z');
const beforeExpiry = () => expiry - 1;
const rawReport = (project = '.') => fs.readFileSync(new URL(index.projects[project].file, fixtures));
const report = (project = '.') => JSON.parse(rawReport(project));
const evidence = (project = '.') => {
  const lock = fs.readFileSync(new URL('lock.json', inputDirectory(project)));
  return {
    manifest: fs.readFileSync(new URL('package.json', inputDirectory(project))),
    lock,
    auditedLock: Buffer.from(lock),
  };
};
const accept = (project = '.', value = report(project), inputs = evidence(project), now = beforeExpiry, status = 1) =>
  temporaryRiskAcceptance(project, value, status, inputs, { now, policy });
const mutateJson = (bytes, change) => {
  const value = JSON.parse(bytes);
  change(value);
  return Buffer.from(JSON.stringify(value));
};

function fixtureRoot(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-audit-policy-'));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  for (const project of auditedProjects) {
    const cwd = path.join(directory, project);
    fs.mkdirSync(cwd, { recursive: true });
    const accepted = acceptedProjects.includes(project);
    const source = path.join(root, project);
    const name = project === '.' ? 'paqvilo-lock.json' : 'package-lock.json';
    fs.copyFileSync(
      accepted ? new URL('package.json', inputDirectory(project)) : path.join(source, 'package.json'),
      path.join(cwd, 'package.json'),
    );
    const lock = accepted ? new URL('lock.json', inputDirectory(project)) : path.join(source, name);
    fs.copyFileSync(lock, path.join(cwd, name));
    if (project === '.') fs.copyFileSync(lock, path.join(cwd, 'package-lock.json'));
  }
  return directory;
}

function auditHarness(directory, override = () => undefined, now = beforeExpiry) {
  const calls = [];
  const output = [];
  const options = {
    rootDirectory: directory,
    now,
    riskPolicy: policy,
    log: (line) => output.push(line),
    error: (line) => output.push(line),
    runAudit: (executable, args, settings) => {
      const relative = path.relative(directory, settings.cwd).replaceAll('\\', '/') || '.';
      calls.push({ project: relative, executable, args, settings });
      return override(relative) ?? { status: index.projects[relative].status, stdout: rawReport(relative), stderr: '' };
    },
  };
  return { calls, output, options };
}

test('the raw independently captured npm fixtures cover all ten existing contexts without altered severities', () => {
  assert.equal(auditedProjects.length, 10);
  assert.deepEqual(new Set(Object.keys(index.projects)), new Set(auditedProjects));
  let findings = 0;
  for (const project of auditedProjects) {
    const raw = rawReport(project);
    assert.equal(createHash('sha256').update(raw).digest('hex'), index.projects[project].rawAuditSha256);
    const value = JSON.parse(raw);
    validateAuditReport(value, index.projects[project].status);
    findings += value.metadata.vulnerabilities.high;
    assert.equal(
      value.metadata.vulnerabilities.high,
      acceptedProjects.includes(project) ? (project === '.' ? 12 : 17) : 0,
    );
  }
  assert.equal(findings, 80);
});

test('only the five exact captured development graphs receive the temporary risk acceptance', () => {
  for (const project of acceptedProjects) {
    const result = accept(project);
    assert.equal(result.accepted, true, `${project}: ${result.reason}`);
    assert.deepEqual(result.names, Object.keys(report(project).vulnerabilities));
    assert.match(result.message, /TEMPORARY RISK ACCEPTANCE \(not fixed\)/);
    assert.match(result.message, /user-approved 2026-11-17; expires 2026-11-24T00:00:00Z/);
  }
  for (const project of ['mirage', 'examples/other', '../', 'toString'])
    assert.equal(
      temporaryRiskAcceptance(project, report(), 1, evidence(), { now: beforeExpiry, policy }).accepted,
      false,
    );
});

test('expiry uses the UTC boundary and rejects missing, invalid or pre-capture clock evidence', () => {
  assert.equal(accept('.', report(), evidence(), () => expiry - 1).accepted, true);
  for (const instant of [expiry, expiry + 1, undefined, null, NaN, Infinity, -Infinity, 0, String(expiry - 1)])
    assert.equal(accept('.', report(), evidence(), () => instant).accepted, false, String(instant));
  assert.equal(
    accept('.', report(), evidence(), () => {
      throw new Error('clock unavailable');
    }).accepted,
    false,
  );
});

test('even whitespace-only manifest/lock drift and a different actual audited root lock reject acceptance', () => {
  for (const project of acceptedProjects) {
    for (const key of ['manifest', 'lock', 'auditedLock']) {
      const inputs = evidence(project);
      inputs[key] = Buffer.concat([inputs[key], Buffer.from('\n')]);
      assert.equal(accept(project, report(project), inputs).accepted, false, `${project}: ${key}`);
    }
    for (const inputs of [undefined, {}, { ...evidence(project), lock: undefined }])
      assert.equal(
        temporaryRiskAcceptance(project, report(project), 1, inputs, { now: beforeExpiry, policy }).accepted,
        false,
      );
  }
});

test('standalone raw report changes cannot be accepted by matching a package or advisory name', () => {
  const changes = [
    (r) =>
      r.vulnerabilities.picomatch.via.push({
        ...r.vulnerabilities.picomatch.via[0],
        source: 999,
        url: 'https://github.com/advisories/GHSA-other',
      }),
    (r) => {
      r.vulnerabilities.picomatch.via[0].source++;
    },
    (r) => {
      r.vulnerabilities.picomatch.via[0].range = '<=4.0.8';
    },
    (r) => {
      r.vulnerabilities.picomatch.via[0].title += ' changed';
    },
    (r) => {
      r.vulnerabilities.picomatch.via[0].cvss.score = 7.6;
    },
    (r) => {
      r.vulnerabilities.picomatch.via[0].cwe.push('CWE-20');
    },
    (r) => {
      r.vulnerabilities.picomatch.via[0].dependency = 'other';
    },
    (r) => {
      r.vulnerabilities.picomatch.via[0].unknown = true;
    },
    (r) => {
      r.vulnerabilities.picomatch.effects.pop();
    },
    (r) => {
      r.vulnerabilities.picomatch.nodes.push('node_modules/new-copy/node_modules/picomatch');
    },
    (r) => {
      r.vulnerabilities.picomatch.nodes.pop();
    },
    (r) => {
      r.vulnerabilities.picomatch.isDirect = true;
    },
    (r) => {
      r.vulnerabilities.picomatch.range = '<=4.0.7';
    },
    (r) => {
      r.vulnerabilities.picomatch.fixAvailable = false;
    },
    (r) => {
      r.vulnerabilities.picomatch.extraContext = 'new';
    },
    (r) => {
      r.metadata.dependencies.prod++;
    },
    (r) => {
      r.vulnerabilities.extra = structuredClone(r.vulnerabilities.picomatch);
      r.metadata.vulnerabilities.high++;
      r.metadata.vulnerabilities.total++;
    },
    (r) => {
      delete r.vulnerabilities.tinyglobby;
      r.metadata.vulnerabilities.high--;
      r.metadata.vulnerabilities.total--;
    },
    (r) => {
      r.vulnerabilities.tinyglobby.via = ['vite'];
    },
  ];
  for (const [ordinal, change] of changes.entries()) {
    const value = report();
    change(value);
    assert.equal(accept('.', value).accepted, false, `raw report mutation ${ordinal}`);
  }
});

test('node versions, dev flags, production edges and additional lock locations cannot extend the approved graph', () => {
  const changes = [
    (lock) => {
      lock.packages['node_modules/picomatch'].version = '4.0.8';
    },
    (lock) => {
      lock.packages['node_modules/picomatch'].dev = false;
    },
    (lock) => {
      delete lock.packages['node_modules/picomatch'].dev;
    },
    (lock) => {
      lock.packages['node_modules/vite'].dependencies.picomatch = '^5';
    },
    (lock) => {
      lock.packages['node_modules/extra/node_modules/picomatch'] = structuredClone(
        lock.packages['node_modules/picomatch'],
      );
    },
  ];
  for (const change of changes) {
    const inputs = evidence();
    inputs.lock = mutateJson(inputs.lock, change);
    inputs.auditedLock = Buffer.from(inputs.lock);
    assert.equal(accept('.', report(), inputs).accepted, false);
  }
  const inputs = evidence();
  inputs.manifest = mutateJson(inputs.manifest, (manifest) => {
    manifest.dependencies.picomatch = '4.0.7';
  });
  assert.equal(accept('.', report(), inputs).accepted, false);
});

test('missing/invalid audit output, counts or status cannot become a successful policy decision', () => {
  const changes = [
    () => null,
    () => ({}),
    (r) => ({ ...r, error: { summary: 'registry unavailable' } }),
    (r) => ({ ...r, auditReportVersion: 1 }),
    (r) => ({ ...r, vulnerabilities: undefined }),
    (r) => ({ ...r, metadata: undefined }),
    (r) => {
      delete r.metadata.dependencies;
      return r;
    },
    (r) => {
      r.metadata.vulnerabilities.total = 0;
      return r;
    },
    (r) => {
      r.metadata.vulnerabilities.high = -1;
      return r;
    },
    (r) => {
      r.vulnerabilities = {};
      return r;
    },
  ];
  for (const change of changes) assert.equal(accept('.', change(report())).accepted, false);
  for (const status of [undefined, null, 0, 2, '1'])
    assert.equal(
      temporaryRiskAcceptance('.', report(), status, evidence(), { now: beforeExpiry, policy }).accepted,
      false,
    );
});

test('the runner still performs all ten ordinary audits and reports risk acceptance without changing counts', (t) => {
  const directory = fixtureRoot(t);
  const harness = auditHarness(directory);
  assert.equal(auditAllProjects('fixture-npm-cli.js', harness.options), false);
  assert.deepEqual(
    harness.calls.map((call) => call.project),
    auditedProjects,
  );
  for (const call of harness.calls) {
    assert.equal(call.executable, process.execPath);
    assert.deepEqual(call.args, ['fixture-npm-cli.js', 'audit', '--json']);
    assert.equal(call.settings.timeout, 60_000);
  }
  assert.equal(harness.output.filter((line) => line.includes('TEMPORARY RISK ACCEPTANCE (not fixed)')).length, 5);
  assert.equal(harness.output.filter((line) => line.includes('"high":17')).length, 4);
  assert.ok(harness.output.some((line) => line.startsWith('.: {') && line.includes('"high":12')));
});

test('expiry, unavailable data and unexpected advisories fail while the remaining contexts still audit', async (t) => {
  for (const scenario of [
    'expiry',
    'invalid JSON',
    'unavailable',
    'wrong status',
    'interrupted',
    'unapproved context',
    'unexpected advisory',
  ])
    await t.test(scenario, (caseTest) => {
      const directory = fixtureRoot(caseTest);
      const harness = auditHarness(
        directory,
        (project) => {
          if (scenario === 'unapproved context' && project === 'mirage')
            return { status: 1, stdout: rawReport(), stderr: '' };
          if (project !== '.') return undefined;
          if (scenario === 'invalid JSON') return { status: 1, stdout: 'not JSON', stderr: '' };
          if (scenario === 'unavailable')
            return { status: 1, stdout: JSON.stringify({ error: { summary: 'offline' } }), stderr: '' };
          if (scenario === 'wrong status') return { status: 0, stdout: rawReport(), stderr: '' };
          if (scenario === 'interrupted') return { status: null, signal: 'SIGTERM', stdout: rawReport(), stderr: '' };
          if (scenario === 'unexpected advisory') {
            const value = report('mirage');
            value.vulnerabilities = { picomatch: report().vulnerabilities.picomatch };
            value.metadata.vulnerabilities.high = 1;
            value.metadata.vulnerabilities.total = 1;
            return { status: 1, stdout: JSON.stringify(value), stderr: '' };
          }
          return undefined;
        },
        scenario === 'expiry' ? () => expiry : beforeExpiry,
      );
      assert.equal(auditAllProjects('fixture-npm-cli.js', harness.options), true);
      assert.equal(harness.calls.length, 10);
    });
});

test('the actual generated root lock is checked before audit and input changes during audit fail closed', async (t) => {
  await t.test('generated root mismatch', (caseTest) => {
    const directory = fixtureRoot(caseTest);
    fs.appendFileSync(path.join(directory, 'package-lock.json'), '\n');
    assert.throws(() => readAuditInputs(directory, '.'), /differs from canonical/);
    const harness = auditHarness(directory);
    assert.equal(auditAllProjects('fixture-npm-cli.js', harness.options), true);
    assert.equal(harness.calls.length, 9);
    assert.ok(harness.calls.every((call) => call.project !== '.'));
  });
  await t.test('manifest changes during audit', (caseTest) => {
    const directory = fixtureRoot(caseTest);
    const harness = auditHarness(directory, (project) => {
      if (project === '.') fs.appendFileSync(path.join(directory, 'package.json'), '\n');
    });
    assert.throws(() => auditProject('.', 'fixture-npm-cli.js', harness.options), /inputs changed during audit/);
  });
  await t.test('missing actual audited lock', (caseTest) => {
    const directory = fixtureRoot(caseTest);
    fs.unlinkSync(path.join(directory, 'package-lock.json'));
    assert.throws(() => readAuditInputs(directory, '.'), /ENOENT/);
  });
});

test('an unchanged approved graph cannot silently become clean through zero advisory metadata', async (t) => {
  for (const [label, now] of [
    ['before expiry', beforeExpiry],
    ['at expiry', () => expiry],
  ])
    await t.test(label, (caseTest) => {
      const directory = fixtureRoot(caseTest);
      const zero = report();
      zero.vulnerabilities = {};
      zero.metadata.vulnerabilities = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
      validateAuditReport(zero, 0);
      const harness = auditHarness(
        directory,
        (project) => {
          if (project === '.') return { status: 0, stdout: JSON.stringify(zero), stderr: '' };
        },
        now,
      );
      assert.equal(auditAllProjects('fixture-npm-cli.js', harness.options), true);
      assert.equal(harness.calls.length, 10, 'a changed report does not suppress the other audit contexts');
      assert.ok(harness.output.some((line) => line.includes('requires re-evaluation')));
    });
});

test('changed dependency inputs with a valid zero report do not require the temporary exception', (t) => {
  const directory = fixtureRoot(t);
  const lockPath = path.join(directory, 'paqvilo-lock.json');
  const changedLock = mutateJson(fs.readFileSync(lockPath), (lock) => {
    lock.packages['node_modules/picomatch'].version = '4.0.8';
  });
  fs.writeFileSync(lockPath, changedLock);
  fs.writeFileSync(path.join(directory, 'package-lock.json'), changedLock);
  const zero = report();
  zero.vulnerabilities = {};
  zero.metadata.vulnerabilities = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  const harness = auditHarness(
    directory,
    () => ({ status: 0, stdout: JSON.stringify(zero), stderr: '' }),
    () => expiry,
  );
  assert.equal(auditProject('.', 'fixture-npm-cli.js', harness.options), false);
  assert.equal(harness.calls.length, 1);
  assert.equal(
    harness.output.some((line) => line.includes('RISK ACCEPTANCE')),
    false,
  );
});

test('the repository file holds no acceptance: {} accepts nothing and needs no re-evaluation', (t) => {
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'scripts/dependency-risk-acceptance.json'), 'utf8')), {});
  for (const project of acceptedProjects) {
    const live = temporaryRiskAcceptance(project, report(project), 1, evidence(project), { now: beforeExpiry });
    assert.deepEqual(live, { accepted: false, reason: 'no temporary risk acceptance is in force' });
    assert.equal(matchesApprovedRiskInputs(project, evidence(project)), false);
  }
  const directory = fixtureRoot(t);
  const harness = auditHarness(directory);
  harness.options.riskPolicy = undefined;
  assert.equal(
    auditAllProjects('fixture-npm-cli.js', harness.options),
    true,
    'every finding fails without an acceptance',
  );
  assert.equal(harness.output.filter((line) => line.includes('TEMPORARY RISK ACCEPTANCE')).length, 0);
  assert.equal(harness.output.filter((line) => line.includes('no temporary risk acceptance is in force')).length, 5);
  const zero = report();
  zero.vulnerabilities = {};
  zero.metadata.vulnerabilities = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  const clean = auditHarness(directory, () => ({ status: 0, stdout: JSON.stringify(zero), stderr: '' }));
  clean.options.riskPolicy = undefined;
  assert.equal(auditAllProjects('fixture-npm-cli.js', clean.options), false);
  assert.equal(
    clean.output.some((line) => /RISK ACCEPTANCE|re-evaluation/.test(line)),
    false,
  );
});

test('a malformed or half-filled acceptance file fails closed instead of meaning no acceptance', (t) => {
  const { projects, ...withoutProjects } = policy;
  const firstProject = Object.keys(projects)[0];
  const halfPinned = structuredClone(policy);
  delete halfPinned.projects[firstProject].lockSha256;
  const invalid = [
    null,
    [],
    'none',
    { advisory: policy.advisory },
    withoutProjects,
    { ...policy, projects: {} },
    { ...policy, expiresAt: 'soon' },
    { ...policy, evidenceCapturedAt: undefined },
    { ...policy, advisory: '' },
    { ...policy, approval: undefined },
    { ...policy, approval: '' },
    halfPinned,
  ];
  const directory = fixtureRoot(t);
  const zero = report();
  zero.vulnerabilities = {};
  zero.metadata.vulnerabilities = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  for (const [ordinal, candidate] of invalid.entries()) {
    const result = temporaryRiskAcceptance('.', report(), 1, evidence(), { now: beforeExpiry, policy: candidate });
    assert.equal(result.accepted, false, `policy ${ordinal}`);
    assert.match(result.reason, /Invalid scripts\/dependency-risk-acceptance\.json/, `policy ${ordinal}`);
    assert.throws(() => matchesApprovedRiskInputs('.', evidence(), candidate), /Invalid scripts/, `policy ${ordinal}`);
    const harness = auditHarness(directory, () => ({ status: 0, stdout: JSON.stringify(zero), stderr: '' }));
    harness.options.riskPolicy = candidate;
    assert.equal(auditAllProjects('fixture-npm-cli.js', harness.options), true, `zero findings, policy ${ordinal}`);
  }
});

test('the observed npm remediation alternatives preserve the exact installed security report', () => {
  const rootAlternative = report();
  for (const name of ['fdir', 'picomatch', 'tinyglobby']) {
    rootAlternative.vulnerabilities[name].fixAvailable.name = 'knip';
    rootAlternative.vulnerabilities[name].fixAvailable.version = '3.13.2';
  }
  const serialized = Buffer.from(JSON.stringify(rootAlternative, null, 2) + '\n');
  assert.equal(
    createHash('sha256').update(serialized).digest('hex'),
    'ec010dad8060bea0b342a29728a968e5a3733149ea3f40cab5c5f2fe0e7f2467',
  );
  assert.equal(accept('.', rootAlternative).accepted, true);
  for (const project of [
    'examples/project/components/pcf-field-control',
    'examples/project/components/pcf-web-api-control',
  ]) {
    const alternative = report(project);
    alternative.vulnerabilities.picomatch.fixAvailable.name = 'pcf-start';
    alternative.vulnerabilities.picomatch.fixAvailable.version = '1.10.4';
    assert.equal(
      createHash('sha256')
        .update(JSON.stringify(alternative, null, 2) + '\n')
        .digest('hex'),
      '39ac54169efb21e50d8bcc3a56200f93cdafd498825658ec1cdaf26ce284eab3',
    );
    assert.equal(accept(project, alternative).accepted, true);
  }
  const reverse = report('examples/project/components/pcf-dataset-control');
  reverse.vulnerabilities.picomatch.fixAvailable.name = 'typescript-eslint';
  reverse.vulnerabilities.picomatch.fixAvailable.version = '8.47.0';
  assert.equal(accept('examples/project/components/pcf-dataset-control', reverse).accepted, true);
});

test('remediation normalization requires an affected direct ancestor and a strict semver version', () => {
  for (const name of ['unrelated', 'constructor', 'picomatch', 'fdir']) {
    const value = report();
    value.vulnerabilities.picomatch.fixAvailable.name = name;
    assert.equal(accept('.', value).accepted, false, name);
  }
  const unrelatedPeer = report();
  unrelatedPeer.vulnerabilities.vite.fixAvailable.name = 'knip';
  unrelatedPeer.vulnerabilities.vite.fixAvailable.version = '3.13.2';
  assert.equal(accept('.', unrelatedPeer).accepted, false, 'an affected peer is not an ancestor');
  for (const version of [
    'latest',
    '^3.13.2',
    'v3.13.2',
    '3.13',
    '03.13.2',
    '3.13.2-01',
    '3.13.2+',
    ' 3.13.2',
    '9007199254740992.0.0',
    null,
    3,
  ]) {
    const value = report();
    value.vulnerabilities.picomatch.fixAvailable.version = version;
    assert.equal(accept('.', value).accepted, false, String(version));
  }
  const validPrerelease = report();
  validPrerelease.vulnerabilities.picomatch.fixAvailable.version = '3.13.2-beta.1+build.01';
  assert.equal(accept('.', validPrerelease).accepted, true);
});

test('normalizing hint values never hides state, shape, unknown fields or operational metadata changes', () => {
  const changes = [
    (value) => {
      value.vulnerabilities.picomatch.fixAvailable = false;
    },
    (value) => {
      value.vulnerabilities.picomatch.fixAvailable = true;
    },
    (value) => {
      value.vulnerabilities.picomatch.fixAvailable = null;
    },
    (value) => {
      value.vulnerabilities.picomatch.fixAvailable = [];
    },
    (value) => {
      value.vulnerabilities.picomatch.fixAvailable.isSemVerMajor = false;
    },
    (value) => {
      delete value.vulnerabilities.picomatch.fixAvailable.isSemVerMajor;
    },
    (value) => {
      value.vulnerabilities.picomatch.fixAvailable.isSemVerMajor = 'true';
    },
    (value) => {
      value.vulnerabilities.picomatch.fixAvailable.extra = true;
    },
    (value) => {
      value.extra = true;
    },
    (value) => {
      value.metadata.extra = true;
    },
    (value) => {
      value.metadata.dependencies.extra = 1;
    },
    (value) => {
      value.metadata.dependencies.dev++;
    },
  ];
  for (const [ordinal, change] of changes.entries()) {
    const value = report();
    change(value);
    assert.equal(accept('.', value).accepted, false, `preserved report mutation ${ordinal}`);
  }
});
