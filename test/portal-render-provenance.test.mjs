import test from 'node:test';
import assert from 'node:assert/strict';
import { LiquidEngine, LiquidContext } from '../mirage/lib/liquid-engine.mjs';
import { createPortalRenderer } from '../mirage/lib/liquid.mjs';
import { createHash } from 'node:crypto';
import { parse } from 'parse5';
import { buildPortalSourceIndex } from '../mirage/lib/portal-source-index.mjs';
import { observedSnippetComposition } from '../mirage/lib/observed-snippet-composition.mjs';
import {
  createRenderTrace,
  createRenderBuffer,
  renderFragment,
  finalizePortalProvenance,
  withRenderSource,
  withRenderNode,
} from '../mirage/lib/render-provenance.mjs';

test('invocation context maps instrumented caller coordinates back to the actual authored source', async () => {
  const context = { provenance: createRenderTrace() };
  await withRenderSource(context, { id: 'caller', offsetMap: [{ start: 10, end: 30, sourceStart: 0 }] }, async () => {
    await withRenderNode(context, { start: 14, end: 20 }, 'derived', () =>
      withRenderSource(context, { id: 'child' }, async () => {}),
    );
    await withRenderNode(context, { start: 4, end: 14 }, 'derived', () =>
      withRenderSource(context, { id: 'unmapped-child' }, async () => {}),
    );
  });
  assert.deepEqual(context.provenance.invocations[1].callSite, { start: 4, end: 10 });
  assert.equal(
    context.provenance.invocations[2].callSite,
    null,
    'an instrumentation gap has no invented authored location',
  );
});

function fixture(definitions) {
  const templates = {};
  for (const [name, source] of Object.entries(definitions))
    templates[name] = { id: name, name, source, metadata: { id: name, kind: 'webtemplate', name } };
  return { sourceDir: null, templates, records: [], pages: [], snippets: {} };
}
async function trace(definitions, environment = {}) {
  const portal = fixture(definitions);
  const index = buildPortalSourceIndex({ portal });
  const engine = new LiquidEngine({
    filters: { replace: (s, a, b) => String(s).replaceAll(a, b), size: (s) => s.length },
    loadTemplateSource: (name) => definitions[name],
  });
  engine.templateSourceRef = (name) => index.templates.get(name.toLowerCase());
  const context = new LiquidContext(engine, { environment });
  context.provenance = createRenderTrace({ sourceRevision: index.sourceRevision });
  const buffer = createRenderBuffer(context);
  await engine.parse(definitions.Main, index.templates.get('main')).renderInto(context, buffer);
  const fragment = renderFragment(buffer);
  return { ...finalizePortalProvenance({ fragment, index }), fragment, trace: context.provenance, index, engine };
}
const names = (result) =>
  result.provenance.bindings
    .filter((binding) => binding.mapping === 'literal')
    .map((binding) => [binding.tag, result.index.sources.get(binding.sourceRefId).name]);

test('actual branches, dynamic includes and repeated invocations retain distinct source definitions', async () => {
  const result = await trace(
    {
      Main: `<main>{% if yes %}{% include choice %}{% else %}{% include 'Never' %}{% endif %}{% for n in (1..2) %}{% include 'Row' %}{% endfor %}</main>`,
      A: '<p>same</p>',
      B: '<p>same</p>',
      Never: '<aside>never</aside>',
      Row: '<i>row</i>',
    },
    { yes: true, choice: 'B' },
  );
  assert.deepEqual(names(result), [
    ['main', 'Main'],
    ['p', 'B'],
    ['i', 'Row'],
    ['i', 'Row'],
  ]);
  assert.equal(new Set(result.provenance.bindings.filter((b) => b.tag === 'i').map((b) => b.invocationId)).size, 2);
  assert.equal(
    result.engine.parse('<p>same</p>').root,
    result.engine.parse('<p>same</p>').root,
    'AST cache is shared without source identity mutation',
  );
});

test('capture comparisons, sizes and assigns preserve primitive semantics and unmodified origins', async () => {
  const result = await trace({
    Main: `{% capture value %}<p>yes</p>{% endcapture %}{% assign alias = value %}{% if value == '<p>yes</p>' %}<section>{{ alias }}</section>{% endif %}{{ value | size }}{{ value | replace: 'yes', 'YES' }}`,
  });
  assert.equal(result.fragment.text, '<section><p>yes</p></section>10<p>YES</p>');
  assert.deepEqual(
    names(result),
    [
      ['section', 'Main'],
      ['p', 'Main'],
    ],
    'filtered capture is derived, never fabricated as a literal span',
  );
  const paragraph = result.provenance.bindings.find((b) => b.tag === 'p');
  assert.equal(
    result.index.sources.get(paragraph.sourceRefId).text.slice(paragraph.region.start, paragraph.region.end),
    '<p>',
  );
});

