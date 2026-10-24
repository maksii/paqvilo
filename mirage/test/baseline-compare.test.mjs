import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseFragment } from 'parse5';
import {
  compareRequests,
  diffDom,
  compareElements,
  compareConsole,
  compareScenario,
  loadAllowlist,
  summarize,
  summaryMarkdown,
  normalizeGeneratedIds,
} from '../baseline-compare.mjs';
import { validateMatrix, scenarioDir, captureMatrix } from '../baseline-suite.mjs';

const req = (seq, url, extra = {}) => ({
  seq,
  method: 'GET',
  url,
  resourceType: 'fetch',
  headers: { accept: '*/*' },
  body: null,
  response: { status: 200, headers: { 'content-type': 'application/json' }, body: '{}' },
  ...extra,
});

test('request alignment reports presence deltas in order', () => {
  const live = [req(1, 'https://p.invalid/a'), req(2, 'https://p.invalid/b'), req(3, 'https://p.invalid/c')];
  const mirage = [req(1, 'https://p.invalid/a'), req(2, 'https://p.invalid/c'), req(3, 'https://p.invalid/d')];
  const out = compareRequests(live, mirage);
  assert.deepEqual(
    out.map((d) => [d.field, d.location, d.live, d.mirage]),
    [
      ['presence', '#2 GET https://p.invalid/b', 'present', '(absent)'],
      ['presence', '#3 GET https://p.invalid/d', '(absent)', 'present'],
    ],
  );
});

test('paired requests report query, header, body and status differences; bodies are canonicalised', () => {
  const json = { 'content-type': 'application/json' };
  const form = { 'content-type': 'application/x-www-form-urlencoded' };
  const live = [
    req(1, 'https://p.invalid/q?x=1', { headers: { accept: 'a' } }),
    req(2, 'https://p.invalid/j', {
      method: 'POST',
      headers: json,
      body: '{"a":1,"b":[1,2]}',
      response: { status: 200, headers: json, body: '{"v":1,"w":2}' },
    }),
    req(3, 'https://p.invalid/f', {
      method: 'POST',
      headers: form,
      body: 'b=2&a=1',
      response: { status: 204, headers: {}, body: null },
    }),
    req(4, 'https://p.invalid/g', { method: 'POST', headers: form, body: 'a=1' }),
  ];
  const mirage = [
    req(1, 'https://p.invalid/q?x=2', { headers: { accept: 'b' } }),
    req(2, 'https://p.invalid/j', {
      method: 'POST',
      headers: json,
      body: '{"b":[1,2],"a":1}',
      response: { status: 200, headers: json, body: '{"w":2,"v":3}' },
    }),
    req(3, 'https://p.invalid/f', {
      method: 'POST',
      headers: form,
      body: 'a=1&b=2',
      response: { status: 204, headers: {}, body: null },
    }),
    req(4, 'https://p.invalid/g', {
      method: 'POST',
      headers: form,
      body: 'a=2',
      response: { status: 500, headers: json, body: '{}' },
    }),
  ];
  const fields = compareRequests(live, mirage).map((d) => `${d.scope}:${d.location.split(' ')[0]}:${d.field}`);
  assert.deepEqual(
    fields.sort(),
    [
      'request:#1/1:headers.accept',
      'request:#1/1:query',
      'request:#4/4:body.a[0]',
      'response:#2/2:body.v',
      'response:#4/4:status',
    ].sort(),
  );
});

test('DOM diff reports tag, attribute, class, text and children deltas and ignores nonce', () => {
  const a = parseFragment('<div id="r" class="x  y" nonce="1" title="t"><p>Hi</p><span>s</span></div>');
  const b = parseFragment('<div id="r" class="y x" nonce="2" title="u"><p>Bye</p><b>s</b><i></i></div>');
  const out = diffDom(a, b, []);
  assert.deepEqual(out.map((d) => d.field).sort(), ['attr.title', 'children.length', 'class', 'tag', 'text']);
  assert.equal(diffDom(parseFragment('<p nonce="a">x</p>'), parseFragment('<p nonce="b">x</p>'), []).length, 0);
});

