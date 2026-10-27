// CLI subprocess acceptance: disposable exports and explicit solution roots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runtimePort } from '../lib/runtime-port.mjs';
import { withProcessSlot } from './process-slots.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';

const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
async function fixture(t, files) {
  // The real path: the CLI reports state and Solution paths as the OS resolves them (8.3 aliases expanded).
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-mirage-cli-')));
  // Removed after every owned server and child has closed (a failed after hook skips the hooks registered after it, so
  // closers must not depend on this one); retries cover a just-killed child's files that Windows still reports busy.
  ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  for (const [name, value] of Object.entries(files)) {
    const file = path.join(directory, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, value);
  }
  return directory;
}
function within(promise, timeout, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message())), timeout);
    }),
  ]).finally(() => clearTimeout(timer));
}
function closed(child) {
  // AbortSignal emits an error before close. Observe it immediately, but wait
  // for close so cleanup also covers the process and all of its stdio pipes.
  return new Promise((resolve) => {
    let error;
    // Shutdown can race the child's exit; an EPIPE on our stop command is
    // harmless once close has confirmed that the owned process has ended.
    child.stdin.on('error', () => {});
    child.once('error', (cause) => {
      error = cause;
    });
    child.once('close', (code, signal) => resolve({ code, signal, error }));
  });
}
async function forceStop(child, completion) {
  try {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  } finally {
    // A failed worker must never retain subprocess pipes and hold up the suite.
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }
  await within(completion, 1500, () => 'CLI did not close after forced termination');
}
async function stop(child, completion) {
  if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end('stop\n');
  await within(completion, 1500, () => 'CLI did not stop during cleanup').catch(() => forceStop(child, completion));
}
function closeServer(server) {
  const completion = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections();
  return within(completion, 1500, () => 'Owned HTTP fixture did not close');
}
function startup(child, completion, output) {
  let check;
  const diagnostic = () => {
    const { stdout, stderr } = output();
    return `stdout: ${stdout}\nstderr: ${stderr}`;
  };
  return within(
    new Promise((resolve, reject) => {
      check = () => {
        try {
          resolve(JSON.parse(output().stdout));
        } catch {
          /* Wait for complete startup JSON. */
        }
      };
      child.stdout.on('data', check);
      check();
      completion.then(({ error }) => {
        reject(error ?? new Error(`CLI exited before complete startup JSON. ${diagnostic()}`));
      });
    }),
    30_000,
    () => `CLI did not start after 30s. ${diagnostic()}`,
  ).finally(() => child.stdout.off('data', check));
}
async function run(t, args, cwd) {
  return withProcessSlot(async () => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      signal: t.signal,
      killSignal: 'SIGKILL',
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    const completion = closed(child);
    try {
      // Cold Windows runners need up to 10s just to start a valid runtime. Give
      // startup/commands headroom without extending any product request deadline.
      const { code, signal, error } = await within(
        completion,
        30_000,
        () => `CLI timed out after 30s: ${JSON.stringify(args)}\nstdout: ${stdout}\nstderr: ${stderr}`,
      );
      if (error) throw error;
      return { code, signal, stdout, stderr };
    } finally {
      await forceStop(child, completion);
    }
  });
}

test('runtime ports accept decimal integers from 0 to 65535 and reject empty and non-decimal spellings', () => {
  for (const [value, port] of [
    [undefined, 8787],
    ['0', 0],
    ['65535', 65535],
    [8080, 8080],
  ])
    assert.equal(runtimePort(value), port, String(value));
  for (const value of ['', ' ', '-1', '0x1000', '1e3', '65536', '1.5', null])
    assert.throws(() => runtimePort(value), /--port must be an integer from 0 to 65535/, JSON.stringify(value));
});

test('CLI: invalid serve ports fail before starting or writing simulation state', { timeout: 60_000 }, async (t) => {
  const directory = await fixture(t, {
    'portal/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\n',
    'portal/Home.webpage.copy.html': '<h1>Local home</h1>',
    'project.json': JSON.stringify({
      version: 1,
      portals: [
        { id: 'first', path: './portal' },
        { id: 'second', path: './portal' },
      ],
      solutions: [],
      references: [],
    }),
  });
  const state = path.join(directory, 'invalid-state.json');
  // One spelling per selection: the parser itself is covered above; this proves both serve paths parse before starting.
  const cases = [
    [['--source', path.join(directory, 'portal')], ''],
    [['--project', path.join(directory, 'project.json')], '1e3'],
  ];
  const results = await Promise.all(
    cases.map(([selection, port]) =>
      run(t, ['serve', ...selection, `--port=${port}`, '--state', state, '--no-watch'], directory),
    ),
  );
  for (const [index, result] of results.entries()) {
    assert.equal(result.code, 1, `${JSON.stringify(cases[index])}: ${result.stderr}`);
    assert.match(result.stderr, /--port must be an integer/);
    assert.equal(result.stdout, '');
  }
  await assert.rejects(fs.stat(state), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(directory, 'first')), { code: 'ENOENT' });
});

