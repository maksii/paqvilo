// @test-kind security: baseline capture redaction guarantees: credential values in request and response bodies never reach written evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  redactEmbeddedQueryValues as redact,
  writeCapture,
  redactTokens,
  redactDomCredentials,
} from '../baseline-capture.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { workerAnswer } from './support/worker-answer.mjs';

test('HTML and inline script URLs remove every query value while preserving neighboring structure', () => {
  const value =
    '<script src="https://maps.invalid/control?key=fixture-secret&amp;callback=loadMap&amp;page=2"></script><script>const url="/map?token=second-secret&x=17"; const sibling=17;</script>';
  assert.equal(
    redact(value),
    '<script src="https://maps.invalid/control?key=…&amp;callback=…&amp;page=2"></script><script>const url="/map?token=…&x=…"; const sibling=17;</script>',
  );
});
test('JSON escaped slashes and encoded ampersands preserve valid structure and siblings', () => {
  for (const sep of ['&amp;', '&#38;', '&#x26;', '\\u0026']) {
    const url = 'https:\\/\\/maps.invalid\\/control?key=fixture-secret' + sep + 'other=second-secret',
      input = '{"url":"' + url + '","label":"keep","count":17}';
    const output = redact(input);
    assert.equal(
      output,
      '{"url":"https:\\/\\/maps.invalid\\/control?key=…' + sep + 'other=…","label":"keep","count":17}',
    );
    if (sep === '\\u0026') assert.equal(JSON.parse(output).count, 17);
  }
});
test('URL path identity, duplicate query keys, flags and trailing expression punctuation survive', () => {
  assert.equal(
    redact('fetch("https://maps.invalid/00000000-0000-0000-0000-000000000001?key=a&key=b&flag&page=3"); next();'),
    'fetch("https://maps.invalid/00000000-0000-0000-0000-000000000001?key=…&key=…&flag&page=3"); next();',
  );
  assert.equal(
    redact('const next = (https://maps.invalid/control?key=fixture-secret);'),
    'const next = (https://maps.invalid/control?key=…);',
  );
});
test('ordinary text and URLs without query values remain unchanged', () => {
  for (const input of [
    '{"value":17,"name":"key"}',
    'https://maps.invalid/control#details',
    '/literal/path',
    '<div data-key="not-a-url">untouched</div>',
  ])
    assert.equal(redact(input), input);
});

test('large query-free paths finish in a bounded worker and a final query is still redacted', async (t) => {
  const result = await workerAnswer(
    `const {parentPort,workerData}=require('node:worker_threads');
    import(workerData.module).then(({redactEmbeddedQueryValues:redact})=>{
      const path='/a'.repeat(250000);
      parentPort.postMessage({unchanged:redact(path)===path,redacted:redact(path+'?key=fixture-secret')===path+'?key=…'});
    }).catch(error=>{throw error;});`,
    {
      eval: true,
      workerData: { module: new URL('../baseline-capture.mjs', import.meta.url).href },
      signal: t.signal,
    },
  );
  assert.deepEqual(result, { unchanged: true, redacted: true });
});

