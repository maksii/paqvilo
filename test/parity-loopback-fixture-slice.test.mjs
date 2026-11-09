// @test-kind tooling: Invented fixtures verify source-preserving loopback hook certificates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  analyzeLoopbackFixtureSlice,
  analyzeLiteralStateProducer,
  analyzeOwnedHttpTransport,
  analyzeRoutingComponents,
  analyzeRoutingAuthentication,
  analyzeRoutingInputSlice,
} from '../scripts/parity-loopback-fixture-slice.mjs';
const { parse } = createRequire(import.meta.url)('espree');
const read = (source) => parse(source, { ecmaVersion: 'latest', sourceType: 'module', loc: true, range: true });
const prefix = `import { describe, it, before, after } from 'node:test'; import { start } from './sut.mjs'; const SECRET = 'INVENTED_SECRET';`;
const before = `process.env[SECRET] = 'synthetic'; api = await start({ settings });`;
const prior = `${prefix} describe('suite', () => { let api; before(async () => { ${before} }); after(async () => { delete process.env[SECRET]; await api?.close(); }); it('case', async () => {}); });`;
const next = `${prefix} describe('suite', () => { let api; let previous; before(async () => { previous = process.env[SECRET]; process.env[SECRET] = 'synthetic'; api = await start({ settings, host: '127.0.0.1' }); }); after(async () => { try { await api?.close(); } finally { if (previous === undefined) delete process.env[SECRET]; else process.env[SECRET] = previous; } }); it('case', async () => {}); });`;
function analyze(current = next, baseline = prior) {
  const baselineAst = read(baseline),
    currentAst = read(current);
  const testCall = (ast) => ast.body.at(-1).expression.arguments[1].body.body.at(-1).expression;
  return analyzeLoopbackFixtureSlice({
    baselineAst,
    currentAst,
    selected: [{ old: { node: testCall(baselineAst) }, current: { node: testCall(currentAst) } }],
    implementationSources: ['./sut.mjs'],
  });
}
test('certifies exact explicit host and secret restoration', () => {
  const result = analyze();
  assert.equal(result.descriptor.host, '127.0.0.1');
  assert.equal(result.current.recognizedIdentifiers.size, 3);
  assert.equal(result.current.requiresAllRegistrations, true);
});
test('rejects changed host, unproven host override, and altered inputs', () => {
  for (const edit of [
    (s) => s.replace('127.0.0.1', '0.0.0.0'),
    (s) => s.replace("host: '127.0.0.1'", "host: '127.0.0.1', ...other"),
    (s) => s.replace("'synthetic'", "'changed'"),
  ])
    assert.throws(() => analyze(edit(next)), /unsupported-loopback-fixture-slice/u);
});
test('rejects incomplete restore, extra previous-secret uses, or modified baseline', () => {
  for (const edit of [
    (s) => s.replace('finally', 'catch'),
    (s) => s.replace('else process.env[SECRET] = previous;', 'else delete process.env[SECRET];'),
    (s) => s.replace("it('case', async () => {});", "it('case', async () => { previous = 'tampered'; });"),
  ])
    assert.throws(() => analyze(edit(next)));
  assert.throws(() => analyze(next, prior.replace('delete process.env[SECRET];', 'external();')));
});

test('rejects concurrency options and unreviewed hooks', () => {
  const concurrent = (source) => source.replace("it('case', async", "it('case', { concurrency: true }, async");
  assert.throws(() => analyze(concurrent(next), concurrent(prior)), /unsupported-loopback-fixture-slice/u);
  const context = (source) => source.replace("it('case', async ()", "it('case', async (t)");
  assert.throws(() => analyze(context(next), context(prior)), /unsupported-loopback-fixture-slice/u);
  const hook = (source) => source.replace('describe, it, before, after', 'describe, it, before, after, beforeEach');
  assert.throws(() => analyze(hook(next), hook(prior)), /unsupported-loopback-fixture-slice/u);
});

test('rejects shadowed process or implementation bindings in both versions', () => {
  for (const declaration of ['const process = { env: {} };', 'const start = async () => ({});']) {
    const edit = (source) => source.replace("describe('suite', () => {", `describe('suite', () => { ${declaration}`);
    assert.throws(() => analyze(edit(next), edit(prior)), /unsupported-loopback-fixture-slice/u);
  }
});

test('proves a literal state producer and rejects ambient or mutated inputs', () => {
  const source =
    "import { empty } from './sut.mjs'; const ID = 'invented'; function schema() { const state = empty(); state.tables = { item: [{ id: ID }] }; return state; }";
  const verify = (current, baseline = source) =>
    analyzeLiteralStateProducer({
      baselineAst: read(baseline),
      currentAst: read(current),
      producerName: 'schema',
      implementationSources: ['./sut.mjs'],
    });
  assert.ok(verify(source).producerAstSha256);
  for (const edit of [
    (s) => s.replace('id: ID', 'id: process.env.EXTERNAL'),
    (s) => s.replace('const ID', 'let ID'),
    (s) => s.replace('return state;', 'sideEffect(); return state;'),
  ]) {
    const changed = edit(source);
    assert.throws(() => verify(changed, changed), /unsupported-loopback-fixture-slice/u);
  }
});