test('element and console diffs', () => {
  const el = (selector, extra = {}) => ({
    selector,
    tag: 'input',
    classes: ['c'],
    attributes: { name: 'n' },
    visible: true,
    disabled: false,
    readonly: false,
    required: false,
    value: '',
    ...extra,
  });
  const out = compareElements(
    [el('#a'), el('#b'), el('#gone')],
    [el('#a', { disabled: true, classes: ['d'] }), el('#b', { attributes: { name: 'm' } }), el('#new')],
  );
  assert.deepEqual(out.map((d) => `${d.location}:${d.field}`).sort(), [
    '#a:classes',
    '#a:disabled',
    '#b:attributes.name',
    '#gone:presence',
    '#new:presence',
  ]);
  const cons = compareConsole(
    {
      console: [
        { type: 'error', text: 'boom' },
        { type: 'log', text: 'ignored' },
      ],
      pageErrors: ['e1'],
    },
    { console: [{ type: 'warning', text: 'w' }], pageErrors: [] },
  );
  assert.deepEqual(
    cons.map((d) => `${d.location}|${d.live}|${d.mirage}`),
    ['console|error: boom|(absent)', 'console|(absent)|warning: w', 'pageErrors|e1|(absent)'],
  );
});

async function writeFolder(
  dir,
  { status = 'captured', dom = '<html><head></head><body><h1>Hello</h1></body></html>' } = {},
) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'meta.json'),
    JSON.stringify({
      status,
      problems: status === 'captured' ? [] : ['x'],
      title: 'T',
      finalUrl: 'https://p.invalid/',
    }),
  );
  await fs.writeFile(path.join(dir, 'requests.json'), '[]');
  await fs.writeFile(path.join(dir, 'elements.json'), '[]');
  await fs.writeFile(path.join(dir, 'console.json'), JSON.stringify({ console: [], pageErrors: [] }));
  await fs.writeFile(path.join(dir, 'dom.html'), dom);
}

test('grid data Attributes arrays are compared by name, other arrays by position', () => {
  const body = (attrs, columns) => JSON.stringify({ Records: [{ Attributes: attrs }], Columns: columns });
  const request = (postData) => [
    {
      seq: 1,
      method: 'POST',
      url: 'https://a.test/_services/entity-grid-data.json/x',
      resourceType: 'xhr',
      headers: { 'content-type': 'application/json' },
      body: postData,
      response: { status: 200, headers: {}, body: null },
    },
  ];
  const same = compareRequests(
    request(
      body(
        [
          { Name: 'b', Value: 2 },
          { Name: 'a', Value: 1 },
        ],
        ['x', 'y'],
      ),
    ),
    request(
      body(
        [
          { Name: 'a', Value: 1 },
          { Name: 'b', Value: 2 },
        ],
        ['x', 'y'],
      ),
    ),
  );
  assert.deepEqual(
    same.filter((d) => d.field.startsWith('body')),
    [],
  );
  const valueChanged = compareRequests(
    request(body([{ Name: 'a', Value: 1 }], ['x'])),
    request(body([{ Name: 'a', Value: 9 }], ['x'])),
  );
  assert.deepEqual(
    valueChanged.filter((d) => d.field.startsWith('body')).map((d) => d.field),
    ['body.Records[0].Attributes.a.Value'],
  );
  const columnsReordered = compareRequests(request(body([], ['x', 'y'])), request(body([], ['y', 'x'])));
  assert.equal(columnsReordered.filter((d) => d.field.startsWith('body')).length, 2);
});