test('CLI: multi-portal serve closes its runtime after browser attachment fails', { timeout: 45_000 }, async (t) => {
  const directory = await fixture(t, {
    'portal/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\n',
    'portal/Home.webpage.copy.html': '<h1>Local home</h1>',
    'project.json': JSON.stringify({
      version: 1,
      portals: [
        { id: 'first', path: './portal' },
        { id: 'second', path: './portal' },
      ],
      solutions: [],
      references: [],
    }),
  });
  const rejectedCdp = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end('No browser');
  });
  rejectedCdp.listen(0, '127.0.0.1');
  await once(rejectedCdp, 'listening');
  ownedFixture(t).add(() => closeServer(rejectedCdp));
  const result = await run(
    t,
    [
      'serve',
      '--project',
      path.join(directory, 'project.json'),
      '--port',
      '0',
      '--no-watch',
      '--cdp',
      `http://127.0.0.1:${rejectedCdp.address().port}`,
    ],
    directory,
  );
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.signal, null, 'failure exits on its own after closing portal and identity provider');
  assert.match(result.stderr, /404|browser|CDP/i);
  assert.equal(result.stdout, '');
});

test(
  'CLI: standard/enhanced inspect, local render, controlled argument errors and no absolute render traffic',
  { timeout: 120_000 },
  async (t) => {
    const directory = await fixture(t, {
      'standard/Home.webpage.yml': 'adx_webpageid: home\nadx_name: CLI standard\nadx_partialurl: /\n',
      'standard/Home.webpage.copy.html': '<h1>CLI local {{ "Liquid" | upcase }}</h1>',
      'standard/deployment-profiles/sandbox.deployment.yml':
        'adx_webpage:\n- adx_webpageid: home\n  adx_name: Profile selected explicitly\n',
      'enhanced/home/powerpagecomponent.xml':
        '<powerpagecomponent powerpagecomponentid="enhanced-home"><name>Enhanced home</name><powerpagecomponenttype>2</powerpagecomponenttype><content>{&quot;adx_webpageid&quot;:&quot;enhanced-home&quot;,&quot;adx_name&quot;:&quot;Enhanced home&quot;,&quot;adx_partialurl&quot;:&quot;/&quot;,&quot;adx_copy&quot;:&quot;&lt;h1&gt;Enhanced local&lt;/h1&gt;&quot;}</content></powerpagecomponent>',
    });
    const standard = path.join(directory, 'standard');
    const output = path.join(directory, 'rendered.html');
    const unusedState = path.join(directory, 'capture-state.json');
    let unrelatedTraffic = 0;
    const unrelated = http.createServer((_req, res) => {
      unrelatedTraffic++;
      res.end('Unrelated');
    });
    unrelated.listen(0, '127.0.0.1');
    await once(unrelated, 'listening');
    ownedFixture(t).add(() => closeServer(unrelated));
    const unrelatedUrl = `http://127.0.0.1:${unrelated.address().port}/unrelated`;
    const badPaths = [unrelatedUrl, unrelatedUrl.replace('http:', ''), '/\\127.0.0.1/unsafe'];
    const [inspected, profiled, enhanced, rendered, unknownOption, missingCdp, withPreset, ...badRenders] =
      await Promise.all(
        [
          ['inspect', '--source', standard, '--env', 'sandbox', '--json'],
          ['inspect', '--source', standard, '--env', 'sandbox', '--deployment-profile', 'sandbox', '--json'],
          ['inspect', '--source', path.join(directory, 'enhanced'), '--json'],
          [
            'render',
            '--source',
            standard,
            '--state',
            path.join(directory, 'render-state.json'),
            '--path',
            '/',
            '--output',
            output,
          ],
          ['inspect', '--source', standard, '--not-an-option'],
          ['capture-shell', '--source', standard, '--state', unusedState, '--path', '/'],
          [
            'capture-shell',
            '--source',
            standard,
            '--state',
            unusedState,
            '--cdp',
            'http://127.0.0.1:1',
            '--preset',
            'contact-demo',
          ],
          ...badPaths.map((badPath, index) => [
            'render',
            '--source',
            standard,
            '--state',
            path.join(directory, `invalid-render-state-${index}.json`),
            '--path',
            badPath,
          ]),
        ].map((args) => run(t, args, directory)),
      );
    assert.equal(inspected.code, 0, inspected.stderr);
    const standardReport = JSON.parse(inspected.stdout);
    assert.equal(standardReport.format, 'standard');
    assert.equal(standardReport.pages[0].url, '/');
    assert.equal(standardReport.pages[0].name, 'CLI standard');
    assert.equal(standardReport.liquidSyntax.sourceCount, 1);
    assert.equal(standardReport.liquidSyntax.sourceParsePassed, 1);
    assert.deepEqual(standardReport.liquidSyntax.diagnostics, []);
    assert.equal(profiled.code, 0, profiled.stderr);
    assert.equal(JSON.parse(profiled.stdout).pages[0].name, 'Profile selected explicitly');
    assert.match(await fs.readFile(path.join(standard, 'Home.webpage.yml'), 'utf8'), /CLI standard/);
    assert.equal(enhanced.code, 0, enhanced.stderr);
    assert.equal(JSON.parse(enhanced.stdout).format, 'enhanced');
    assert.equal(JSON.parse(enhanced.stdout).pages[0].name, 'Enhanced home');
    assert.equal(rendered.code, 0, rendered.stderr);
    assert.equal(JSON.parse(rendered.stdout).status, 200);
    assert.match(await fs.readFile(output, 'utf8'), /CLI local LIQUID/);
    for (const [index, result] of badRenders.entries()) {
      assert.equal(result.code, 1, badPaths[index]);
      assert.match(result.stderr, /portal-relative|escaped the local simulator/);
    }
    assert.equal(unrelatedTraffic, 0);
    assert.equal(unknownOption.code, 1);
    assert.match(unknownOption.stderr, /Unknown option/);
    assert.doesNotMatch(unknownOption.stderr, /at parseArgs|node:internal|ERR_PARSE_ARGS/);
    assert.equal(missingCdp.code, 1);
    assert.match(missingCdp.stderr, /requires --cdp/);
    assert.equal(withPreset.code, 1);
    assert.match(withPreset.stderr, /does not apply presets/);
    await assert.rejects(fs.stat(unusedState), { code: 'ENOENT' });
  },
);