test('redacted text hashes exclude original secret bytes while unchanged text and binary retain raw hashes', async () => {
  const out = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-redaction-hash-'));
  const secret = '<script src="https://maps.invalid/control?key=fixture-secret"></script>';
  const unchanged = '\uFEFFunchanged text';
  const binary = Buffer.from([0, 255, 17, 42]);
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  const response = (body, bytes) => ({
    status: 200,
    headers: {},
    body,
    bodyBytes: bytes.length,
    bodyHashInput: bytes.toString('base64'),
  });
  try {
    await writeCapture(
      {
        summary: { id: 'invented/hash', status: 'captured', problems: [] },
        raw: {
          finalUrl: 'https://portal.invalid/',
          console: [],
          pageErrors: [],
          dialogs: [],
          dom: '<main>Fixture</main>',
          elements: [],
          requests: [
            response(secret, Buffer.from(secret)),
            response(unchanged, Buffer.from(unchanged)),
            response(null, binary),
          ].map((value, seq) => ({
            seq,
            method: 'GET',
            url: 'https://portal.invalid/asset-' + seq,
            headers: {},
            body: null,
            response: value,
          })),
        },
      },
      { outDir: out, origin: 'https://portal.invalid', side: 'native', scenarioId: 'invented/hash' },
    );
    const requests = JSON.parse(await fs.readFile(path.join(out, 'requests.json'), 'utf8'));
    assert.equal(requests[0].response.bodySha256, hash(redactTokens(secret)));
    assert.equal(requests[0].response.bodyHashProvenance, 'redacted-text-sha256');
    assert.equal(requests[0].response.bodyBytes, Buffer.byteLength(secret));
    assert.equal(requests[1].response.bodySha256, hash(Buffer.from(unchanged)));
    assert.equal(requests[2].response.bodySha256, hash(binary));
    for (const file of await fs.readdir(out)) {
      if (!/\.(json|html)$/.test(file)) continue;
      const text = await fs.readFile(path.join(out, file), 'utf8');
      assert.equal(text.includes('fixture-secret'), false, file);
      assert.equal(text.includes(hash(secret)), false, file);
    }
  } finally {
    await fs.rm(out, { recursive: true, force: true });
  }
});

test('capture persistence redacts URL queries in DOM, bodies, frames, element inventory and console', async () => {
  const out = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-redaction-'));
  try {
    const url = 'https://maps.invalid/control?key=fixture-secret&callback=init',
      html = `<script src="${url}"></script>`,
      json = JSON.stringify({ url, sibling: 17 });
    await writeCapture(
      {
        summary: {
          id: 'invented/geo',
          status: 'captured',
          problems: [],
          startedAt: '2026-01-01T00:00:00Z',
          finishedAt: '2026-01-01T00:00:01Z',
        },
        raw: {
          finalUrl: 'https://portal.invalid/geo',
          requests: [
            {
              seq: 1,
              method: 'GET',
              url: 'https://portal.invalid/geo',
              headers: {},
              body: null,
              response: { status: 200, headers: {}, body: html, mime: 'text/html' },
            },
          ],
          console: [{ type: 'log', text: url }],
          pageErrors: [],
          dialogs: [],
          dom: html,
          frames: [{ path: 'frame', dom: html }],
          elements: [{ tag: 'script', attributes: { src: url }, sibling: 17 }],
        },
      },
      { outDir: out, origin: 'https://portal.invalid', side: 'native', scenarioId: 'invented/geo' },
    );
    for (const file of (await fs.readdir(out)).filter((f) => /\.(?:json|html)$/.test(f))) {
      const text = await fs.readFile(path.join(out, file), 'utf8');
      assert.equal(text.includes('fixture-secret'), false, file);
    }
    const elements = JSON.parse(await fs.readFile(path.join(out, 'elements.json'), 'utf8'));
    assert.equal(elements[0].sibling, 17);
    assert.equal(elements[0].attributes.src, 'https://maps.invalid/control?key=…&callback=…');
    assert.deepEqual(JSON.parse(redactTokens(json)), {
      url: 'https://maps.invalid/control?key=…&callback=…',
      sibling: 17,
    });
  } finally {
    await fs.rm(out, { recursive: true, force: true });
  }
});

