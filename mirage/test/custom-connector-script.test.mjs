// @test-kind contract: the designed local .NET SDK host builds and runs connector scripts; a failed SDK probe is reported
// as its failure, probed again after a 30-second retry window and never cached as a version
// A custom connector's C# script (script.csx, ScriptBase) runs through the local .NET SDK for its scriptOperations:
// the host is generated and built once per script hash under the state directory, Context.SendAsync reaches the backend
// through the connection rewrites (loopback only), and the script's response is the action's. Skipped with a note when
// `dotnet` is not on PATH; the refusal path without the SDK is tested in custom-connector.test.mjs.
// A build costs several seconds of `dotnet build`, so one script serves every test: the memory-only test builds it once
// in its private temporary root and the state-directory tests share one state directory and so one build.
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { inventoryEntry, mergeInventory } from '../lib/solution-inventory.mjs';
import { customConnectorsOf } from '../lib/custom-connector.mjs';
import {
  createScriptHost,
  DOTNET_PROBE_GUARD_MS,
  dotnetSdk,
  killProcessTree,
  scriptHash,
} from '../lib/custom-connector-script.mjs';
import { createConnectorRuntime, connectionSettings } from '../lib/connector-runtime.mjs';
import { executeFlowDefinition } from '../lib/flow-runtime.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const NAME = 'x_5fscriptapi',
  AT = `Connectors/${NAME}/`;
const OPENAPI = {
  swagger: '2.0',
  info: { title: 'Invented scripted API' },
  host: 'api.example.test',
  basePath: '/v1',
  schemes: ['https'],
  paths: {
    '/items/{id}': {
      get: {
        operationId: 'GetItem',
        parameters: [{ name: 'id', in: 'path', required: true, type: 'string' }],
        responses: { 200: { description: 'ok' } },
      },
    },
    '/plain': { get: { operationId: 'Plain', responses: { 200: { description: 'ok' } } } },
    '/env': { get: { operationId: 'Env', responses: { 200: { description: 'ok' } } } },
  },
};
// GetItem forwards through Context.SendAsync; Env reports what the host process sees (a trusted script host gets a minimal
// environment: PATH, SystemRoot, TEMP/TMP, HOME/USERPROFILE, DOTNET_*, NUGET_*, never process.env, and runs in its folder
// under the state directory); any other operation is refused by the script itself.
const SCRIPT = `public class Script : ScriptBase
{
    public override async Task<HttpResponseMessage> ExecuteAsync()
    {
        if (this.Context.OperationId == "Env")
        {
            var environment = new HttpResponseMessage(HttpStatusCode.OK);
            environment.Content = CreateJsonContent(new JObject { ["secret"] = Environment.GetEnvironmentVariable("X_INVENTED_OTHER_SECRET"),
                ["path"] = !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("PATH")), ["cwd"] = Environment.CurrentDirectory }.ToString());
            return environment;
        }
        if (this.Context.OperationId != "GetItem")
        {
            var refused = new HttpResponseMessage(HttpStatusCode.BadRequest);
            refused.Content = CreateJsonContent(new JObject { ["refused"] = this.Context.OperationId }.ToString());
            return refused;
        }
        var response = await this.Context.SendAsync(this.Context.Request, this.CancellationToken).ConfigureAwait(false);
        var result = JObject.Parse(await response.Content.ReadAsStringAsync().ConfigureAwait(false));
        response.Content = CreateJsonContent(new JObject { ["wrapped"] = result, ["operation"] = this.Context.OperationId }.ToString());
        return response;
    }
}`;
// scriptOperations null: no API properties part, so the script runs for every operation.
const records = (scriptOperations = ['GetItem']) =>
  mergeInventory([
    inventoryEntry(AT + `${NAME}_openapidefinition.json`, {
      size: 100,
      text: JSON.stringify(OPENAPI),
      component: 'connector',
      componentName: NAME,
    })[0],
    ...(scriptOperations
      ? [
          inventoryEntry(AT + `${NAME}_apiproperties.json`, {
            size: 100,
            text: JSON.stringify({ properties: { scriptOperations } }),
            component: 'connector',
            componentName: NAME,
          })[0],
        ]
      : []),
    inventoryEntry(AT + 'script.csx', {
      size: SCRIPT.length,
      text: SCRIPT,
      component: 'connector',
      componentName: NAME,
    })[0],
  ]);