test(
  'CLI: explicit solution root resolves real form fixture and owned serve process shuts down cleanly',
  { timeout: 45_000 },
  async (t) => {
    const directory = await fixture(t, {
      'portal/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Form page\nadx_partialurl: /\n',
      'portal/Home.webpage.copy.html': "<h1>Form fixture</h1>{% entityform name: 'Edit contact' %}",
      'portal/Edit.basicform.yml':
        'adx_entityformid: basic-form\nadx_name: Edit contact\nadx_entityname: contact\nadx_formname: Portal edit\nadx_mode: 100000000\n',
      // An insert form renders only for an identity with a Create permission.
      'portal/webrole.yml': '- adx_webroleid: anonymous\n  adx_name: Anonymous Users\n  adx_anonymoususersrole: true\n',
      'portal/contact.tablepermission.yml':
        'adx_entitypermissionid: contact-create\nadx_entitylogicalname: contact\nadx_entityname: Contacts\nadx_scope: 756150000\nadx_create: true\nadx_entitypermission_webrole:\n- anonymous\n',
      'solutions/Package/Entities/contact/Entity.xml':
        '<Entity><Name>contact</Name><EntityInfo><entity Name="contact"><PrimaryIdAttribute>contactid</PrimaryIdAttribute><EntitySetName>contacts</EntitySetName><attributes><attribute PhysicalName="fullname"><LogicalName>fullname</LogicalName><Type>nvarchar</Type><RequiredLevel>required</RequiredLevel></attribute></attributes></entity></EntityInfo></Entity>',
      'solutions/Package/Entities/contact/FormXml/main/{form-id}.xml':
        '<forms><systemform><formid>{form-id}</formid><FormActivationState>1</FormActivationState><form><tabs><tab name="general"><columns><column width="100%"><sections><section name="contact"><rows><row><cell showlabel="true"><labels><label description="Friendly name" languagecode="1033"/></labels><control id="fullname" datafieldname="fullname"/></cell></row></rows></section></sections></column></columns></tab></tabs></form><LocalizedNames><LocalizedName description="Portal edit" languagecode="1033"/></LocalizedNames></systemform></forms>',
    });
    const child = spawn(
      process.execPath,
      [
        cli,
        'serve',
        '--source',
        path.join(directory, 'portal'),
        '--solution-root',
        path.join(directory, 'solutions'),
        '--state',
        'state.json',
        '--port',
        '0',
        '--no-watch',
        '--json',
      ],
      { cwd: directory, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, signal: t.signal, killSignal: 'SIGKILL' },
    );
    let stdout = '',
      stderr = '',
      ended = false;
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    const completion = closed(child).then((values) => {
      ended = true;
      return values;
    });
    ownedFixture(t).add(async () => {
      if (!ended) await stop(child, completion);
    });
    const discovery = await startup(child, completion, () => ({ stdout, stderr }));
    const stateResponse = await fetch(`${discovery.url}/__sim/api/state`);
    assert.equal(discovery.stateFile, path.join(directory, 'state.json'));
    assert.equal(stateResponse.status, 200);
    const state = await stateResponse.json();
    assert.equal(state.status.solutionMetadata.resolved.forms, 1);
    assert.deepEqual(state.status.solutionMetadata.roots, [path.join(directory, 'solutions')]);
    const page = await fetch(discovery.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Friendly name/);
    assert.ok(await fs.stat(discovery.discovery));
    child.stdin.end('stop\n');
    const { code, error } = await within(
      completion,
      10_000,
      () => `CLI did not stop. stdout: ${stdout}\nstderr: ${stderr}`,
    );
    if (error) throw error;
    assert.equal(code, 0, stderr);
    assert.equal(JSON.parse(stdout).url, discovery.url);
    await assert.rejects(fs.stat(discovery.discovery), (error) => error.code === 'ENOENT');
    await assert.rejects(fetch(discovery.url));
  },
);