test('recognizes exact owned-origin HTTP forwarding and rejects altered destinations', () => {
  const transport =
    "function send(method, path, { headers = {}, body, auth = true } = {}) {\n  const url = new URL(`${api.origin}${path}`);\n  const payload = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);\n  const all = { ...(auth ? { authorization: `Bearer ${token}` } : {}), accept: 'application/json', ...headers };\n  if (payload !== null && all['content-type'] === undefined) all['content-type'] = 'application/json; charset=utf-8';\n  if (payload !== null) all['content-length'] = Buffer.byteLength(payload);\n  return new Promise((resolve, reject) => {\n    const req = request(\n      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers: all },\n      (res) => {\n        const chunks = [];\n        res.on('data', (chunk) => chunks.push(chunk));\n        res.on('end', () => {\n          const text = Buffer.concat(chunks).toString('utf8');\n          resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) });\n        });\n      },\n    );\n    req.on('error', reject);\n    if (payload !== null) req.write(payload);\n    req.end();\n  });\n}";
  const decorate = (text) =>
    text
      .replace('import { start }', "import { request } from 'node:http'; import { start }")
      .replace('let api;', `let api; let token; ${transport}`);
  const verify = (candidate, baseline = decorate(prior)) => {
    const baselineAst = read(baseline),
      currentAst = read(candidate);
    const testCall = (ast) => ast.body.at(-1).expression.arguments[1].body.body.at(-1).expression;
    return analyzeOwnedHttpTransport({
      baselineAst,
      currentAst,
      selected: [{ old: { node: testCall(baselineAst) }, current: { node: testCall(currentAst) } }],
    });
  };
  const candidate = decorate(next);
  assert.ok(verify(candidate).transportAstSha256);
  const altered = candidate.replace('hostname: url.hostname', "hostname: 'example.test'");
  assert.throws(() => verify(altered), /unsupported-loopback-fixture-slice/u);
  const compromised = decorate(prior).replace('hostname: url.hostname', "hostname: 'example.test'");
  assert.throws(() => verify(altered, compromised), /unsupported-loopback-fixture-slice/u);
  const marker = String.fromCharCode(36),
    tick = String.fromCharCode(96);
  const route = 'const record = (id = ID) => ' + tick + marker + '{BASE}/rows(' + marker + '{id})' + tick + ';';
  const compose = (text) =>
    decorate(text)
      .replace('import { start }', "import assert from 'node:assert/strict'; import { start, empty }")
      .replace(
        'const SECRET =',
        "const BASE = '/api'; const ID = 'item'; function schema() { const state = empty(); state.rows = []; return state; } const SECRET =",
      )
      .replace(
        'let api; let token;',
        'let api; let token; const error = async (response) => (await response.json()).error; ' + route,
      )
      .replace('api = await start(', 'const created = schema(); token = "synthetic"; api = await start(')
      .replace("it('case', async () => {});", "it('case', async () => { await send('HEAD', record()); });");
  const verifyClosure = (current, baseline = compose(prior)) => {
    const baselineAst = read(baseline),
      currentAst = read(current);
    const call = (ast) => ast.body.at(-1).expression.arguments[1].body.body.at(-1).expression;
    return analyzeRoutingComponents({
      baselineAst,
      currentAst,
      selected: [{ old: { node: call(baselineAst) }, current: { node: call(currentAst) } }],
      implementationSources: ['./sut.mjs'],
    });
  };
  const complete = compose(next);
  assert.ok(verifyClosure(complete).routing.stateAstSha256);
  const escaped = complete.replace('record());', "'https://example.test');");
  assert.throws(() => verifyClosure(escaped), /unsupported-loopback-fixture-slice/u);
  const mutation = complete.replace(
    "it('case', async () => {",
    "it('case', async () => { api.origin = 'https://example.test';",
  );
  assert.throws(() => verifyClosure(mutation), /unsupported-loopback-fixture-slice/u);
  const authText =
    "    const form = new URLSearchParams({\n      grant_type: 'client_credentials',\n      client_id: APP_ID,\n      client_secret: process.env[SECRET],\n      scope: `${api.origin}/.default`,\n    });\n    const response = await fetch(`${api.origin}/${api.tenantId}/oauth2/v2.0/token`, {\n      method: 'POST',\n      headers: { 'content-type': 'application/x-www-form-urlencoded' },\n      body: form,\n    });\n    token = (await response.json()).access_token;";
  const authenticated = (text) =>
    compose(text)
      .replace('const SECRET =', "const APP_ID = 'invented'; const SECRET =")
      .replace('token = "synthetic";', authText);
  const verifySlice = (current, baseline = authenticated(prior)) => {
    const baselineAst = read(baseline),
      currentAst = read(current);
    const call = (ast) => ast.body.at(-1).expression.arguments[1].body.body.at(-1).expression;
    return analyzeRoutingInputSlice({
      baselineAst,
      currentAst,
      selected: [{ old: { node: call(baselineAst) }, current: { node: call(currentAst) } }],
      implementationSources: ['./sut.mjs'],
    });
  };
  const input = authenticated(next);
  assert.ok(verifySlice(input).current.recognizedExternalInputs.size > 0);
  const baselineInput = authenticated(prior);
  const basic = "await send('HEAD', record());";
  const constantTemplate = tick + marker + '{BASE}/missing' + tick;
  const loopTemplate = tick + marker + '{BASE}/' + marker + '{name}' + tick;
  const positive = [
    "await send('HEAD', " + constantTemplate + ');',
    "await send('HEAD', record() + '/missing');",
    "for (const name of ['one', 'two']) { const response = await send('HEAD', " +
      loopTemplate +
      "); assert.equal(response.status, 404, name); assert.deepEqual(await error(response), { code: 'x', message: name }, name); }",
  ];
  for (const replacement of positive) {
    const oldVariant = baselineInput.replace(basic, replacement),
      newVariant = input.replace(basic, replacement);
    assert.notEqual(oldVariant, baselineInput);
    assert.ok(verifySlice(newVariant, oldVariant).routing.paths.length);
  }
  const negatives = [
    "await send('HEAD', process.env.OUTSIDE);",
    "await send('HEAD', '//example.test');",
    "await send('HEAD', 'https://example.test');",
    "await send('HEAD', record(ID));",
    "for (let name of ['one', 'two']) { const response = await send('HEAD', " +
      loopTemplate +
      "); assert.equal(response.status, 404, name); assert.deepEqual(await error(response), { code: 'x', message: name }, name); }",
  ];
  for (const replacement of negatives) {
    const oldVariant = baselineInput.replace(basic, replacement),
      newVariant = input.replace(basic, replacement);
    assert.throws(() => verifySlice(newVariant, oldVariant), /unsupported-loopback-fixture-slice/u);
  }
  const oldLoop = baselineInput.replace(basic, positive[2]),
    newLoop = input.replace(basic, positive[2]);
  for (const statement of [
    'Array.prototype.reviewFlag = true;',
    "const key = 'constructor'; const value = [][key];",
    'globalThis.reviewFlag = true;',
  ]) {
    const attack = (text) => text.replace("it('case',", "it('sibling', async () => { " + statement + " }); it('case',");
    assert.throws(() => verifySlice(attack(newLoop), attack(oldLoop)), /unsupported-loopback-fixture-slice/u);
  }
  const extraCall = (text) =>
    text.replace('assert.equal(response.status, 404, name);', 'unknown(); assert.equal(response.status, 404, name);');
  assert.throws(() => verifySlice(extraCall(newLoop), extraCall(oldLoop)), /unsupported-loopback-fixture-slice/u);

  assert.throws(
    () =>
      verifySlice(
        input.replace("it('case', async () => {", "it('case', async () => { await fetch('https://example.test');"),
      ),
    /unsupported-loopback-fixture-slice/u,
  );
});