const SKIP = dotnetSdk() ? false : 'dotnet is not on PATH: the script host cannot be built here';

test(
  'memory-only connector hosts use private temporary storage and reuse identical builds within their process',
  { skip: SKIP },
  async (t) => {
    const options = { trusted: [{ connector: NAME, sha256: scriptHash(SCRIPT) }] };
    const first = createScriptHost(options),
      second = createScriptHost(options),
      script = { text: SCRIPT };
    const roots = [];
    t.after(async () => {
      for (const root of roots) await fs.rm(root, { recursive: true, force: true });
    });
    const prepare = async (host) => {
      const dll = await host.prepare(script, NAME);
      const directory = path.dirname(path.dirname(dll)),
        root = path.dirname(directory);
      const relative = path.relative(await fs.realpath(os.tmpdir()), await fs.realpath(root));
      assert.match(relative, /^mirage-connector-scripts-[^/\\]+$/);
      roots.push(root);
      assert.equal(await host.prepare(script, NAME), dll, 'each host reuses its prepared build');
      if (process.platform !== 'win32') {
        assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
        for (const name of ['ConnectorScriptHost.csproj', 'GlobalUsings.cs', 'Host.cs', 'Script.cs'])
          assert.equal((await fs.stat(path.join(directory, name))).mode & 0o777, 0o600, name);
      }
      return root;
    };
    assert.equal(
      await prepare(first),
      await prepare(second),
      'identical trusted scripts share the process-private build cache',
    );
  },
);

