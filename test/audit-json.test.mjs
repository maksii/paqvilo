import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectComponentJson, inspectJsonText } from '../lense/audit-json.mjs';

test('JSON diagnostics detect nested duplicate keys while retaining native JSON values', () => {
  const text = '{"customjavascript":"first()","customjavascript":"second()","nested":[{"value":"before","value":"after"}]}';
  const result = inspectJsonText(text);
  assert.deepEqual(result.value, JSON.parse(text));
  assert.equal(result.complete, false);
  assert.equal(result.diagnostics.length, 2);
  assert.ok(result.diagnostics.every(item => item.code === 'DUPLICATE_JSON_KEY'));
  assert.ok(result.diagnostics.every(item => !JSON.stringify(item).includes('first()')));
});

test('escaped key spellings cannot conceal duplicate JSON keys', () => {
  const result = inspectJsonText('{"customjavascript":"first()","custom\\u006aavascript":"second()"}');
  assert.equal(result.complete, false);
  assert.equal(result.diagnostics[0].code, 'DUPLICATE_JSON_KEY');
});

test('native JSON syntax and independent object scopes determine valid content', () => {
  for (const text of ['{"first":{"value":1},"second":{"value":2}}', '{"text":"value: &anchor \\"quote\\"","array":[true,null,-1.5e10]}', '{"slash":"\\/","tab":"\\t","unicode":"\\ud800"}']) {
    const result = inspectJsonText(text);
    assert.equal(result.complete, true);
    assert.deepEqual(result.value, JSON.parse(text));
  }
  for (const text of ['{unquoted: "not JSON"}', '{"trailing":1,}', '{"broken":']) assert.equal(inspectJsonText(text).complete, false);
});

test('enhanced content decoding handles entities and CDATA without exposing source bodies', () => {
  const escaped = '<component><content>{&quot;customjavascript&quot;:&quot;first()&quot;,&quot;customjavascript&quot;:&quot;second()&quot;}</content></component>';
  const result = inspectComponentJson(escaped);
  assert.equal(result.complete, false);
  assert.equal(result.diagnostics[0].code, 'DUPLICATE_JSON_KEY');
  assert.deepEqual(result.value, { customjavascript: 'second()' });
  const cdata = inspectComponentJson('<component><content><![CDATA[{"copy":"<p>HTML & text</p>"}]]></content></component>');
  assert.equal(cdata.complete, true);
  assert.deepEqual(cdata.value, { copy: '<p>HTML & text</p>' });
  const numeric = inspectComponentJson('<content>{"copy":"&#60;p&#x3e;text&#60;/p&#62;"}</content>');
  assert.equal(numeric.complete, true);
  assert.deepEqual(numeric.value, { copy: '<p>text</p>' });
});

test('multiple, missing, malformed or non-object component content never looks complete', () => {
  const duplicate = inspectComponentJson('<content>{"customjavascript":"one()"}</content><content>{"customjavascript":"two()"}</content>');
  assert.equal(duplicate.complete, false);
  assert.ok(duplicate.diagnostics.some(item => item.code === 'DUPLICATE_XML_CONTENT'));
  for (const xml of ['<component />', '<content>broken</content>', '<content>[]</content>', '<content>null</content>', '<content>{"copy":"&#999999999999999999;"}</content>', '<content>{"copy":"<p>Valid first</p>"}</content><content>', '<content>{"copy":"text"}</content></content>']) {
    assert.equal(inspectComponentJson(xml).complete, false);
  }
});

test('CDATA text and XML comments cannot create fake content nodes or truncated JSON', () => {
  const content = { customjavascript: "const tag = '</content><content>'; const split = ']]>';" };
  const body = JSON.stringify(content).replaceAll(']]>', ']]]]><![CDATA[>');
  const xml = '<component><!-- <content>Fake</content> --><content><![CDATA[' + body + ']]></content></component>';
  const inspected = inspectComponentJson(xml);
  assert.equal(inspected.complete, true);
  assert.deepEqual(inspected.value, content);
});