test('binds the token exchange to the owned origin and invented secret', () => {
  const auth =
    "    const form = new URLSearchParams({\n      grant_type: 'client_credentials',\n      client_id: APP_ID,\n      client_secret: process.env[SECRET],\n      scope: `${api.origin}/.default`,\n    });\n    const response = await fetch(`${api.origin}/${api.tenantId}/oauth2/v2.0/token`, {\n      method: 'POST',\n      headers: { 'content-type': 'application/x-www-form-urlencoded' },\n      body: form,\n    });\n    token = (await response.json()).access_token;";
  const decorate = (source) =>
    source
      .replace('const SECRET =', "const APP_ID = 'invented'; const SECRET =")
      .replace('let api;', 'let api; let token;');
  const withAuth = (source) =>
    decorate(source)
      .replace('api = await start({ settings });', 'api = await start({ settings }); ' + auth)
      .replace(
        "api = await start({ settings, host: '127.0.0.1' });",
        "api = await start({ settings, host: '127.0.0.1' }); " + auth,
      );
  const verify = (current, baseline = withAuth(prior)) => {
    const baselineAst = read(baseline),
      currentAst = read(current);
    const call = (ast) => ast.body.at(-1).expression.arguments[1].body.body.at(-1).expression;
    return analyzeRoutingAuthentication({
      baselineAst,
      currentAst,
      selected: [{ old: { node: call(baselineAst) }, current: { node: call(currentAst) } }],
    });
  };
  const good = withAuth(next);
  assert.ok(verify(good).current.responseAstSha256);
  const changed = good.replace('api.origin', 'external.origin');
  assert.throws(() => verify(changed), /unsupported-loopback-fixture-slice/u);
});