test('compareScenario verdicts, allowlist classification, second-live variance and summaries', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-baseline-compare-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const scenario = { id: 'area/page' };
  const dir = (name) => path.join(root, name);
  const changed = '<html><head></head><body><h1>Changed</h1></body></html>';
  await writeFolder(dir('live'));
  await writeFolder(dir('same'));
  await writeFolder(dir('changed'), { dom: changed });
  await writeFolder(dir('live-2'), { dom: changed });
  await writeFolder(dir('broken'), { status: 'failed' });
  const allowFile = dir('allow.json');
  await fs.writeFile(
    allowFile,
    JSON.stringify({
      version: 1,
      entries: [
        {
          id: 'heading',
          scope: 'dom',
          pattern: 'h1',
          field: '^text$',
          reason: 'invented',
          proof: 'live-run-variance',
          evidence: 'fixture',
        },
      ],
    }),
  );
  const allowlist = await loadAllowlist(allowFile);
  const none = { entries: [] };

  const pass = await compareScenario({ scenario, liveDir: dir('live'), mirageDir: dir('same'), allowlist: none });
  assert.equal(pass.verdict, 'PASS');
  const fail = await compareScenario({ scenario, liveDir: dir('live'), mirageDir: dir('changed'), allowlist: none });
  assert.equal(fail.verdict, 'FAIL');
  assert.deepEqual(
    fail.deltas.map((d) => [d.scope, d.field, d.live, d.mirage]),
    [['dom', 'text', 'Hello', 'Changed']],
  );
  assert.equal(fail.signatures.length, 1);
  const allowedResult = await compareScenario({ scenario, liveDir: dir('live'), mirageDir: dir('changed'), allowlist });
  assert.equal(allowedResult.verdict, 'ALLOWED');
  assert.equal(allowedResult.deltas[0].allowlist, 'heading');
  // A value pattern narrows an entry to the values it names: "Changed" is allowed, another text is not.
  const valueFile = dir('allow-value.json');
  const valueEntry = {
    id: 'heading-value',
    scope: 'dom',
    pattern: 'h1',
    field: '^text$',
    value: '^Chang',
    reason: 'invented',
    proof: 'live-run-variance',
    evidence: 'fixture',
  };
  await fs.writeFile(valueFile, JSON.stringify({ version: 1, entries: [valueEntry] }));
  const valued = await loadAllowlist(valueFile);
  assert.equal(
    (await compareScenario({ scenario, liveDir: dir('live'), mirageDir: dir('changed'), allowlist: valued })).verdict,
    'ALLOWED',
  );
  await writeFolder(dir('other'), { dom: changed.replace('Changed', 'Other') });
  assert.equal(
    (await compareScenario({ scenario, liveDir: dir('live'), mirageDir: dir('other'), allowlist: valued })).verdict,
    'FAIL',
  );
  await fs.writeFile(valueFile, JSON.stringify({ version: 1, entries: [{ ...valueEntry, value: '' }] }));
  await assert.rejects(loadAllowlist(valueFile), /empty value pattern/);
  // With a second live capture, a live-run-variance entry explains only deltas that capture varied on.
  await writeFolder(dir('live-same'));
  const unproven = await compareScenario({
    scenario,
    liveDir: dir('live'),
    mirageDir: dir('changed'),
    secondDir: dir('live-same'),
    allowlist,
  });
  assert.equal(unproven.verdict, 'FAIL');
  assert.equal(unproven.deltas[0].unprovenVariance, 'heading');
  const proven = await compareScenario({
    scenario,
    liveDir: dir('live'),
    mirageDir: dir('changed'),
    secondDir: dir('live-2'),
    allowlist,
  });
  assert.equal(proven.verdict, 'ALLOWED');
  const variance = await compareScenario({
    scenario,
    liveDir: dir('live'),
    mirageDir: dir('changed'),
    secondDir: dir('live-2'),
    allowlist: none,
  });
  assert.equal(variance.deltas[0].liveVariance, true);
  assert.equal(variance.variance.folder, 'live-2');
  assert.equal(fail.deltas[0].liveVariance, undefined);
  // The varying token sits in the element id and in a posted field name, and live-2 makes one request more,
  // so no delta key repeats between the captures: the proof is the entry witnessed in the same scenario.
  const form = { 'content-type': 'application/x-www-form-urlencoded' };
  const tokenFolder = async (name, token, extra = []) => {
    await writeFolder(dir(name), {
      dom: `<html><head></head><body><input id="frm_pref_${token}" name="frm_pref_${token}"><h1>Hello</h1></body></html>`,
    });
    const post = {
      seq: extra.length + 1,
      method: 'POST',
      url: 'https://p.invalid/form',
      resourceType: 'document',
      headers: form,
      body: `ctl00$frm_pref_${token}=&a=1`,
      response: { status: 200, headers: {}, body: null },
    };
    await fs.writeFile(path.join(dir(name), 'requests.json'), JSON.stringify([...extra, post]));
  };
  await tokenFolder('token-live', '6e6aa2f2');
  await tokenFolder('token-live-2', 'e63fac8b', [req(1, 'https://p.invalid/extra')]);
  await tokenFolder('token-mirage', '400fbd8d');
  await tokenFolder('token-same', '6e6aa2f2');
  const tokenFile = dir('allow-token.json');
  const tokenEntry = { reason: 'invented', proof: 'live-run-variance', evidence: 'fixture' };
  await fs.writeFile(
    tokenFile,
    JSON.stringify({
      version: 1,
      entries: [
        {
          ...tokenEntry,
          id: 'honeypot',
          scope: 'dom',
          pattern: 'input#frm_pref_[0-9a-f]{8}$',
          field: '^attr\\.(id|name)$',
        },
        {
          ...tokenEntry,
          id: 'honeypot-field',
          scope: 'request',
          pattern: 'POST .*/form$',
          field: '^body\\..*frm_pref_[0-9a-f]{8}',
        },
        { ...tokenEntry, id: 'unwitnessed', scope: 'dom', pattern: 'h9', field: '^text$' },
      ],
    }),
  );
  const tokens = await loadAllowlist(tokenFile);
  const witnessed = await compareScenario({
    scenario,
    liveDir: dir('token-live'),
    mirageDir: dir('token-mirage'),
    secondDir: dir('token-live-2'),
    allowlist: tokens,
  });
  assert.equal(witnessed.verdict, 'ALLOWED');
  assert.deepEqual(witnessed.variance.entries, ['honeypot', 'honeypot-field']);
  assert.deepEqual(witnessed.counts.variance, {
    entries: ['honeypot', 'honeypot-field'],
    matched: ['honeypot', 'honeypot-field'],
    unproven: {},
  });
  assert.ok(witnessed.deltas.some((d) => d.scope === 'request' && d.allowlist === 'honeypot-field' && !d.liveVariance));
  const notWitnessed = await compareScenario({
    scenario,
    liveDir: dir('token-live'),
    mirageDir: dir('token-mirage'),
    secondDir: dir('token-same'),
    allowlist: tokens,
  });
  assert.equal(notWitnessed.verdict, 'FAIL');
  assert.deepEqual(notWitnessed.variance.entries, []);
  assert.ok(notWitnessed.deltas.every((d) => d.unprovenVariance));
  const tokenReport = { generatedAt: '2026-01-01', scenarios: [witnessed, notWitnessed] };
  assert.deepEqual(summarize(tokenReport).variance, {
    honeypot: {
      paired: 2,
      witnessed: 1,
      unprovenScenarios: 1,
      unprovenDeltas: notWitnessed.counts.variance.unproven.honeypot,
    },
    'honeypot-field': {
      paired: 2,
      witnessed: 1,
      unprovenScenarios: 1,
      unprovenDeltas: notWitnessed.counts.variance.unproven['honeypot-field'],
    },
  });
  assert.match(summaryMarkdown({ ...tokenReport, ...summarize(tokenReport) }), /\| honeypot \| 2 \| 1 \| 1 \| \d+ \|/);
  // The address composite container's per-render GUID id is tokenised (by its class), also in CSS-escaped selectors.
  const addressFolder = async (name, id, selectorId) => {
    await writeFolder(dir(name), {
      dom: `<html><head></head><body><div id="${id}" class="content d-none addressCompositeControlContainer"><div>x</div></div><div id="a0000000-0000-4000-8000-000000000001">row</div></body></html>`,
    });
    const el = (selector) => ({
      selector,
      tag: 'div',
      classes: [],
      attributes: {},
      visible: false,
      disabled: false,
      readonly: false,
      required: false,
      value: '',
    });
    await fs.writeFile(
      path.join(dir(name), 'elements.json'),
      JSON.stringify([el(`div#${selectorId}`), el(`div#${selectorId}>div`)]),
    );
  };
  await addressFolder('address-live', 'e457bd14-4c55-4c12-974a-8b4b03f0a92f', 'e457bd14-4c55-4c12-974a-8b4b03f0a92f');
  await addressFolder(
    'address-mirage',
    '077f7854-970c-4296-893f-27841832ff24',
    '\\30 77f7854-970c-4296-893f-27841832ff24',
  );
  assert.equal(
    (
      await compareScenario({
        scenario,
        liveDir: dir('address-live'),
        mirageDir: dir('address-mirage'),
        allowlist: none,
      })
    ).verdict,
    'PASS',
  );
  // Other GUID ids (record ids) are not touched.
  await writeFolder(dir('address-other'), {
    dom: (await fs.readFile(path.join(dir('address-mirage'), 'dom.html'), 'utf8')).replace(
      'a0000000-0000-4000-8000-000000000001',
      'a0000000-0000-4000-8000-000000000002',
    ),
  });
  await fs.copyFile(
    path.join(dir('address-mirage'), 'elements.json'),
    path.join(dir('address-other'), 'elements.json'),
  );
  assert.deepEqual(
    (
      await compareScenario({
        scenario,
        liveDir: dir('address-live'),
        mirageDir: dir('address-other'),
        allowlist: none,
      })
    ).deltas.map((d) => d.field),
    ['attr.id'],
  );
  // Same-origin frame documents (frames.json) are diffed under "frame <path>"; a frame on one side only is a presence delta.
  const frameFolder = async (name, frames) => {
    await writeFolder(dir(name));
    if (frames) await fs.writeFile(path.join(dir(name), 'frames.json'), JSON.stringify(frames));
  };
  await frameFolder('frame-live', { '/inner': "<html><head></head><body><input id='n' value='a'></body></html>" });
  await frameFolder('frame-mirage', { '/inner': "<html><head></head><body><input id='n' value='b'></body></html>" });
  await frameFolder('frame-none');
  const framed = await compareScenario({
    scenario,
    liveDir: dir('frame-live'),
    mirageDir: dir('frame-mirage'),
    allowlist: none,
  });
  assert.deepEqual(
    framed.deltas.map((d) => [d.location, d.field, d.live, d.mirage]),
    [['frame /inner html:nth(0)>body:nth(1)>input#n', 'attr.value', 'a', 'b']],
  );
  const frameless = await compareScenario({
    scenario,
    liveDir: dir('frame-live'),
    mirageDir: dir('frame-none'),
    allowlist: none,
  });
  // An element entry applies inside a frame document too (its selector without the frame(<path>) prefix).
  const elementFile = dir('allow-element.json');
  await fs.writeFile(
    elementFile,
    JSON.stringify({
      version: 1,
      entries: [
        {
          id: 'cdn-link',
          scope: 'element',
          pattern: '^body>link$',
          field: '^attributes.href$',
          reason: 'invented',
          proof: 'platform-generated',
          evidence: 'fixture',
        },
      ],
    }),
  );
  const elementAllow = await loadAllowlist(elementFile);
  const el = (selector, href) => ({
    selector,
    tag: 'link',
    classes: [],
    attributes: { href },
    visible: false,
    disabled: false,
    readonly: false,
    required: false,
    value: '',
  });
  await writeFolder(dir('frame-el-live'));
  await writeFolder(dir('frame-el-mirage'));
  await fs.writeFile(
    path.join(dir('frame-el-live'), 'elements.json'),
    JSON.stringify([el('frame(/inner) body>link', 'https://cdn.invalid/a.css')]),
  );
  await fs.writeFile(
    path.join(dir('frame-el-mirage'), 'elements.json'),
    JSON.stringify([el('frame(/inner) body>link', '/a.css')]),
  );
  assert.equal(
    (
      await compareScenario({
        scenario,
        liveDir: dir('frame-el-live'),
        mirageDir: dir('frame-el-mirage'),
        allowlist: elementAllow,
      })
    ).verdict,
    'ALLOWED',
  );
  assert.deepEqual(
    frameless.deltas.map((d) => [d.location, d.field, d.live, d.mirage]),
    [['frame /inner', 'presence', 'present', '(absent)']],
  );
  const missing = await compareScenario({ scenario, liveDir: dir('live'), mirageDir: dir('nope'), allowlist: none });
  assert.equal(missing.verdict, 'error');
  assert.match(missing.reason, /mirage capture missing/);
  const unusable = await compareScenario({ scenario, liveDir: dir('live'), mirageDir: dir('broken'), allowlist: none });
  assert.match(unusable.reason, /not usable/);

  const entry = {
    id: 'x',
    scope: 'dom',
    pattern: 'a',
    field: 'b',
    reason: 'r',
    proof: 'platform-generated',
    evidence: 'e',
  };
  for (const [bad, message] of [
    [{ version: 2, entries: [] }, /version 1 with entries is required/],
    [{ version: 1, entries: [{ ...entry, reason: '' }] }, /lacks reason/],
    [{ version: 1, entries: [{ ...entry, proof: 'hunch' }] }, /needs proof/],
    [{ version: 1, entries: [{ ...entry, scope: 'page' }] }, /unknown scope/],
  ]) {
    await fs.writeFile(allowFile, JSON.stringify(bad));
    await assert.rejects(loadAllowlist(allowFile), message);
  }

  const report = {
    generatedAt: '2026-01-01',
    scenarios: [pass, fail, allowedResult, unusable].map((r, i) => ({ ...r, id: `s${i}` })),
  };
  Object.assign(report, summarize(report));
  assert.deepEqual(report.totals, { pass: 1, allowed: 1, fail: 1, error: 1 });
  assert.equal(report.bySignature[0].allowed, false);
  const md = summaryMarkdown(report);
  assert.match(md, /PASS 1 · ALLOWED 1 · FAIL 1 · ERROR 1/);
  assert.match(md, /\| s1 \| FAIL \| 1 \| 0 \| 1 \|/);
  assert.match(md, /\| dom \| text \|/);
});