// The state-backed tests share one state directory, so the script is built there once. The collision test runs first
// (tests in a suite run in order) and builds from the matching source it leaves; the later tests reuse that build.
describe('a trusted script host under a state directory', { skip: SKIP }, () => {
  const trustedScripts = [{ connector: NAME, sha256: scriptHash(SCRIPT) }];
  let stateDirectory;
  before(async () => {
    stateDirectory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'connector-script-'));
  });
  after(() => fs.rm(stateDirectory, { recursive: true, force: true }));

  // The build has no limit of its own (custom-connector-script.mjs); the runner's hang guard is the only bound.
  test('connector preparation refuses a pre-existing different source without truncating it', async () => {
    const hash = createHash('sha256')
      .update(dotnetSdk() + '\n' + SCRIPT)
      .digest('hex')
      .slice(0, 32);
    const directory = path.join(stateDirectory, 'connector-scripts', hash),
      file = path.join(directory, 'Script.cs');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(file, 'Preserve this pre-existing file');
    const host = createScriptHost({ stateDirectory, trusted: trustedScripts });
    await assert.rejects(host.prepare({ text: SCRIPT }, NAME), { code: 'EEXIST' });
    assert.equal(await fs.readFile(file, 'utf8'), 'Preserve this pre-existing file');
    await fs.writeFile(file, SCRIPT);
    await fs.access(await host.prepare({ text: SCRIPT }, NAME));
  });

  test('a C# script runs its operation through the .NET SDK and Context.SendAsync reaches the loopback backend', async (t) => {
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push(req.url);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: req.url.split('/').pop() }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const merged = records();
    assert.equal(
      merged.find((r) => r.component === 'connector').level,
      'contract',
      'with the SDK on PATH the scripted connector compiles at contract',
    );
    const [connector] = customConnectorsOf(merged);
    assert.deepEqual([connector.blocked, connector.script.operations], [null, ['GetItem']]);
    const connectors = createConnectorRuntime({
      customConnectors: [connector],
      stateDirectory,
      trustedScripts,
      connections: connectionSettings({
        [NAME]: {
          connector: NAME,
          settings: { rewrites: { 'https://api.example.test/v1/': `http://127.0.0.1:${server.address().port}/` } },
        },
      }),
    });
    const answer = await connectors.invoke({
      connectorId: NAME,
      operationId: 'GetItem',
      parameters: { id: '7' },
      context: { timeoutMs: 120000 },
    });
    assert.equal(answer.statusCode, 200);
    assert.deepEqual(answer.body, { wrapped: { id: '7' }, operation: 'GetItem' });
    assert.deepEqual(seen, ['/items/7']);
    const hosts = await fs.readdir(path.join(stateDirectory, 'connector-scripts'));
    assert.equal(hosts.length, 1, 'one host per script hash under the state directory');
    // An operation outside scriptOperations goes to the backend directly.
    assert.deepEqual(
      (
        await connectors.invoke({
          connectorId: NAME,
          operationId: 'Plain',
          parameters: {},
          context: { timeoutMs: 120000 },
        })
      ).body,
      { id: 'plain' },
    );
    // A flow action reaches the scripted operation; the build is reused.
    const definition = {
      triggers: { manual: { type: 'Request', kind: 'Button', inputs: { schema: {} } } },
      actions: {
        Call: {
          type: 'OpenApiConnection',
          runAfter: {},
          inputs: {
            host: { apiId: `/providers/Microsoft.PowerApps/apis/${NAME}`, operationId: 'GetItem' },
            parameters: { id: '9' },
          },
        },
        Reply: {
          type: 'Response',
          runAfter: { Call: ['Succeeded'] },
          inputs: { statusCode: 200, body: "@body('Call')" },
        },
      },
    };
    assert.deepEqual(await executeFlowDefinition({ definition, input: {}, connectors, limits: { timeoutMs: 5000 } }), {
      status: 200,
      body: { wrapped: { id: '9' }, operation: 'GetItem' },
    });
    assert.equal((await fs.readdir(path.join(stateDirectory, 'connector-scripts'))).length, 1);
  });

  // @test-kind security: a connector script host cannot read process environment secrets
  test('a trusted script host does not see process.env secrets and runs under the state directory', async (t) => {
    process.env.X_INVENTED_OTHER_SECRET = 'invented-other-secret';
    t.after(() => {
      delete process.env.X_INVENTED_OTHER_SECRET;
    });
    // Without API properties the script runs for every operation.
    const [connector] = customConnectorsOf(records(null));
    assert.deepEqual(connector.script.operations, []);
    const connectors = createConnectorRuntime({
      customConnectors: [connector],
      stateDirectory,
      trustedScripts,
      connections: connectionSettings({ [NAME]: { connector: NAME, settings: {} } }),
    });
    const invoke = (operationId) =>
      connectors.invoke({ connectorId: NAME, operationId, parameters: {}, context: { timeoutMs: 120000 } });
    const { body } = await invoke('Env');
    assert.equal(body.secret, null, 'the other connection secret is not in the host environment');
    assert.equal(body.path, true);
    assert.ok(
      path.resolve(body.cwd).startsWith(path.join(await fs.realpath(stateDirectory), 'connector-scripts')) ||
        path.resolve(body.cwd).startsWith(path.join(stateDirectory, 'connector-scripts')),
      body.cwd,
    );
    // Plain has no backend here: the script's own refusal proves it ran for an operation it was not listed for.
    const plain = await invoke('Plain');
    assert.deepEqual([plain.statusCode, plain.body], [400, { refused: 'Plain' }]);
  });
});

// Replaces spawnSync for one command with scripted `--version` answers, in call order. The module reads spawnSync
// through its named import, so the replacement is synced into the module namespace (as sdk-tooling-unavailable.mjs
// does) and restored.
async function withScriptedVersionProbe(command, answers, body) {
  const original = childProcess.spawnSync,
    calls = [];
  childProcess.spawnSync = (name, args, options) => {
    if (name !== command) return original(name, args, options);
    calls.push(args);
    return answers.shift();
  };
  syncBuiltinESMExports();
  try {
    return await body(calls);
  } finally {
    childProcess.spawnSync = original;
    syncBuiltinESMExports();
  }
}
const timedOutProbe = () => ({
  status: null,
  stdout: '',
  stderr: '',
  error: Object.assign(new Error('spawnSync dotnet ETIMEDOUT'), { code: 'ETIMEDOUT' }),
});
const versionProbe = (version) => ({ status: 0, stdout: `${version}\n`, stderr: '', error: undefined });
const INVENTED_SCRIPT = { text: 'class Script {}' };
const INVENTED_TRUST = [{ connector: 'Invented', sha256: scriptHash(INVENTED_SCRIPT.text) }];