test('credential values in request and response bodies never reach written evidence', async () => {
  const out = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-redaction-credential-'));
  const origin = 'https://portal.invalid';
  const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0ZXIifQ.c2lnbmF0dXJlLXNlY3JldA';
  const accessToken = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0ZXIyIn0.c2lnbmF0dXJlLXNlY3JldDI';
  const secrets = [jwt, accessToken, 'authcode-secret', 'SECRETSTATE', 'session-secret', 'refresh-secret', 'pw-secret'];
  const form =
    `code=0.authcode-secret&id_token=${jwt}` +
    '&state=OpenIdConnect.AuthenticationProperties%3DSECRETSTATE&session_state=session-secret&theme=dark&locale=en-US';
  const json = JSON.stringify({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 3600,
    session: { refresh_token: 'refresh-secret', scope: 'openid profile' },
    items: [{ password: 'pw-secret', name: 'keep' }],
  });
  try {
    await writeCapture(
      {
        summary: {
          id: 'invented/signin',
          status: 'captured',
          problems: [],
          startedAt: '2026-01-01T00:00:00Z',
          finishedAt: '2026-01-01T00:00:01Z',
        },
        raw: {
          finalUrl: origin + '/',
          console: [],
          pageErrors: [],
          dialogs: [],
          dom: '<main>Fixture</main>',
          elements: [],
          requests: [
            {
              seq: 1,
              method: 'POST',
              url: origin + '/signin-oidc',
              resourceType: 'document',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: form,
              response: { status: 302, headers: {}, body: null },
            },
            {
              seq: 2,
              method: 'GET',
              url: origin + '/api/session',
              resourceType: 'fetch',
              headers: {},
              body: null,
              response: {
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: json,
                bodyBytes: Buffer.byteLength(json),
              },
            },
          ],
        },
      },
      { outDir: out, origin, side: 'native', scenarioId: 'invented/signin' },
    );
    for (const file of await fs.readdir(out)) {
      const text = await fs.readFile(path.join(out, file), 'utf8');
      for (const secret of secrets) assert.equal(text.includes(secret), false, `${file} holds a credential value`);
    }
    const requests = JSON.parse(await fs.readFile(path.join(out, 'requests.json'), 'utf8'));
    assert.equal(
      requests[0].body,
      'code={token}&id_token={token}&state={token}&session_state={token}&theme=dark&locale=en-US',
    );
    assert.deepEqual(JSON.parse(requests[1].response.body), {
      access_token: '{token}',
      token_type: 'Bearer',
      expires_in: 3600,
      session: { refresh_token: '{token}', scope: 'openid profile' },
      items: [{ password: '{token}', name: 'keep' }],
    });
    assert.equal(requests[1].response.bodyHashProvenance, 'redacted-text-sha256');
    assert.equal(requests[1].response.bodySha256, createHash('sha256').update(requests[1].response.body).digest('hex'));
  } finally {
    await fs.rm(out, { recursive: true, force: true });
  }
});

test('hidden credential inputs keep their name and lose their value in the captured DOM and frame DOMs', async () => {
  const out = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-redaction-dom-'));
  const origin = 'https://portal.invalid';
  const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJkb20ifQ.ZG9tLXNpZ25hdHVyZS1zZWNyZXQ';
  const dom = `<form><input type="hidden" name="id_token" value="${jwt}"><input type="hidden" name="theme" value="dark"></form>`;
  const redacted = `<form><input type="hidden" name="id_token" value="{token}"><input type="hidden" name="theme" value="dark"></form>`;
  try {
    await writeCapture(
      {
        summary: {
          id: 'invented/hidden-input',
          status: 'captured',
          problems: [],
          startedAt: '2026-01-01T00:00:00Z',
          finishedAt: '2026-01-01T00:00:01Z',
        },
        raw: {
          finalUrl: origin + '/',
          console: [],
          pageErrors: [],
          dialogs: [],
          dom,
          elements: [],
          requests: [],
          frames: [{ path: 'frame-1', dom }],
        },
      },
      { outDir: out, origin, side: 'native', scenarioId: 'invented/hidden-input' },
    );
    assert.equal(await fs.readFile(path.join(out, 'dom.html'), 'utf8'), redacted);
    const frames = JSON.parse(await fs.readFile(path.join(out, 'frames.json'), 'utf8'));
    assert.equal(frames['frame-1'], redacted);
    for (const file of await fs.readdir(out))
      assert.equal(
        (await fs.readFile(path.join(out, file), 'utf8')).includes(jwt),
        false,
        `${file} holds a credential`,
      );
  } finally {
    await fs.rm(out, { recursive: true, force: true });
  }
});