test('validateMatrix accepts a good matrix and rejects invalid ones', () => {
  const good = () => ({
    version: 1,
    origin: 'https://portal.invalid',
    personas: { member: {} },
    writeScope: { paths: ['^/x$'] },
    scenarios: [
      { id: 'a/b', persona: 'member', steps: [{ goto: '/' }] },
      { id: 'c', steps: [{ goto: '/c' }] },
    ],
  });
  assert.equal(validateMatrix(good()).scenarios.length, 2);
  const mutate = (fn) => {
    const matrix = good();
    fn(matrix);
    return matrix;
  };
  assert.throws(() => validateMatrix(mutate((m) => (m.scenarios[1].id = 'a/b'))), /Duplicate/);
  assert.throws(() => validateMatrix(mutate((m) => (m.scenarios[0].persona = 'ghost'))), /unknown persona/);
  assert.throws(() => validateMatrix(mutate((m) => (m.scenarios[0].steps = []))), /needs steps/);
  assert.throws(() => validateMatrix(mutate((m) => delete m.scenarios[1].steps)), /needs steps/);
  assert.throws(() => validateMatrix(mutate((m) => (m.origin = 'http://portal.invalid'))), /HTTPS/);
  assert.throws(() => validateMatrix(mutate((m) => (m.origin = 'https://portal.invalid/path'))), /HTTPS/);
  assert.throws(() => validateMatrix({ version: 1, scenarios: [] }), /matrix with scenarios is required/);
  assert.equal(scenarioDir('/out', { id: 'a/b' }, 'live'), path.join('/out', 'a', 'b', 'live'));
});