test('raw/comment/whitespace control and mixed start tags are distinguished by actual output spans', async () => {
  const result = await trace(
    {
      Main: `{% comment %}<b>hidden</b>{% endcomment %}{% raw %}<p>{{ literal }}</p>{% endraw %}\n  {%- if yes -%}\n<div class="{{ cls }}">x</div><em>literal</em>{% endif %}`,
    },
    { yes: true, cls: 'x' },
  );
  assert.match(result.fragment.text, /<p>\{\{ literal \}\}<\/p>/);
  assert.deepEqual(names(result), [
    ['p', 'Main'],
    ['em', 'Main'],
  ]);
});

test('extends overrides and block.super retain their own source identities', async () => {
  const result = await trace({
    Main: `{% extends 'Layout' %}{% block body %}<b>child</b>{{ block.super }}{% endblock %}`,
    Layout: '<article>{% block body %}<i>parent</i>{% endblock %}</article>',
  });
  assert.deepEqual(names(result), [
    ['article', 'Layout'],
    ['b', 'Main'],
    ['i', 'Layout'],
  ]);
});

test('table parser repair does not invent authored implicit elements', async () => {
  const result = await trace({ Main: '<table><span>fostered</span><tr><td>cell</td></tr></table>' });
  assert.deepEqual(
    names(result).sort(),
    [
      ['span', 'Main'],
      ['table', 'Main'],
      ['td', 'Main'],
      ['tr', 'Main'],
    ].sort(),
  );
  assert.equal(
    result.provenance.bindings.some((b) => b.tag === 'tbody'),
    false,
  );
});

test('portal renderer traces actual named template output without a source-text identity search', async () => {
  const portal = fixture({ Main: `<article>{% include selected %}</article>`, A: '<p>same</p>', B: '<p>same</p>' });
  const renderer = createPortalRenderer(portal);
  const ref = renderer.sourceIndex().templates.get('main');
  const result = await renderer.renderStringWithProvenance(portal.templates.Main.source, { selected: 'B' }, ref);
  assert.equal(
    result.provenance.bindings.find((b) => b.tag === 'p').sourceRefId,
    renderer.sourceIndex().templates.get('b').id,
  );
  assert.equal(await renderer.renderString('{% capture x %}<i>x</i>{% endcapture %}{{ x | size }}'), '8');
});

test('inline script proofs hash actual Unicode bytes and map body-relative callsites without retaining bodies', async () => {
  const code = "const label='Ž🙂';\r\nwindow.invented=true;";
  const result = await trace({ Main: '<script>' + code + '</script>' });
  const proof = result.provenance.scriptProofs[0];
  const parsedCode = code.replace(/\r\n/g, '\n');
  assert.equal(proof.generatedHash, createHash('sha256').update(parsedCode).digest('hex'));
  assert.deepEqual(proof.lineStarts, [0, parsedCode.indexOf('window')]);
  const node = parse(result.html, { sourceCodeLocationInfo: true })
    .childNodes.find((node) => node.tagName === 'html')
    .childNodes.find((node) => node.tagName === 'head').childNodes[0];
  assert.deepEqual(proof.documentStart, {
    line: node.sourceCodeLocation.startTag.endLine - 1,
    column: node.sourceCodeLocation.startTag.endCol - 1,
  });
  for (const mapping of proof.mappings)
    assert.equal(
      result.index.sources.get(mapping.sourceRefId).text.slice(mapping.sourceStart, mapping.sourceEnd),
      parsedCode.slice(mapping.generatedStart, mapping.generatedEnd),
    );
  assert.doesNotMatch(JSON.stringify(result.provenance), /const label|window\.invented/);
});

test('filtered script-producing strings never invent an executable source mapping', async () => {
  const result = await trace({
    Main: `{% capture code %}<script>window.a=true;</script>{% endcapture %}{{ code | replace: 'a=true', 'a=false' }}`,
  });
  assert.equal(result.provenance.scriptProofs.length, 0);
});