const jsonResponse = (body) => ({ status: 200, headers: { 'content-type': 'application/json' }, body });
const redirect = { status: 302, headers: {}, body: null };
// Writes the given requests as one capture and returns the entries of its requests.json.
async function capturedRequests(requests) {
  const out = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-redaction-bodies-'));
  try {
    await writeCapture(
      {
        summary: {
          id: 'invented/bodies',
          status: 'captured',
          problems: [],
          startedAt: '2026-01-01T00:00:00Z',
          finishedAt: '2026-01-01T00:00:01Z',
        },
        raw: {
          finalUrl: 'https://portal.invalid/',
          console: [],
          pageErrors: [],
          dialogs: [],
          dom: '<main>Fixture</main>',
          elements: [],
          requests: requests.map((entry, index) => ({ seq: index + 1, headers: {}, ...entry })),
        },
      },
      { outDir: out, origin: 'https://portal.invalid', side: 'native', scenarioId: 'invented/bodies' },
    );
    return JSON.parse(await fs.readFile(path.join(out, 'requests.json'), 'utf8'));
  } finally {
    await fs.rm(out, { recursive: true, force: true });
  }
}

test('error codes and row columns named code or state survive in ordinary response bodies', async () => {
  const error = JSON.stringify({ error: { code: '0x80040217', message: 'Does not exist' } });
  const rows = JSON.stringify({ value: [{ state: 'Active', code: 'A1' }] });
  const [failed, listed] = await capturedRequests([
    { method: 'GET', url: 'https://portal.invalid/api/data/accounts', body: null, response: jsonResponse(error) },
    { method: 'GET', url: 'https://portal.invalid/api/data/states', body: null, response: jsonResponse(rows) },
  ]);
  assert.equal(failed.response.body, error);
  assert.equal(listed.response.body, rows);
});

test('a top-level code or state in an authorize or token form body is redacted', async () => {
  const [authorize, token] = await capturedRequests([
    {
      method: 'POST',
      url: 'https://portal.invalid/tenant/oauth2/v2.0/authorize',
      body: 'client_id=app&code=0.form-code-secret&state=form-state-secret&scope=openid',
      response: redirect,
    },
    {
      method: 'POST',
      url: 'https://identity.invalid/tenant/oauth2/v2.0/token',
      body: 'grant_type=authorization_code&code=0.token-code-secret&client_id=app',
      response: jsonResponse('{"token_type":"Bearer"}'),
    },
  ]);
  assert.equal(authorize.body, 'client_id=app&code={token}&state={token}&scope=openid');
  assert.equal(token.body, 'grant_type=authorization_code&code={token}&client_id=app');
  const text = JSON.stringify([authorize, token]);
  for (const secret of ['form-code-secret', 'form-state-secret', 'token-code-secret'])
    assert.ok(!text.includes(secret));
});

test('top-level code and state in JSON request bodies and token responses are redacted, and ordinary responses keep them', async () => {
  const [post, token, session] = await capturedRequests([
    {
      method: 'POST',
      url: 'https://portal.invalid/api/submit',
      body: JSON.stringify({ code: 'json-code-secret', state: 'json-state-secret', keep: true }),
      response: redirect,
    },
    {
      method: 'POST',
      url: 'https://identity.invalid/tenant/oauth2/v2.0/token',
      body: 'grant_type=refresh_token',
      response: jsonResponse(JSON.stringify({ code: 'token-code-secret', token_type: 'Bearer' })),
    },
    {
      method: 'GET',
      url: 'https://portal.invalid/api/session',
      body: null,
      response: jsonResponse(JSON.stringify({ code: 'A2', state: 'ready', result: { state: 'Active', code: 'A1' } })),
    },
  ]);
  assert.deepEqual(JSON.parse(post.body), { code: '{token}', state: '{token}', keep: true });
  assert.deepEqual(JSON.parse(token.response.body), { code: '{token}', token_type: 'Bearer' });
  assert.deepEqual(JSON.parse(session.response.body), {
    code: 'A2',
    state: 'ready',
    result: { state: 'Active', code: 'A1' },
  });
  const text = JSON.stringify([post, token]);
  for (const secret of ['json-code-secret', 'json-state-secret', 'token-code-secret'])
    assert.ok(!text.includes(secret));
});

