import test from 'node:test';
import assert from 'node:assert/strict';
import { renderInspectionEvidence } from '../lense/inspection-evidence-ui.mjs';

const evidence = (sourceStatus = 'exact') => ({
  version: 1,
  owner: { status: 'exact', component: { kind: 'form', name: 'Invented form' }, evidence: [{ kind: 'rendered-id' }] },
  source: {
    status: sourceStatus,
    refs: [
      {
        name: 'Invented source',
        kind: 'script',
        ref: 'invented.js',
        key: 'synthetic-key',
        sourceRevision: 'source-1',
        contentRevision: 'content-1',
        region: { start: 4, end: 8 },
        observations: { served: 'observed', executed: 'unavailable' },
      },
    ],
  },
  enclosing: [],
  facts: [],
  candidates: [],
  conflicts: [],
  unavailable: [],
  limits: { truncated: false },
});

test('shared summary keeps exact ownership independent of stale source and disables stale exact actions', () => {
  const input = evidence('stale');
  input.source.refs[0].status = 'exact';
  const html = renderInspectionEvidence(input);
  assert.match(html, /data-owner-status="exact" data-source-status="stale"/);
  assert.match(html, /disabled[^>]*>Open source/);
  assert.equal((html.match(/data-evidence-role=/g) ?? []).length, 6);
  assert.match(html, /Served · Execution not observed/);
  assert.doesNotMatch(html, /Execution observed/);
});

test('candidate source actions are explicit and carry both revisions and exact requested region in both UIs', () => {
  const input = evidence('candidate');
  for (const context of ['panel', 'xray']) {
    const html = renderInspectionEvidence(input, { context });
    assert.match(
      html,
      /data-source-key="synthetic-key" data-source-revision="source-1" data-content-revision="content-1"/,
    );
    assert.match(html, /data-source-region="\{&quot;start&quot;:4,&quot;end&quot;:8\}"/);
    assert.match(html, /data-focus-key="evidence-source-synthetic-key-open"[^>]*>Open candidate/);
    assert.match(
      html,
      context === 'panel' ? /data-act="open" data-rel="invented.js"/ : /data-action="open" data-ref="invented.js"/,
    );
    assert.doesNotMatch(html, /disabled[^>]*>Open candidate/);
  }
});

test('the field hierarchy is visible before source actions and keeps explicit form, table, basic-form and webpage roles', () => {
  const input = evidence();
  input.owner.component = { kind: 'column', name: 'Title', entity: 'sample_entry' };
  input.enclosing = [
    ['form', 'Entry form'],
    ['table', 'Entry'],
    ['basic-form', 'Portal editor'],
    ['webpage', 'Host page'],
  ].map(([kind, name]) => ({ component: { kind, key: kind, name }, status: 'exact', relationship: 'contains' }));
  for (const context of ['panel', 'xray']) {
    const html = renderInspectionEvidence(input, { context });
    assert.deepEqual(
      [...html.matchAll(/data-hierarchy-kind="([^"]+)"/g)].map((match) => match[1]),
      ['column', 'form', 'table', 'basic-form', 'webpage'],
    );
    assert.match(html, /data-disclosure="evidence-enclosing" open/);
    assert.ok(html.indexOf('Host page') < html.indexOf('data-evidence-role="source"'));
  }
});

test('unverified, conflicting and unavailable refs cannot open through the legacy path fallback', () => {
  for (const certainty of ['conflicting', 'unavailable'])
    assert.match(renderInspectionEvidence(evidence(certainty)), /disabled[^>]*>Open source/);
  const input = evidence();
  delete input.source.refs[0].contentRevision;
  assert.match(renderInspectionEvidence(input), /disabled[^>]*>Open source/);
  assert.match(
    renderInspectionEvidence({ ...input, version: 2 }),
    /data-owner-status="unavailable" data-source-status="unavailable"/,
  );
});

test('the serialized renderer escapes metadata and exposes truncation without confidence scores or owner promotion', () => {
  const render = new Function(`return (${renderInspectionEvidence.toString()})`)();
  const input = evidence();
  input.owner.component.name = '<img src=x onerror="invented()">';
  input.source.refs[0].ref = 'invented" data-act="unsafe';
  input.candidates = [{ component: { name: 'Alternative' }, reason: 'Shared selector', score: 0.99 }];
  input.limits = { truncated: true, reasons: ['Root scan budget'] };
  const html = render(input, { context: 'panel' });
  assert.doesNotMatch(html, /<img|data-act="unsafe"|99%|0\.99/);
  assert.match(html, /&lt;img/);
  assert.match(html, /Search limited; more matches may exist/);
  assert.match(html, /data-disclosure="evidence-alternatives"/);
  assert.match(render(null, { part: 'styles' }), /\.inspection-evidence summary:focus-visible/);
});

test('limits remain visible in the summary and omitted sources stay distinct from selected attribution', () => {
  const input = evidence();
  input.limits = {
    truncated: true,
    omitted: { candidates: 15, markupSources: 1 },
    sources: [{ ref: 'templates/large<source>.html', reason: 'Oversized source omitted; not attributed' }],
  };
  const html = renderInspectionEvidence(input);
  assert.match(html, /<summary[^>]*>Limits & freshness · Search limited · 16 omitted<\/summary>/);
  assert.match(html, /Index omissions; not attributed to the selected element/);
  assert.match(html, /templates\/large&lt;source&gt;\.html/);
  assert.match(html, /data-owner-status="exact" data-source-status="exact"/);
});

test('direct current source precedes alternatives and historical refs without promoting them', () => {
  const input = evidence();
  input.source.refs.unshift({ ...input.source.refs[0], name: 'Alternative source', status: 'candidate' });
  input.source.refs.unshift({ ...input.source.refs[0], name: 'Historical source', status: 'stale' });
  const html = renderInspectionEvidence(input);
  assert.ok(html.indexOf('Invented source') < html.indexOf('Alternative source'));
  assert.ok(html.indexOf('Alternative source') < html.indexOf('Historical source'));
  assert.match(html, /Historical source<\/strong><span[^>]*data-status="stale"/);
});

test('compact panel summary keeps the selected source reference visible independently of scrolled details', () => {
  const input = evidence('stale');
  input.source.refs[0].fieldPath = ['value'];
  input.source.refs.unshift({ ...input.source.refs[0], ref: 'historical.html', status: 'unavailable' });
  input.source.refs[1].status = 'exact';
  const html = renderInspectionEvidence(input, { part: 'headline', context: 'panel' });
  assert.match(html, /Local source<span[^>]*data-status="stale"/);
  assert.match(html, /data-evidence-source-context[^>]*>invented.js · Field: value · \+1 references/);
  assert.doesNotMatch(html, /historical.html|data-act=|data-action=/);
  assert.doesNotMatch(renderInspectionEvidence(input, { part: 'headline' }), /data-evidence-source-context/);
});