test('a timed-out dotnet --version probe is held for the 30 second retry window, then probed again and cached as its version', () => {
  const command = 'x-invented-dotnet-probe-timeout-hold';
  let probes = 0;
  let now = 1000;
  const answers = [timedOutProbe(), versionProbe('8.0.100')];
  const host = createScriptHost({
    command,
    now: () => now,
    spawnSyncImpl: () => answers[Math.min(probes++, answers.length - 1)],
  });
  assert.equal(host.available(), false);
  assert.equal(probes, 1);
  assert.match(host.missing(), /did not answer within the 120000 ms guard/, 'the reason names the guard');
  now += 1;
  assert.equal(host.available(), false);
  assert.equal(probes, 1, 'the timed-out probe is not run again inside the window');
  now += 29998;
  assert.equal(host.available(), false, 'the last instant inside the window is still held');
  assert.equal(probes, 1);
  now += 1;
  assert.equal(host.available(), true, 'the window has passed by the injected clock, so the probe runs again');
  assert.equal(probes, 2);
  now += 100000;
  assert.equal(host.available(), true);
  assert.equal(probes, 2, 'the answered version is cached, not probed again');
});

test('a dotnet probe that fails other than by a missing file reports that failure, never "not on PATH"', async () => {
  const command = 'x-invented-dotnet-probe-exit';
  const exited = { status: 3, stdout: '', stderr: 'Invented resolver failure', error: undefined };
  await withScriptedVersionProbe(command, [exited], async () => {
    const host = createScriptHost({ command, trusted: INVENTED_TRUST });
    await assert.rejects(host.prepare(INVENTED_SCRIPT, 'Invented'), (error) => {
      assert.equal(error.code, 'OperationUnsupported');
      assert.match(
        error.message,
        /CONNECTOR_SCRIPT_SDK_MISSING.*'x-invented-dotnet-probe-exit --version' failed: exit status 3/,
      );
      assert.doesNotMatch(error.message, /not on PATH/);
      return true;
    });
  });
});

test('a dotnet command that does not exist is reported as not on PATH', async () => {
  const command = 'x-invented-dotnet-absent';
  const host = createScriptHost({ command, trusted: INVENTED_TRUST });
  await assert.rejects(host.prepare(INVENTED_SCRIPT, 'Invented'), (error) =>
    /CONNECTOR_SCRIPT_SDK_MISSING.*'x-invented-dotnet-absent' is not on PATH/.test(error.message),
  );
});

// A child-process double for the build: it records kill() and emits its output only when the test says so.
class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 4242;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.kills = 0;
  }
  kill() {
    this.kills += 1;
    return true;
  }
}
const absentProbe = () => ({
  status: null,
  stdout: '',
  stderr: '',
  error: Object.assign(new Error('spawnSync x-invented-dotnet-build-probe ENOENT'), { code: 'ENOENT' }),
});

test('aborting a dotnet build kills its child and rejects with the abort reason', async () => {
  const command = 'x-invented-dotnet-build-abort';
  const stateDirectory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'connector-script-abort-'));
  try {
    const children = [];
    let spawned;
    const spawnedChild = new Promise((resolve) => {
      spawned = resolve;
    });
    const kills = [];
    const host = createScriptHost({
      stateDirectory,
      command,
      trusted: INVENTED_TRUST,
      spawnSyncImpl: () => versionProbe('8.0.100'),
      // The POSIX group kill is injected: the fake child's pid is not a real build, so no real signal is sent.
      platform: 'linux',
      killImpl: (pid, signal) => kills.push([pid, signal]),
      spawnImpl: () => {
        const child = new FakeChild();
        children.push(child);
        spawned(child);
        return child;
      },
    });
    const controller = new AbortController();
    const reason = new Error('invented caller cancelled the build');
    const building = host.prepare(INVENTED_SCRIPT, 'Invented', controller.signal);
    const child = await spawnedChild;
    controller.abort(reason);
    await assert.rejects(building, (error) => error === reason);
    assert.equal(children.length, 1);
    assert.equal(child.kills, 1);
    assert.deepEqual(kills, [[-4242, 'SIGTERM']], 'the build group is signalled once');
  } finally {
    await fs.rm(stateDirectory, { recursive: true, force: true });
  }
});

