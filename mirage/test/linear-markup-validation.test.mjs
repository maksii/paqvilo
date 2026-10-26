import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';
import { submitPortalForm } from '../lib/form-service.mjs';
import { observedPageCopyLayout } from '../lib/observed-pagecopy-layout.mjs';

async function formOptions() {
  const store = await new DataStore({
    state: {
      settings: { permissionMode: 'permissive' },
      mappings: { item: { entitySet: 'items', idColumn: 'itemid' } },
      tables: { item: [] },
    },
  }).init();
  return {
    store,
    portal: { forms: [{ id: 'create', mode: 100000000 }] },
    schemas: {
      create: {
        entity: 'item',
        fields: [
          {
            name: 'narrative',
            label: 'Narrative',
            required: true,
            richText: { name: 'MscrmControls.RichTextEditor.RichTextEditorControl' },
          },
        ],
      },
    },
    identity: { roles: [] },
  };
}
// Linear scans of these inputs take milliseconds; a quadratic rescan of 10^5 characters (10^10 steps) takes tens of
// seconds. The bound sits far from both, so machine speed does not decide the outcome.
const LINEAR_BOUND_MS = 5000;
const submit = (value, options) => submitPortalForm('entityform', 'create', { values: { narrative: value } }, options);

test('required rich text keeps lexical comment, tag, image and malformed-input semantics', async () => {
  const options = await formOptions();
  for (const value of [
    '',
    '<p><br>&nbsp;&#160;&#xA0;</p>',
    '<!---->',
    '<!-- hidden > text -->',
    '<!-- >',
    '<<<<>',
    '<>',
  ]) {
    const count = options.store.state.tables.item.length;
    await assert.rejects(submit(value, options), (error) => error.code === 'FormFieldRequired', JSON.stringify(value));
    assert.equal(options.store.state.tables.item.length, count);
  }
  for (const value of [
    'Meaningful',
    '<b>Meaningful</b>',
    'before<!-- hidden -->after',
    '<!-- unclosed',
    '<!-- >Meaningful',
    "<span title='>'></span>",
    '<img src="/invented.png">',
    '<IMG',
    '<!-- <img> -->',
  ]) {
    const result = await submit(value, options);
    assert.equal(result.record.narrative, value, 'required validation does not rewrite the submitted HTML');
  }
});

test('required rich text handles repeated unterminated tags and comments with bounded work', async () => {
  const options = await formOptions();
  for (const [value, requiredEmpty] of [
    ['<'.repeat(200000), false],
    ['<!--'.repeat(40000), false],
    ['<!-- >'.repeat(30000), true],
  ]) {
    const started = performance.now();
    if (requiredEmpty) await assert.rejects(submit(value, options), (error) => error.code === 'FormFieldRequired');
    else assert.equal((await submit(value, options)).record.narrative, value);
    assert.ok(
      performance.now() - started < LINEAR_BOUND_MS,
      `required text validation exceeded its 5 s bound for ${value.length} characters`,
    );
  }
});

const visible = '<p>Visible source</p>';
const observed =
  '<div class="page-copy"><div class="xrm-attribute-value">' +
  visible +
  '<div class="row sectionBlockLayout"><div class="container"></div></div></div></div>';
const capture = (source) =>
  observedPageCopyLayout(observed, {
    portal: { pages: [{ id: 'invented', url: '/owned/', html: source }] },
    path: '/owned/',
    origin: 'https://invented.example.test',
  });

test('observed page copy strips only complete supported Liquid comments and preserves malformed boundaries', () => {
  for (const source of [
    visible,
    '{% comment %}hidden{% endcomment %}' + visible,
    '{%comment%}{{ hidden }}{%endcomment%}' + visible,
    '{% \tcomment\n%}hidden{%\u00a0endcomment \t%}' + visible,
    '{% comment %}first{% endcomment %}' + visible + '{% comment %}second{% endcomment %}',
    '{% comment %}{% comment %}nested start{% endcomment %}' + visible,
  ]) {
    assert.equal(capture(source)?.pageId, 'invented', source);
  }
  for (const source of [
    '{% comment %}unclosed' + visible,
    '{% Comment %}hidden{% endcomment %}' + visible,
    '{%- comment -%}hidden{%- endcomment -%}' + visible,
    '{% comment %}{% comment %}nested{% endcomment %}{% endcomment %}' + visible,
    '{% comment broken %}hidden{% endcomment %}' + visible,
    '{% endcomment %}' + visible,
  ]) {
    assert.equal(capture(source), undefined, source);
  }
});

test('observed page copy rejects repeated unclosed Liquid comments with bounded work', () => {
  for (const source of [
    '{% comment %}'.repeat(40000) + visible,
    '{% comment %}' + '{% endcommentX %}{% comment %}'.repeat(20000) + visible,
    '{%' + ' '.repeat(300000),
  ]) {
    const started = performance.now();
    assert.equal(capture(source), undefined);
    assert.ok(
      performance.now() - started < LINEAR_BOUND_MS,
      `page-copy comment validation exceeded its 5 s bound for ${source.length} characters`,
    );
  }
});