test('captureMatrix switches personas only on change, honours reset:false and records side errors', async (t) => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-capture-matrix-'));
  t.after(() => fs.rm(outDir, { recursive: true, force: true }));
  const calls = [];
  const side = {
    persona: async (name) => calls.push(`persona:${name}`),
    reset: async () => calls.push('reset'),
    capture: async (scenario) => {
      calls.push(`capture:${scenario.id}`);
      if (scenario.id === 'bad') throw new Error('bridge down');
      return { status: 'captured', problems: [], requests: 2, elements: 3, blockedWrites: [{}] };
    },
    diagnostics: () => ['diag'],
    close: async () => {},
  };
  const matrix = {
    version: 1,
    personas: { m: {} },
    delayMs: 0,
    scenarios: [
      { id: 'one', steps: [{}] },
      { id: 'two', reset: false, steps: [{}] },
      { id: 'bad', persona: 'm', steps: [{}] },
      { id: 'skip', steps: [{}] },
    ],
  };
  const log = console.log;
  console.log = () => {};
  let results;
  try {
    results = await captureMatrix({ matrix, side, outDir, label: 'mirage', only: ['one', 'two', 'bad'] });
  } finally {
    console.log = log;
  }
  assert.deepEqual(calls, [
    'persona:anonymous',
    'reset',
    'capture:one',
    'capture:two',
    'persona:m',
    'reset',
    'capture:bad',
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    ['captured', 'captured', 'error'],
  );
  assert.equal(results[0].blockedWrites, 1);
  assert.deepEqual(results[2].problems, ['bridge down', 'diag']);
});

