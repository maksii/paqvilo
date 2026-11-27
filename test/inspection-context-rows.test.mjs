// @test-kind contract: Paqvilo's own selection-evidence design: the templates that included an element are named rows with their file, line and source actions, component parts and limits are said in words
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveInspectionEvidence } from '../lense/inspection-evidence.mjs';
import { renderInspectionEvidence } from '../lense/inspection-evidence-ui.mjs';

const scope = { documentId: 'document-1', frameId: 'top', uiEpoch: 1, sourceRevision: 'revision-1' };
const ref = (id, name, file) => ({
  id,
  key: 'key-' + id,
  sourceKey: 'key-' + id,
  kind: 'webtemplate',
  name,
  ref: file,
  sourceRevision: 'revision-1',
  contentRevision: 'content-' + id,
});
const invocation = (id, sourceRefId, region) => ({
  id,
  scope,
  dimension: 'context',
  kind: 'render-invocation',
  subject: 'node-1',
  predicate: 'declares',
  sourceRefIds: [sourceRefId],
  region,
  renderSourceRevision: 'revision-1',
});
const evidenceOf = (facts, refs) =>
  resolveInspectionEvidence({ version: 1, scope, mode: 'local', node: { connected: true }, facts, sourceRefs: refs });

test('several templates that included an element stay one row each, innermost first, with file and line', () => {
  const refs = [
    ref('inner', 'Invented card', 'web-templates/card.html'),
    ref('outer', 'Invented layout', 'web-templates/layout.html'),
  ];
  const evidence = evidenceOf(
    [
      invocation('context-0', 'inner', { start: 40, end: 70, line: 3 }),
      invocation('context-1', 'outer', { start: 120, end: 150, line: 12 }),
      // The same template at the same place, reported again for another region of the element: one row.
      invocation('context-2', 'inner', { start: 40, end: 70, line: 3 }),
    ],
    refs,
  );
  // The label is the same for both: before, they collapsed into one row that named no file.
  assert.deepEqual(
    evidence.facts.map((row) => [row.label, row.refs.map((item) => item.ref), row.region.line]),
    [
      ['Included by this template', ['web-templates/card.html'], 3],
      ['Included by this template', ['web-templates/layout.html'], 12],
    ],
  );
  const html = renderInspectionEvidence(evidence, { context: 'panel', openGroups: ['context'] });
  const context = html.slice(html.indexOf('data-evidence-role="context"'));
  const names = [...context.matchAll(/data-evidence-context[^>]*>.*?<div class="name"><span>([^<]+)<\/span>/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(names, ['Invented card', 'Invented layout']);
  assert.match(context, /<span class="what">Web template<\/span>/);
  assert.match(context, /Included by this template · line 3/);
  assert.match(context, /Included by this template · line 12/);
  assert.match(context, /<bdi>web-templates\/layout\.html<\/bdi>/);
  // The same open and copy buttons as a source row, named for their row.
  assert.match(
    context,
    /data-act="open" data-rel="web-templates\/card\.html"[^>]*aria-label="Open Invented card in the editor"/,
  );
  assert.match(context, /aria-label="Copy the source reference of Invented layout"/);
  assert.match(context, /data-source-region="\{&quot;start&quot;:120,&quot;end&quot;:150,&quot;line&quot;:12\}"/);
  // Each row has its own state, said in words.
  assert.equal([...context.matchAll(/class="c [a-z]+ ie-state"/g)].length, 2);
});

// @test-kind contract: a script frame that called the script that created an element is a context row with its file, line and open action
test('a caller frame of a script that created the element shows its file and line and opens it', () => {
  const refs = [ref('caller', 'Invented loader.js', 'web-files/loader.js')];
  // As lense/dom-provenance-transport.mjs makes it: a context fact of a proven frame, without a component.
  const caller = {
    id: 'dom:7:called-from:2',
    scope,
    dimension: 'context',
    proof: 'observed-dom-callsite',
    predicate: 'called-from',
    label: 'Called from this script',
    sourceRefIds: ['caller'],
    region: { start: 210, end: 240, line: 9, column: 5 },
    renderSourceRevision: 'revision-1',
  };
  const evidence = resolveInspectionEvidence({
    version: 1,
    scope,
    mode: 'live',
    node: { connected: true },
    facts: [caller],
    sourceRefs: refs,
  });
  assert.deepEqual(
    evidence.facts.map((row) => [row.status, row.label, row.refs?.map((item) => item.ref), row.region?.line]),
    [['exact', 'Called from this script', ['web-files/loader.js'], 9]],
  );
  const html = renderInspectionEvidence(evidence, { context: 'panel', openGroups: ['context'] });
  const context = html.slice(html.indexOf('data-evidence-role="context"'));
  assert.match(context, /Called from this script · line 9/);
  assert.match(context, /<bdi>web-files\/loader\.js<\/bdi>/);
  assert.match(
    context,
    /data-act="open" data-rel="web-files\/loader\.js"[^>]*aria-label="Open Invented loader\.js in the editor"/,
  );
  assert.match(
    context,
    /data-source-region="\{&quot;start&quot;:210,&quot;end&quot;:240,&quot;line&quot;:9,&quot;column&quot;:5\}"/,
  );
});

test('a context with a component is still named once by its component', () => {
  const evidence = evidenceOf(
    [
      { ...invocation('a', 'inner'), binding: { kind: 'table', key: 'table:inv_entry', entity: 'inv_entry' } },
      { ...invocation('b', 'outer'), binding: { kind: 'table', key: 'table:inv_entry', entity: 'inv_entry' } },
    ],
    [ref('inner', 'Invented card', 'card.html'), ref('outer', 'Invented layout', 'layout.html')],
  );
  assert.equal(evidence.facts.length, 1);
  assert.equal(evidence.facts[0].refs, undefined);
});

test('component parts read as words and a generated source row shows its line', () => {
  const base = evidenceOf([], []);
  const html = renderInspectionEvidence(
    {
      ...base,
      owner: {
        status: 'exact',
        component: { kind: 'basic-form', key: 'basic-form:inv-form#validation-summary', name: 'validation-summary' },
        evidence: [],
      },
      enclosing: [
        {
          status: 'exact',
          relationship: 'contains',
          component: { kind: 'list', key: 'list:inv-list#action:create', name: 'action:create' },
          refs: [],
        },
      ],
      source: {
        status: 'exact',
        refs: [
          {
            ...ref('generator', 'Invented page', 'web-templates/page.html'),
            status: 'exact',
            region: { start: 5, end: 30, line: 7 },
            evidenceLabel: 'Generated by this Liquid code',
          },
        ],
      },
    },
    { context: 'panel' },
  );
  assert.match(html, /<span>validation summary<\/span><span class="what">Basic form<\/span>/);
  assert.match(html, /<span>action: create<\/span><span class="what">List<\/span>/);
  assert.doesNotMatch(html.replaceAll(/data-[a-z-]+="[^"]*"/g, ''), /validation-summary|action:create/);
  assert.match(html, /data-source-identity title="Line 7">Line 7</);
  assert.match(html, /Generated by this Liquid code/);
});

test('search limits say what was cut when the reason is known, and keep the general line otherwise', () => {
  const evidence = evidenceOf([], []);
  const known = renderInspectionEvidence({
    ...evidence,
    limits: { truncated: true, reasons: ['export-source-hint-index-truncated'] },
  });
  assert.match(
    known,
    /<div class="banner">Your sources were searched in part: some files are too large or name too many elements\.<\/div>/,
  );
  assert.doesNotMatch(known, /Not all matches are shown/);
  const unknown = renderInspectionEvidence({ ...evidence, limits: { truncated: true, reasons: ['root-scan-budget'] } });
  assert.match(unknown, /<div class="banner">Not all matches are shown\.<\/div>/);
});

// @test-kind contract: every reason a DOM or response proof gives for not naming an element is said in a plain sentence
test('DOM and served-page proof limits each say in words what was not read', () => {
  const evidence = evidenceOf([], []);
  const said = (reason, truncated = true) =>
    renderInspectionEvidence({ ...evidence, limits: { truncated, reasons: [reason] } }).replaceAll(/<[^>]+>/g, ' ');
  for (const [reason, words] of [
    ['dom-evidence-limit', /how this one was made was not recorded\. Reload the page/],
    ['dom-evidence-transport-limit', /how this element was made was not read\. Reload the page/],
    ['dom-observation-failed', /could not watch the scripts of this page/],
    ['script-provenance-limit', /whether a script made this one is not known/],
    ['response-proof-too-large', /too large to compare with your sources/],
    ['response-proof-incomplete', /Only the first part of the page the portal sent was compared/],
    ['sign-in-page-untouched', /This is a sign-in page: Lense leaves it exactly as the portal sends it/],
  ]) {
    const html = said(reason);
    assert.match(html, words, reason);
    assert.doesNotMatch(html, /Not all matches are shown/, reason);
    assert.doesNotMatch(html, new RegExp(reason), 'the code itself is not shown: ' + reason);
  }
  // Not a search limit: the script matched several files.
  assert.match(said('script-hash-conflict', false), /same as several of your files, so none of them is named/);
});