test('credential keys stay redacted at any JSON depth in ordinary responses', async () => {
  const [session] = await capturedRequests([
    {
      method: 'GET',
      url: 'https://portal.invalid/api/session',
      body: null,
      response: jsonResponse(JSON.stringify({ a: { b: { c: { id_token: 'nested-id-secret' } } }, state: 'ready' })),
    },
  ]);
  assert.deepEqual(JSON.parse(session.response.body), { a: { b: { c: { id_token: '{token}' } } }, state: 'ready' });
  assert.ok(!session.response.body.includes('nested-id-secret'));
});

test('hidden credential inputs are redacted whatever the quoting, attribute order or letter case', () => {
  const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJkb20ifQ.ZG9tLXNpZ25hdHVyZS1zZWNyZXQ';
  const html = [
    `<input type='hidden' name='id_token' value='${jwt}'>`,
    `<input type=hidden name=id_token value=${jwt}>`,
    `<input value="${jwt}" name="id_token" type="hidden">`,
    `<INPUT TYPE='HIDDEN' NAME='session_state' VALUE='${jwt}'>`,
    '<input type="hidden" name="theme" value="dark">',
  ].join('');
  assert.equal(
    redactDomCredentials(html),
    [
      `<input type='hidden' name='id_token' value="{token}">`,
      `<input type=hidden name=id_token value="{token}">`,
      `<input value="{token}" name="id_token" type="hidden">`,
      `<INPUT TYPE='HIDDEN' NAME='session_state' VALUE="{token}">`,
      '<input type="hidden" name="theme" value="dark">',
    ].join(''),
  );
});

test('a 2 MB captured DOM with 20,000 hidden inputs redacts exactly its 10,000 credential inputs', () => {
  const pad = 'x'.repeat(50);
  const templates = [
    (name, value) => `<input type="hidden" name="${name}" value="${value}" data-pad="${pad}">`,
    (name, value) => `<input type='hidden' name='${name}' value='${value}' data-pad='${pad}'>`,
    (name, value) => `<input data-pad=${pad} value=${value} name=${name} type=hidden>`,
  ];
  const inputs = [];
  for (let index = 0; index < 20000; index++) {
    const credential = index % 2 === 0;
    inputs.push(templates[index % 3](credential ? 'id_token' : 'theme', credential ? `credential-${index}` : 'dark'));
  }
  const html = inputs.join('\n');
  assert.ok(html.length >= 2_000_000, `fixture is ${html.length} characters`);
  const redacted = redactDomCredentials(html);
  assert.equal(redacted.split('{token}').length - 1, 10000);
  assert.equal(redacted.split('dark').length - 1, 10000);
  assert.ok(!redacted.includes('credential-'));
});

test('20,000 unclosed input fragments with no closing bracket anywhere come back unchanged', () => {
  const html = '<input name=id_token value=x'.repeat(20000);
  assert.equal(redactDomCredentials(html), html);
});

test('a credential input whose quoted value holds a bracket is redacted up to its real closing bracket', () => {
  assert.equal(
    redactDomCredentials(
      `<input type="hidden" name="id_token" value="a>b"><input type="hidden" name="theme" value="c>d">`,
    ),
    `<input type="hidden" name="id_token" value="{token}"><input type="hidden" name="theme" value="c>d">`,
  );
  assert.equal(
    redactDomCredentials(
      `<input type='hidden' name='id_token' value='a>b'><input value='x>y' type=hidden name=id_token>`,
    ),
    `<input type='hidden' name='id_token' value="{token}"><input value="{token}" type=hidden name=id_token>`,
  );
});

test('a stray quoted input in script text does not stop the redaction of the hidden credential inputs after it', () => {
  const html = `<script>var t = '<input value="';</script><input type="hidden" name="id_token" value="SECRET1"><input type="hidden" name="state" value="SECRET2">`;
  const redacted = redactDomCredentials(html);
  assert.ok(!redacted.includes('SECRET1'), redacted);
  assert.ok(!redacted.includes('SECRET2'), redacted);
});