test('request-side x-sim-* headers are instrumentation and generated ids are normalised', () => {
  const req = (headers) => ({
    seq: 1,
    method: 'GET',
    url: '/a',
    resourceType: 'fetch',
    headers,
    response: { status: 200, headers: {} },
  });
  const out = compareRequests([req({ accept: '*/*' })], [req({ accept: '*/*', 'x-sim-parent-trace': 't' })]);
  assert.equal(out.length, 0);
  assert.equal(
    normalizeGeneratedIds(
      '<div id="PcfControl_4eb7269f8c084cd683f6361ce8864541"><div id="UpdMSPicklistControl7_outer">',
    ),
    '<div id="PcfControl_{hex32}"><div id="UpdMSPicklistControl{n}_outer">',
  );
  assert.equal(
    normalizeGeneratedIds(
      '<input name="x$ctl371" data-content-id="1e93654f-3bc1-4a1a-9b1e-0123456789ab"><a href="https://site.example/File/download.aspx?Id=1"><a href="http://127.0.0.1:5311/x">',
      ['https://site.example'],
    ),
    '<input name="x$ctl{n}" data-content-id="{guid}"><a href="{origin}/File/download.aspx?Id=1"><a href="{origin}/x">',
  );
});

test('--only lists take the first token per line and refuse an empty selection', async (t) => {
  const { list } = await import('../baseline-suite.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-only-list-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'ids.txt');
  await fs.writeFile(
    file,
    '# reviewed list: reason per id\r\n\r\nlist/a/default/editor\tthe reason\nbasic-form/b/x/editor  # another reason\n  page/c/render/editor\n',
  );
  assert.deepEqual(list(`@${file}`), ['list/a/default/editor', 'basic-form/b/x/editor', 'page/c/render/editor']);
  assert.deepEqual(list('a, b'), ['a', 'b']);
  assert.equal(list(undefined), null);
  await fs.writeFile(file, '# only a comment\n\n');
  assert.throws(() => list(`@${file}`), /selects no scenario ids/);
});

test('evidence age: deltas a recorded live change explains are stale until its proof scenario fails', async (t) => {
  const { loadEvidenceChanges, finalizeEvidenceChanges } = await import('../baseline-compare.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-evidence-age-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = async (name, capturedAt, title) => {
    const dir = path.join(root, name);
    await writeFolder(dir, {
      dom: `<html><head></head><body><h1 data-editable-title="${title}">Hello</h1></body></html>`,
    });
    const meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'));
    await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ ...meta, capturedAt }));
    return dir;
  };
  const file = path.join(root, 'changes.json');
  const change = {
    id: 'admin-removed',
    since: '2026-10-15T18:48:00Z',
    affects: '^page/',
    signatures: [{ scope: 'dom', field: '^attr.data-editable-title$', location: 'h1' }],
    proof: ['page/proof'],
    reason: 'invented',
  };
  await fs.writeFile(file, JSON.stringify({ version: 1, changes: [change] }));
  const { changes } = await loadEvidenceChanges(file);
  const none = { entries: [] };
  const compare = async (id, live, mirage) =>
    compareScenario({ scenario: { id }, liveDir: live, mirageDir: mirage, allowlist: none, changes });
  const mirage = await folder('mirage', '2026-10-15T20:00:00Z', '(none)');
  const old = await compare('page/old', await folder('old', '2026-10-15T12:00:00Z', 'Title'), mirage);
  assert.equal(old.verdict, 'ALLOWED');
  assert.deepEqual([old.counts.stale, old.counts.unexplained, old.deltas[0].staleEvidence], [1, 0, 'admin-removed']);
  // Outside `affects`, or captured after `since`, the same delta stays unexplained.
  assert.equal(
    (await compare('list/old', await folder('old2', '2026-10-15T12:00:00Z', 'Title'), mirage)).counts.unexplained,
    1,
  );
  const proofOk = await compare('page/proof', await folder('proof-ok', '2026-10-15T19:00:00Z', '(none)'), mirage);
  const accepted = finalizeEvidenceChanges([old, proofOk], changes);
  assert.equal(accepted['admin-removed'].status, 'accepted');
  assert.deepEqual([accepted['admin-removed'].scenarios, accepted['admin-removed'].deltas], [1, 1]);
  // The proof scenario still shows the signature: the change is rejected and its deltas are unexplained again.
  const old2 = await compare('page/old', await folder('old3', '2026-10-15T12:00:00Z', 'Title'), mirage);
  const proofBad = await compare('page/proof', await folder('proof-bad', '2026-10-15T19:00:00Z', 'Title'), mirage);
  const rejected = finalizeEvidenceChanges([old2, proofBad], changes);
  assert.equal(rejected['admin-removed'].status, 'rejected');
  assert.deepEqual(rejected['admin-removed'].proof, [{ id: 'page/proof', state: 'still shows the signature' }]);
  assert.deepEqual([old2.verdict, old2.counts.stale, old2.counts.unexplained], ['FAIL', 0, 1]);
  // A missing proof scenario or one captured before `since` rejects it too.
  assert.equal(
    finalizeEvidenceChanges(
      [await compare('page/old', await folder('old4', '2026-10-15T12:00:00Z', 'Title'), mirage)],
      changes,
    )['admin-removed'].proof[0].state,
    'missing',
  );
  const early = await compare('page/proof', await folder('proof-early', '2026-10-15T12:30:00Z', 'Title'), mirage);
  assert.equal(finalizeEvidenceChanges([early], changes)['admin-removed'].proof[0].state, 'older than since');
  // staleBefore: a capture after since but before staleBefore (a page still served from its cache) is stale too;
  // a proof captured in that window still has to be clean.
  await fs.writeFile(
    file,
    JSON.stringify({ version: 1, changes: [{ ...change, staleBefore: '2026-10-15T19:30:00Z' }] }),
  );
  const lagged = (await loadEvidenceChanges(file)).changes;
  const cached = await compareScenario({
    scenario: { id: 'page/cached' },
    liveDir: await folder('cached', '2026-10-15T19:10:00Z', 'Title'),
    mirageDir: mirage,
    allowlist: none,
    changes: lagged,
  });
  assert.equal(cached.counts.stale, 1);
  const cleanProof = await compareScenario({
    scenario: { id: 'page/proof' },
    liveDir: await folder('proof-window', '2026-10-15T19:00:00Z', '(none)'),
    mirageDir: mirage,
    allowlist: none,
    changes: lagged,
  });
  assert.equal(finalizeEvidenceChanges([cached, cleanProof], lagged)['admin-removed'].status, 'accepted');
  await fs.writeFile(
    file,
    JSON.stringify({ version: 1, changes: [{ ...change, staleBefore: '2026-10-15T18:00:00Z' }] }),
  );
  await assert.rejects(loadEvidenceChanges(file), /staleBefore/);
  await fs.writeFile(file, JSON.stringify({ version: 1, changes: [{ ...change, proof: [] }] }));
  await assert.rejects(loadEvidenceChanges(file), /needs proof/);
});

