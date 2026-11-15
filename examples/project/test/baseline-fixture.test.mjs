import test from 'node:test';
import assert from 'node:assert/strict';
import { FORMS, extras, BANNER_HTML } from '../baseline/generate.mjs';

test('the baseline bigint fixture preserves its exact value through JSON', async () => {
  const data = await import('../baseline/data.mjs');
  const row = data.records().rows.find((record) => record.fields.pqvd_bigint != null);
  assert.equal(JSON.parse(JSON.stringify(row)).fields.pqvd_bigint, '9007199254740993');
});

test('item main form places each column once outside hidden sections and tabs', () => {
  const xml = FORMS.find((form) => form.file === 'item-main').build();
  // Hidden tabs and sections are not rendered, so the platform does not count them; strip them before counting.
  const visible = xml
    .replace(/<tab [^>]*visible="false"[\s\S]*?<\/tab>/g, '')
    .replace(/<section [^>]*visible="false"[\s\S]*?<\/section>/g, '');
  const fields = [...visible.matchAll(/<control id="([^"]+)" classid="[^"]+" datafieldname="([^"]+)"/g)]
    .filter(([, id]) => !id.startsWith('quickview_'))
    .map(([, , field]) => field);
  assert.deepEqual(
    fields.filter((field, index) => fields.indexOf(field) !== index),
    [],
  );
  assert.match(xml, /<Url>pqvd_baseline_banner\.html<\/Url>/);
});

test('form web resource is a static HTML document so it renders inline as well as framed', () => {
  const spec = extras().webResource;
  assert.deepEqual(
    [spec.name, spec.type, spec.retire],
    ['pqvd_baseline_banner.html', 1, ['pqvd_baseline_icon.png', 'pqvd_baseline_icon.svg']],
  );
  assert.equal(Buffer.from(spec.content, 'base64').toString('utf8'), BANNER_HTML);
  assert.match(BANNER_HTML, /^<!DOCTYPE html>[\s\S]*<h2 class="baseline-banner">/);
  assert.doesNotMatch(BANNER_HTML, /<script|on[a-z]+=/i);
});

test('stepped insert form keeps the Related tab without the quick view, which needs a saved record', () => {
  const build = (file) => FORMS.find((form) => form.file === file).build();
  assert.match(build('item-main'), /id="quickview_parent"/);
  const steps = build('item-steps');
  assert.doesNotMatch(steps, /quickview_parent/);
  assert.match(steps, /<tab name="related"[\s\S]*id="subgrid_children"[\s\S]*<\/tab>/);
  assert.equal(FORMS.find((form) => form.file === 'item-steps').name, 'Baseline Item Steps');
});

test('contact- and account-filtered item lists show at least four rows whose code order differs from name order', async () => {
  const data = await import('../baseline/data.mjs');
  const items = data.records().rows.filter((row) => row.table === data.ITEM);
  const check = (rows) => {
    const codes = rows.map((row) => row.fields.pqvd_code);
    assert.ok(new Set(codes).size >= 4, codes.join());
    const byName = [...rows]
      .sort((a, b) => a.fields.pqvd_name.localeCompare(b.fields.pqvd_name, 'en'))
      .map((row) => row.fields.pqvd_code);
    assert.notDeepEqual(byName, [...codes].sort());
  };
  check(items.filter((row) => row.refs.pqvd_contactid === 'tester')); // item-list-mine: all states (All Baseline Items view)
  check(items.filter((row) => row.refs.pqvd_accountid === 'account' && row.fields.statecode === 0)); // item-list-options: active view, account filter
});

test('fixed insert multistep shows a parent reference form whose control ids the item create form does not repeat', () => {
  const ids = (file) =>
    [
      ...FORMS.find((form) => form.file === file)
        .build()
        .matchAll(/<control id="([^"]+)"/g),
    ].map((match) => match[1]);
  const create = ids('item-lookup-create');
  assert.ok(ids('parent-main').some((id) => create.includes(id))); // the observed failure stays in multistep-insert
  assert.deepEqual(
    ids('parent-reference').filter((id) => create.includes(id)),
    [],
  );
  assert.equal(FORMS.find((form) => form.file === 'parent-reference').name, 'Baseline Parent Reference');
});
