// @test-kind tooling: the export table in docs/public-api.md and the package exports cannot drift apart.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Rows of the `| Import | Exports |` table: the backticked specifier, then every backticked identifier in its row.
function exportTable(markdown) {
  const lines = markdown.split(/\r?\n/);
  const header = lines.findIndex((line) => /^\|\s*Import\s*\|\s*Exports\s*\|\s*$/.test(line));
  assert.notEqual(header, -1, 'docs/public-api.md has no "| Import | Exports |" table');
  const rows = [];
  for (let index = header + 2; index < lines.length && lines[index].startsWith('|'); index++) {
    const [, specifierCell, exportsCell] = lines[index].split('|');
    const specifier = /^\s*`([^`]+)`\s*$/.exec(specifierCell)?.[1];
    assert.ok(specifier, `docs/public-api.md:${index + 1}: the Import cell is not one backticked specifier`);
    const names = [...exportsCell.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    for (const name of names)
      assert.match(name, /^[A-Za-z_$][\w$]*$/, `docs/public-api.md:${index + 1}: ${name} is not an export name`);
    rows.push({ line: index + 1, specifier, names });
  }
  return rows;
}

test('every import and export listed in docs/public-api.md resolves through package.json exports', async () => {
  const rows = exportTable(fs.readFileSync(new URL('../docs/public-api.md', import.meta.url), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(rows.length > 0, 'the export table has no rows');
  const missing = [];
  for (const { line, specifier, names } of rows) {
    assert.ok(specifier.startsWith(`${pkg.name}/`) || specifier === pkg.name, `docs/public-api.md:${line}`);
    const subpath = `.${specifier.slice(pkg.name.length)}`;
    assert.ok(Object.hasOwn(pkg.exports, subpath), `docs/public-api.md:${line}: ${subpath} is not in package exports`);
    assert.ok(names.length > 0, `docs/public-api.md:${line}: ${specifier} lists no exports`);
    // Self-reference resolves through the package's own exports map, as an installed consumer's import does.
    const actual = await import(specifier);
    for (const name of names)
      if (!Object.hasOwn(actual, name)) missing.push(`docs/public-api.md:${line}: ${specifier} has no export ${name}`);
  }
  assert.deepEqual(missing, []);
});

// Exported functions that legitimately take no required argument: called bare they succeed, or fail for a reason
// other than a missing argument (no catalogue in the working directory, no runtime at the default origin, a client
// shim used before configure()). Every other listed function must refuse a bare call by naming itself and the argument.
const NO_REQUIRED_ARGUMENT = new Set([
  // Catalogue readers default to ./paqvilo.config.yml; without one they refuse with CONFIG_NOT_FOUND.
  'loadCatalogue',
  'loadConfig',
  'loadDevTargets',
  'resolveCatalogue',
  // Classes and factories whose options are all optional.
  'DataError',
  'DataStore',
  'createMirageContext',
  'createCodeAppSdkExecutor',
  'codeApps',
  'quietDependencySourcemaps',
  'createScheduler',
  'fixedClock',
  'sequentialIds',
  // Discovery and inventories that default to the working directory or the built-in registry.
  'discoverPacks',
  'presetLibrary',
  'bootstrapPresetLibrary',
  'compactBuiltinPresets',
  'listPresets',
  'presetDescriptor',
  'packProvides',
  'mergePersonaCatalogs',
  'activatePackDeniedRoutes',
  'importSolutionData',
  'importSolutionPlugins',
  'loadSourceGraph',
  // Readers of optional inputs that return an empty or default result.
  'auditQuery',
  'browserChannel',
  'browserLaunchOptions',
  'captureLaunchOptions',
  'windowsLaunchOptions',
  'classifyNativeNetworkFailures',
  'correlateNetworkConsole',
  'decodePagingCookie',
  'escapeXmlAttribute',
  'observedEvidence',
  'simulatorBackgroundRequest',
  'validateNativeNetworkBaseline',
  'evaluateFlowTriggerConditions',
  'inspectFlowExpression',
  'fieldIndexFromMappings',
  'formatMockRecord',
  'schemaFieldIndex',
  'diffParityOutput',
  'validateParityCases',
  'webApiInputContractCases',
  'webApiScalarReaderCases',
  // Connects to the default loopback origin.
  'connectRuntime',
  // The Code Apps client shim: refuses use before configure({ app }).
  'getContext',
  'getStatus',
  'getToken',
  'dataClient',
]);
// Source text hashed as evidence: serialized into a browser page (no module helper in scope there), their source is
// pinned by mirage/test/fixtures/frontend-parity-evidence.json and the probe tests, so it must not change.
const BROWSER_SERIALIZED = new Set([
  'captureCanvasDraftInputContract',
  'captureCodeAppContextCacheContract',
  'captureCodeAppContextContract',
  'captureModelDrivenContract',
  'captureModelDrivenControlContract',
  'captureModelDrivenDirtyContract',
  'captureModelDrivenPresentationContract',
  'capturePowerPagesClientContract',
  'capturePowerPagesControlContract',
  // Node-side, but mirage/test/webapi-native-contract.test.mjs pins the SHA-256 of its source file as evidence.
  'captureWebApiInputContract',
]);
// A crash inside the function rather than a refusal of its missing argument.
const UNNAMED_FAILURE =
  /Cannot (?:read|destructure) propert|is not iterable|is not a function|ERR_INVALID_ARG_TYPE|ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)|ERR_INVALID_URL/;
// Calls each export bare in a child process run from an empty folder, so a function that does work writes nothing here.
const CALL_EACH = `
const results = {};
for (const [url, names] of JSON.parse(process.argv[1])) {
  const module = await import(url);
  for (const name of names) {
    const fn = module[name];
    if (typeof fn !== 'function') continue;
    try {
      const value = Function.prototype.toString.call(fn).startsWith('class ') ? new fn() : fn();
      await Promise.race([value, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 20000).unref())]);
      results[name] = { ok: true };
    } catch (error) {
      results[name] = { ok: false, name: error?.name, code: error?.code, message: String(error?.message ?? error) };
    }
  }
}
console.log(JSON.stringify(results));
process.exit(0);
`;

// @test-kind contract: a public function called without its required argument names itself and the argument.
test('every listed public function called without arguments names the missing argument', async (t) => {
  const { execFile } = await import('node:child_process');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const os = await import('node:os');
  const path = await import('node:path');
  const rows = exportTable(fs.readFileSync(new URL('../docs/public-api.md', import.meta.url), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const root = fileURLToPath(new URL('..', import.meta.url));
  const target = (subpath) => [pkg.exports[subpath]].flat().map((entry) => entry?.default ?? entry)[0];
  const modules = rows.map(({ specifier, names }) => [
    pathToFileURL(path.join(root, target(`.${specifier.slice(pkg.name.length)}`))).href,
    names.filter((name) => !BROWSER_SERIALIZED.has(name)),
  ]);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-public-api-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PAQVILO_')));
  const stdout = await new Promise((resolve, reject) =>
    execFile(
      process.execPath,
      ['--input-type=module', '-e', CALL_EACH, JSON.stringify(modules)],
      { cwd, env, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, out, stderr) => (error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(out)),
    ),
  );
  const results = JSON.parse(stdout.trim().split('\n').at(-1));
  const problems = [];
  for (const [name, result] of Object.entries(results)) {
    const text = `${result.code ?? ''} ${result.message ?? ''}`;
    if (!result.ok && UNNAMED_FAILURE.test(text)) problems.push(`${name}: ${result.message}`);
    else if (!NO_REQUIRED_ARGUMENT.has(name)) {
      if (result.ok)
        problems.push(`${name}: succeeded without its argument; list it in NO_REQUIRED_ARGUMENT if none is required`);
      else if (!result.message.includes(`${name}(`)) problems.push(`${name}: does not name itself: ${result.message}`);
      else if (result.name !== 'TypeError') problems.push(`${name}: refuses with ${result.name}: ${result.message}`);
    }
  }
  assert.deepEqual(problems, []);
});

// @test-kind contract: a connectRuntime() handle method called without its required argument names itself and sends nothing.
test('every connectRuntime() method called without arguments names a missing argument instead of requesting undefined', async () => {
  const { connectRuntime } = await import('paqvilo/mirage/testing');
  const sent = [];
  // Every route answers an empty object: a method that needs nothing completes, one that needs an argument must refuse
  // before it requests a route or body built from undefined.
  const fetchImpl = async (url, init = {}) => {
    sent.push(`${url} ${init.body ?? ''}`);
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const runtime = await connectRuntime({ origin: 'http://127.0.0.1:1', fetchImpl });
  const methods = [];
  const collect = (object, prefix) => {
    for (const [key, value] of Object.entries(object))
      if (typeof value === 'function') methods.push([`${prefix}${key}`, value]);
      else if (value && typeof value === 'object' && !Array.isArray(value)) collect(value, `${prefix}${key}.`);
  };
  collect(runtime, '');
  assert.ok(methods.some(([name]) => name === 'records'));
  const problems = [];
  for (const [name, method] of methods) {
    sent.length = 0;
    let failure;
    try {
      await Promise.race([
        method(),
        new Promise((resolve) => setTimeout(resolve, 2000).unref()), // a stream that waits is not a refusal
      ]);
    } catch (error) {
      failure = error;
    }
    if (failure && UNNAMED_FAILURE.test(`${failure.code ?? ''} ${failure.message}`))
      problems.push(`${name}: ${failure.message}`);
    else if (failure && /requires/.test(failure.message) && !failure.message.includes(`runtime.${name}(`))
      problems.push(`${name}: does not name itself: ${failure.message}`);
    else if (failure && /requires/.test(failure.message) && !(failure instanceof TypeError))
      problems.push(`${name}: refuses with ${failure.name}, not TypeError: ${failure.message}`);
    for (const request of sent) if (/undefined/.test(request)) problems.push(`${name}: sent ${request}`);
  }
  assert.deepEqual(problems, []);
});

// @test-kind contract: createSimulator and preflight share one source check; a call that selects no portal source is refused, never an empty report.
test('createSimulator() and preflight() refuse options that select no sources and name the keys given', async () => {
  const { createSimulator, preflight } = await import('paqvilo/mirage');
  for (const [call, fn, wanted] of [
    [
      'createSimulator(options)',
      createSimulator,
      'sourceDir (the exported portal directory) for the power-pages runtime',
    ],
    ['preflight(options)', preflight, 'sourceDir (the exported portal directory) or solutionRoots'],
  ]) {
    await assert.rejects(fn(), {
      name: 'TypeError',
      message: `${call} requires an options object with the portal sources (sourceDir or project).`,
    });
    await assert.rejects(fn({}), { name: 'TypeError', message: `${call} requires ${wanted}; got no options.` });
    await assert.rejects(fn({ source: './portal', strict: true }), {
      name: 'TypeError',
      message: `${call} requires ${wanted}; got source, strict.`,
    });
  }
  await assert.rejects(preflight({ runtime: { kind: 'dataverse-api' }, solutionRoots: [] }), {
    name: 'TypeError',
    message:
      'preflight(options) requires sourceDir (the exported portal directory) or solutionRoots; got runtime, solutionRoots.',
  });
});

// @test-kind contract: the calls the public rule names refuse a missing argument with TypeError naming the call, before any request.
test('trace.subscribe(), signIn() and the Code Apps configure() name the call they refuse', async () => {
  const { connectRuntime } = await import('paqvilo/mirage/testing');
  const { configure } = await import('paqvilo/mirage/code-apps/client');
  const sent = [];
  const fetchImpl = async (url) => {
    sent.push(String(url));
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const runtime = await connectRuntime({ origin: 'http://127.0.0.1:1', fetchImpl });
  sent.length = 0;
  assert.throws(() => runtime.trace.subscribe(), {
    name: 'TypeError',
    message: 'runtime.trace.subscribe(listener, options) requires a listener function.',
  });
  await assert.rejects(runtime.signIn(), {
    name: 'TypeError',
    message:
      'runtime.signIn(context, { contactId }) requires a contactId, or configuredPersona: true; omit signIn to stay anonymous.',
  });
  assert.deepEqual(sent, []);
  assert.throws(() => configure(), { name: 'TypeError', message: 'configure({ app }) requires a non-empty app name.' });
});