test('an aborted build whose spawn failed rejects with the abort reason, not with the pid guard', async () => {
  const command = 'x-invented-dotnet-build-no-pid';
  const stateDirectory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'connector-script-no-pid-'));
  try {
    const kills = [];
    let spawned;
    const spawnedChild = new Promise((resolve) => {
      spawned = resolve;
    });
    const host = createScriptHost({
      stateDirectory,
      command,
      trusted: INVENTED_TRUST,
      spawnSyncImpl: () => versionProbe('8.0.100'),
      platform: 'linux',
      killImpl: (pid, signal) => kills.push([pid, signal]),
      spawnImpl: () => {
        // A spawn that failed has no pid; its error event is still queued when the caller aborts.
        const child = new FakeChild();
        child.pid = undefined;
        spawned(child);
        return child;
      },
    });
    const controller = new AbortController();
    const reason = new Error('invented caller cancelled the build whose spawn failed');
    const building = host.prepare(INVENTED_SCRIPT, 'Invented', controller.signal);
    await spawnedChild;
    controller.abort(reason);
    await assert.rejects(building, (error) => error === reason);
    assert.deepEqual(kills, [], 'no process group is signalled for a build that never started');
  } finally {
    await fs.rm(stateDirectory, { recursive: true, force: true });
  }
});

test('a dotnet command that is absent is probed once, however many checks follow', () => {
  const command = 'x-invented-dotnet-build-absent-once';
  let probes = 0;
  const host = createScriptHost({
    command,
    spawnSyncImpl: () => {
      probes += 1;
      return absentProbe();
    },
  });
  assert.equal(host.available(), false);
  assert.equal(host.available(), false);
  assert.equal(probes, 1);
});

test('a dotnet probe that failed for another reason is probed again only after 30 seconds by the injected clock', () => {
  const command = 'x-invented-dotnet-probe-interval';
  let probes = 0;
  let now = 1000;
  const host = createScriptHost({
    command,
    now: () => now,
    spawnSyncImpl: () => {
      probes += 1;
      return { status: 3, stdout: '', stderr: 'Invented resolver failure', error: undefined };
    },
  });
  assert.equal(host.available(), false);
  now += 29999;
  assert.equal(host.available(), false);
  assert.equal(probes, 1);
  now += 1;
  assert.equal(host.available(), false);
  assert.equal(probes, 2);
});

// Builds that several callers await: each spawned dotnet is a FakeChild whose build the test finishes with finishBuild or
// ends by an abort. The runner answers the version probe and any taskkill; the default platform is POSIX with no real signal.
function recordingRunner(calls) {
  return (name, args, options) => {
    calls.push({ name, args, options });
    return args[0] === '--version' ? versionProbe('8.0.100') : { status: 0, stdout: '', stderr: '', error: undefined };
  };
}
function fakeBuilds(command, stateDirectory, extra = {}) {
  const children = [];
  const host = createScriptHost({
    stateDirectory,
    command,
    trusted: INVENTED_TRUST,
    platform: 'linux',
    killImpl: () => {},
    spawnSyncImpl: recordingRunner([]),
    spawnImpl: (name, args, options) => {
      const child = new FakeChild();
      child.args = args;
      child.options = options;
      child.dll = path.join(options.cwd, 'out', 'ConnectorScriptHost.dll');
      children.push(child);
      return child;
    },
    ...extra,
  });
  return { host, children };
}
// Completes a fake build: the host assembly appears where the build expects it, then the child closes with status 0.
async function finishBuild(child) {
  await fs.mkdir(path.dirname(child.dll), { recursive: true });
  await fs.writeFile(child.dll, '');
  child.emit('close', 0);
}