test('an input whose unclosed quote runs into a later input does not hide the credential of that later input', () => {
  const redacted = redactDomCredentials(
    `<p>x</p><input name=a value="1><input type="hidden" name="id_token" value="SECRET1">`,
  );
  assert.ok(!redacted.includes('SECRET1'), redacted);
  const nested = redactDomCredentials(`<input value="<input type="hidden" name="id_token" value="SECRET3">`);
  assert.ok(!nested.includes('SECRET3'), nested);
});

test('a 200 KB run of unclosed input fragments before a credential input redacts that credential input', () => {
  const fragments = '<input value="'.repeat(14000);
  const tail = '<input type="hidden" name="id_token" value="SECRET-TAIL">';
  assert.equal(
    redactDomCredentials(fragments + tail),
    fragments + '<input type="hidden" name="id_token" value="{token}">',
  );
});

test("a hidden credential input is redacted when another attribute's value contains name= or value=", () => {
  const cases = [
    [
      '<input title=" value=x" type="hidden" name="id_token" value="SECRET1">',
      '<input title=" value=x" type="hidden" name="id_token" value="{token}">',
    ],
    [
      '<input data-a=" name=foo" type="hidden" name="id_token" value="SECRET2">',
      '<input data-a=" name=foo" type="hidden" name="id_token" value="{token}">',
    ],
    [
      "<input title=' value=x' type='hidden' name='id_token' value='SECRET3'>",
      "<input title=' value=x' type='hidden' name='id_token' value=\"{token}\">",
    ],
    ['<input value="SECRET4" type="hidden" name="id_token">', '<input value="{token}" type="hidden" name="id_token">'],
    ['<input type=hidden name=id_token value=SECRET5>', '<input type=hidden name=id_token value="{token}">'],
    ['<INPUT TYPE=HIDDEN NAME=id_token VALUE="SECRET6">', '<INPUT TYPE=HIDDEN NAME=id_token VALUE="{token}">'],
    // Duplicate attributes: the first name wins (as in HTML), so this input is named x, is not a credential input and keeps its value.
    [
      '<input type="hidden" name="x" name="id_token" value="SECRET7">',
      '<input type="hidden" name="x" name="id_token" value="SECRET7">',
    ],
  ];
  const neighbour = '<input type="text" name="query" value="visible-text">';
  const redacted = redactDomCredentials(cases.map(([html]) => html).join('') + neighbour);
  assert.ok(!/SECRET[1-6]\b/.test(redacted), redacted);
  assert.equal(redacted, cases.map(([, expected]) => expected).join('') + neighbour);
});

test('a truncated trailing credential input is redacted to the end of the text', () => {
  assert.equal(
    redactDomCredentials('<p>x</p><input type="hidden" name="id_token" value="SECRET8'),
    '<p>x</p><input type="hidden" name="id_token" value="{token}"',
  );
  assert.equal(
    redactDomCredentials("<p>x</p><input type='hidden' name='id_token' value='SECRET9"),
    "<p>x</p><input type='hidden' name='id_token' value=\"{token}\"",
  );
  assert.equal(
    redactDomCredentials('<p>x</p><input type=hidden name=id_token value=SECRET10'),
    '<p>x</p><input type=hidden name=id_token value="{token}"',
  );
  // The unclosed quote ends at the next input, which is then handled by its own rule.
  assert.equal(
    redactDomCredentials(
      '<input type="hidden" name="id_token" value="SECRET11<input type="text" name="q" value="visible">',
    ),
    '<input type="hidden" name="id_token" value="{token}"<input type="text" name="q" value="visible">',
  );
  assert.equal(
    redactDomCredentials(
      '<input type="hidden" name="id_token" value="SECRET12<input type="hidden" name="id_token" value="SECRET13">',
    ),
    '<input type="hidden" name="id_token" value="{token}"<input type="hidden" name="id_token" value="{token}">',
  );
});

test('5,000 repeated truncated credential openers keep their exact shape', () => {
  const opener = '<input type="hidden" name="id_token" value="SECRET14';
  assert.equal(
    redactDomCredentials(opener.repeat(5000)),
    '<input type="hidden" name="id_token" value="{token}"'.repeat(5000),
  );
});