test('case-sensitive exact names and case-insensitive fallback retain the actually selected identical definition', async () => {
  const mainSource = `{% include 'Card' %}{% include 'card' %}{{ snippets['Banner'] }}{{ snippets['banner'] }}{{ snippets['BANNER'] }}`;
  const template = (id, name, source) => ({ id, name, source, metadata: { id, name, kind: 'webtemplate' } });
  const portal = {
    sourceDir: null,
    website: {},
    pages: [],
    templates: {
      Main: template('main', 'Main', mainSource),
      Card: template('card-upper', 'Card', '<p>same</p>'),
      card: template('card-lower', 'card', '<p>same</p>'),
    },
    snippets: { Banner: '<i>same</i>', banner: '<i>same</i>' },
    records: [
      { kind: 'contentsnippet', id: 'snippet-upper', name: 'Banner', value: '<i>same</i>' },
      { kind: 'contentsnippet', id: 'snippet-lower', name: 'banner', value: '<i>same</i>' },
    ],
  };
  const renderer = createPortalRenderer(portal),
    index = renderer.sourceIndex();
  const context = renderer.contextForPage({ id: 'home', url: '/', name: 'Home', title: 'Home', metadata: {} }, '/');
  const result = await renderer.renderStringWithProvenance(
    mainSource,
    context,
    index.source(portal.templates.Main.metadata, 'source'),
  );
  assert.deepEqual(
    result.provenance.bindings
      .filter((binding) => binding.mapping === 'literal')
      .map((binding) => index.sources.get(binding.sourceRefId).recordId),
    ['card-upper', 'card-lower', 'snippet-upper', 'snippet-lower', 'snippet-upper'],
  );
});

test('verified static snippet composition preserves both original definitions and stale profiles fall back to the edited source', async () => {
  const parent = '<section><p>Empty</p></section>',
    child = '<button id="invented-action">Act</button>';
  const snippets = { Empty: parent, Action: child },
    origin = 'http://127.0.0.1:12345';
  const profile = observedSnippetComposition({
    snippets,
    parentName: 'Empty',
    childName: 'Action',
    observedMarkup: parent.replace('</section>', child + '</section>'),
    origin,
    pagePath: '/',
  });
  const portal = {
    ...fixture({ Main: "{{ snippets['Empty'] }}" }),
    snippets,
    records: [
      { kind: 'contentsnippet', id: 'parent', name: 'Empty', value: parent },
      { kind: 'contentsnippet', id: 'child', name: 'Action', value: child },
    ],
  };
  const renderer = createPortalRenderer(portal, {
    shellProfile: { snippetCompositions: [profile] },
    observationOrigin: origin,
  });
  const context = renderer.contextForPage({ id: 'home', url: '/', metadata: {} }, '/');
  const result = await renderer.renderStringWithProvenance(
    portal.templates.Main.source,
    context,
    renderer.sourceIndex().templates.get('main'),
  );
  assert.deepEqual(
    result.provenance.bindings.map((binding) => renderer.sourceIndex().sources.get(binding.sourceRefId).recordId),
    ['parent', 'parent', 'child'],
  );
  snippets.Empty = '<aside>Edited</aside>';
  portal.records[0].value = snippets.Empty;
  const updated = createPortalRenderer(portal, {
    shellProfile: { snippetCompositions: [profile] },
    observationOrigin: origin,
  });
  const next = await updated.renderStringWithProvenance(
    portal.templates.Main.source,
    updated.contextForPage({ id: 'home', url: '/', metadata: {} }, '/'),
    updated.sourceIndex().templates.get('main'),
  );
  assert.equal(next.provenance.bindings[0].tag, 'aside');
  assert.equal(updated.sourceIndex().sources.get(next.provenance.bindings[0].sourceRefId).recordId, 'parent');
});

test('inert template contents require their private original template identity and never claim initial script execution', async () => {
  const result = await trace({
    Main: '<template id="deferred"><button id="future">Later</button><script>window.future=true;</script></template><button id="active">Now</button>',
  });
  assert.deepEqual(
    result.provenance.bindings.map((binding) => binding.tag),
    ['template', 'button', 'script', 'button'],
  );
  assert.equal(result.provenance.scriptProofs.length, 0);
  assert.equal(result.provenance.bindings[1].inertTemplateId, result.provenance.bindings[0].id);
  assert.equal(result.provenance.bindings[2].inertTemplateId, result.provenance.bindings[0].id);
  assert.equal(result.provenance.bindings[3].inertTemplateId, undefined);
  assert.ok(
    result.provenance.bindings.every((binding) => binding.sourceRefId === result.index.templates.get('main').id),
  );
});