test('a shared build rejects only the caller that aborted, and still finishes for the caller waiting on it', async (t) => {
  const stateDirectory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'connector-script-shared-first-'));
  t.after(() => fs.rm(stateDirectory, { recursive: true, force: true }));
  const { host, children } = fakeBuilds('x-invented-dotnet-shared-first', stateDirectory);
  const first = new AbortController(),
    second = new AbortController(),
    reason = new Error('invented first caller cancelled');
  const firstBuild = host.prepare(INVENTED_SCRIPT, 'Invented', first.signal);
  const secondBuild = host.prepare(INVENTED_SCRIPT, 'Invented', second.signal);
  assert.equal(children.length, 1, 'both callers share one build');
  first.abort(reason);
  await assert.rejects(firstBuild, (error) => error === reason);
  assert.equal(children[0].kills, 0, 'the build is not killed while another caller waits on it');
  await finishBuild(children[0]);
  assert.equal(await secondBuild, children[0].dll);
  assert.equal(children.length, 1);
});

test('a shared build is killed once every waiting caller has aborted, and a later caller starts a fresh build', async (t) => {
  const stateDirectory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'connector-script-shared-all-'));
  t.after(() => fs.rm(stateDirectory, { recursive: true, force: true }));
  const { host, children } = fakeBuilds('x-invented-dotnet-shared-all', stateDirectory);
  const first = new AbortController(),
    second = new AbortController(),
    reasons = [new Error('invented first caller cancelled'), new Error('invented second caller cancelled')];
  const firstBuild = host.prepare(INVENTED_SCRIPT, 'Invented', first.signal);
  const secondBuild = host.prepare(INVENTED_SCRIPT, 'Invented', second.signal);
  first.abort(reasons[0]);
  await assert.rejects(firstBuild, (error) => error === reasons[0]);
  second.abort(reasons[1]);
  await assert.rejects(secondBuild, (error) => error === reasons[1]);
  assert.equal(children[0].kills, 1, 'the shared build is killed once, when its last waiter aborts');
  const third = host.prepare(INVENTED_SCRIPT, 'Invented', new AbortController().signal);
  assert.equal(children.length, 2, 'a caller after the kill starts a fresh build');
  await finishBuild(children[1]);
  assert.equal(await third, children[1].dll);
  assert.equal(children[0].kills, 1);
});

test('a dotnet build starts without reusable MSBuild worker nodes', async (t) => {
  const stateDirectory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'connector-script-nodes-'));
  t.after(() => fs.rm(stateDirectory, { recursive: true, force: true }));
  const { host, children } = fakeBuilds('x-invented-dotnet-build-nodes', stateDirectory);
  const building = host.prepare(INVENTED_SCRIPT, 'Invented');
  assert.equal(children[0].args[0], 'build');
  assert.equal(children.at(0).args.filter((arg) => arg === '-nodeReuse:false').length, 1);
  assert.equal(children[0].options.env.MSBUILDDISABLENODEREUSE, '1');
  await finishBuild(children[0]);
  await building;
});

test('an abort on Windows ends the whole build tree with taskkill /T /F and the build pid', async (t) => {
  const stateDirectory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'connector-script-tree-win-'));
  t.after(() => fs.rm(stateDirectory, { recursive: true, force: true }));
  const calls = [];
  const { host, children } = fakeBuilds('x-invented-dotnet-tree-win', stateDirectory, {
    platform: 'win32',
    spawnSyncImpl: recordingRunner(calls),
  });
  const controller = new AbortController(),
    reason = new Error('invented caller cancelled the Windows build');
  const building = host.prepare(INVENTED_SCRIPT, 'Invented', controller.signal);
  controller.abort(reason);
  await assert.rejects(building, (error) => error === reason);
  const taskkill = calls.find(({ name }) => name === 'taskkill');
  assert.deepEqual(taskkill?.args, ['/pid', '4242', '/T', '/F']);
  assert.equal(children[0].kills, 1, 'the driver itself is also ended');
});