test('the evidence receiver ties each post to its run; a late post of an abandoned run is refused', async (t) => {
  const { startSaver } = await import('../baseline-suite.mjs');
  const { writeCapture } = await import('../baseline-capture.mjs');
  const saver = await startSaver();
  t.after(() => saver.close());
  const post = (run, body) =>
    fetch(saver.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-baseline-token': saver.token,
        ...(run ? { 'x-baseline-run': run } : {}),
      },
      body: JSON.stringify(body),
    });
  const first = saver.expect();
  const second = saver.expect(); // the first run timed out on the client; the next scenario armed its own wait
  assert.equal((await post(first.run, { summary: { id: 'step2-back' } })).status, 409);
  assert.equal((await post(null, { summary: { id: 'step2-back' } })).status, 409);
  assert.equal((await post(second.run, { summary: { id: 'resume' } })).status, 204);
  assert.deepEqual((await second.received).summary, { id: 'resume' });
  assert.deepEqual(
    saver.late.map((late) => late.run),
    [first.run, null],
  );
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-write-capture-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await assert.rejects(
    writeCapture(
      { summary: { id: 'step2-back' }, raw: {} },
      { outDir: dir, origin: 'https://p.invalid', side: 'live', scenarioId: 'resume' },
    ),
    /refused for scenario resume/,
  );
});