test('an abort on POSIX signals the build process group, and the build leads its own group', async (t) => {
  const stateDirectory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'connector-script-tree-posix-'));
  t.after(() => fs.rm(stateDirectory, { recursive: true, force: true }));
  const kills = [];
  const { host, children } = fakeBuilds('x-invented-dotnet-tree-posix', stateDirectory, {
    platform: 'linux',
    killImpl: (pid, signal) => kills.push([pid, signal]),
  });
  const controller = new AbortController(),
    reason = new Error('invented caller cancelled the POSIX build');
  const building = host.prepare(INVENTED_SCRIPT, 'Invented', controller.signal);
  assert.equal(children[0].options.detached, true);
  controller.abort(reason);
  await assert.rejects(building, (error) => error === reason);
  assert.deepEqual(kills, [[-4242, 'SIGTERM']]);
});

test('killing the build tree runs taskkill for Windows and signals the group on POSIX', () => {
  const child = new FakeChild();
  const calls = [];
  killProcessTree(child, { platform: 'win32', spawnSyncImpl: recordingRunner(calls) });
  assert.deepEqual(calls.find(({ name }) => name === 'taskkill')?.args, ['/pid', '4242', '/T', '/F']);
  const kills = [];
  killProcessTree(child, { platform: 'linux', killImpl: (pid, signal) => kills.push([pid, signal]) });
  assert.deepEqual(kills, [[-4242, 'SIGTERM']]);
});

test('killing an exited build tree is not an error, and any other tree-kill failure surfaces', () => {
  const child = new FakeChild();
  const taskkillAnswers = (status) => () => ({ status, stdout: '', stderr: '', error: undefined });
  const killThrowing = (code) => () => {
    throw Object.assign(new Error(`kill ${code}`), { code });
  };
  assert.doesNotThrow(() => killProcessTree(child, { platform: 'win32', spawnSyncImpl: taskkillAnswers(128) }));
  assert.doesNotThrow(() => killProcessTree(child, { platform: 'linux', killImpl: killThrowing('ESRCH') }));
  assert.throws(() => killProcessTree(child, { platform: 'linux', killImpl: killThrowing('EPERM') }), {
    code: 'EPERM',
  });
  assert.throws(() => killProcessTree(child, { platform: 'win32', spawnSyncImpl: taskkillAnswers(1) }), /taskkill/);
});

test('a tree kill refuses a pid that cannot name one build, before any signal or taskkill is sent', () => {
  const calls = [];
  const killImpl = (...args) => calls.push(args);
  for (const pid of [0, 1, -1, -4242, Number.NaN, undefined, 1.5]) {
    const child = { pid };
    assert.throws(() => killProcessTree(child, { platform: 'linux', killImpl }), TypeError, `pid ${pid} on POSIX`);
    assert.throws(
      () => killProcessTree(child, { platform: 'win32', spawnSyncImpl: recordingRunner(calls) }),
      TypeError,
      `pid ${pid} on Windows`,
    );
  }
  assert.deepEqual(calls, []);
});

test('the dotnet --version probe runs under the probe guard by default, and probeGuardMs overrides it', () => {
  const seen = [];
  const runner = (name, args, options) => {
    seen.push(options.timeout);
    return versionProbe('8.0.100');
  };
  assert.equal(DOTNET_PROBE_GUARD_MS, 120_000);
  assert.equal(dotnetSdk('x-invented-dotnet-guard-default', { spawnSyncImpl: runner }), '8.0.100');
  assert.equal(dotnetSdk('x-invented-dotnet-guard-override', { spawnSyncImpl: runner, probeGuardMs: 1500 }), '8.0.100');
  assert.deepEqual(seen, [DOTNET_PROBE_GUARD_MS, 1500]);
});

test('a probe the guard ends says it did not answer within the guard and names probeGuardMs', async () => {
  const command = 'x-invented-dotnet-probe-guard';
  const host = createScriptHost({
    command,
    probeGuardMs: 5000,
    trusted: INVENTED_TRUST,
    spawnSyncImpl: () => timedOutProbe(),
  });
  await assert.rejects(host.prepare(INVENTED_SCRIPT, 'Invented'), (error) => {
    assert.equal(error.code, 'OperationUnsupported');
    assert.match(
      error.message,
      /CONNECTOR_SCRIPT_SDK_MISSING.*'x-invented-dotnet-probe-guard --version' failed: the probe did not answer within the 5000 ms guard \(probeGuardMs option\)/,
    );
    assert.doesNotMatch(error.message, /not on PATH/);
    return true;
  });
});