test('multipart postbacks compare their parts, not the random boundary', () => {
  const multipart = (boundary, name, file) => ({
    seq: 1,
    method: 'POST',
    url: 'https://p.invalid/form',
    resourceType: 'document',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: [
      `--${boundary}`,
      'Content-Disposition: form-data; name="title"',
      '',
      name,
      `--${boundary}`,
      `Content-Disposition: form-data; name="upload"; filename="${file}"`,
      'Content-Type: text/plain',
      '',
      'abc',
      `--${boundary}--`,
      '',
    ].join('\r\n'),
    response: { status: 200, headers: {}, body: null },
  });
  assert.deepEqual(compareRequests([multipart('----A1', 'x', 'a.txt')], [multipart('----B2', 'x', 'a.txt')]), []);
  // Server state fields are tokens in a multipart body too (the capture redacts them; older captures are compared as tokens).
  const withState = (boundary, state) => ({
    ...multipart(boundary, 'x', 'a.txt'),
    body: [
      `--${boundary}`,
      'Content-Disposition: form-data; name="__VIEWSTATE"',
      '',
      state,
      `--${boundary}--`,
      '',
    ].join('\r\n'),
  });
  assert.deepEqual(compareRequests([withState('----A1', 'abc')], [withState('----B2', 'xyz')]), []);
  assert.deepEqual(
    compareRequests([multipart('----A1', 'x', 'a.txt')], [multipart('----B2', 'y', 'b.txt')])
      .map((d) => d.field)
      .sort(),
    ['body.title[0]', 'body.upload[0]'],
  );
});

test('the capture redacts server state fields in multipart bodies as in urlencoded ones', async () => {
  const { redactTokens } = await import('../baseline-capture.mjs');
  const body = [
    '------B',
    'Content-Disposition: form-data; name="__VIEWSTATE"',
    '',
    'secretstate',
    '------B',
    'Content-Disposition: form-data; name="title"',
    '',
    'kept',
    '------B--',
  ].join('\r\n');
  const out = redactTokens(body);
  assert.match(out, /name="__VIEWSTATE"\r\n\r\n\{token\}/);
  assert.match(out, /name="title"\r\n\r\nkept/);
  assert.doesNotMatch(out, /secretstate/);
});
