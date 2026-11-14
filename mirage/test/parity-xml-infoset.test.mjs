// @test-kind tooling: XML infoset projection used by the SOAP replay adapter
import test from 'node:test';
import assert from 'node:assert/strict';
import { xmlInfoset } from './parity/adapters/xml-infoset.mjs';

const XSI = 'http://www.w3.org/2001/XMLSchema-instance';
const XSD = 'http://www.w3.org/2001/XMLSchema';

test('prefix renaming yields equal infosets', () => {
  const a = '<a:v xmlns:a="urn:x"><a:item a:flag="1">t</a:item></a:v>';
  const b = '<b:v xmlns:b="urn:x"><b:item b:flag="1">t</b:item></b:v>';
  assert.deepStrictEqual(xmlInfoset(a), xmlInfoset(b));
  assert.equal(xmlInfoset(a).name, '{urn:x}v');
  assert.equal(xmlInfoset(a).children[0].name, '{urn:x}item');
  assert.deepStrictEqual(xmlInfoset(a).children[0].attributes, { '{urn:x}flag': '1' });
});

test('default-namespace and prefixed forms are equal', () => {
  const defaulted = '<v xmlns="urn:x"><item/></v>';
  const prefixed = '<p:v xmlns:p="urn:x"><p:item/></p:v>';
  assert.deepStrictEqual(xmlInfoset(defaulted), xmlInfoset(prefixed));
});

test('empty elements in every spelling are equal', () => {
  const forms = ['<a/>', '<a />', '<a></a>', '<a ></a >'].map((xml) => xmlInfoset(xml));
  for (const form of forms) assert.deepStrictEqual(form, forms[0]);
  assert.deepStrictEqual(forms[0], { name: 'a', attributes: {}, children: [] });
});

test('attribute order does not matter', () => {
  assert.deepStrictEqual(xmlInfoset('<a x="1" y="2"/>'), xmlInfoset('<a y="2" x="1"/>'));
  assert.deepStrictEqual(Object.keys(xmlInfoset('<a y="2" x="1"/>').attributes), ['x', 'y']);
});

test('xsi:type resolves to the namespace, whatever the prefix, and differs from no xsi:type', () => {
  const typed = `<v xmlns:i="${XSI}" xmlns:c="${XSD}" i:type="c:decimal">1</v>`;
  const renamed = `<v xmlns:i="${XSI}" xmlns:x="${XSD}" i:type="x:decimal">1</v>`;
  const untyped = `<v xmlns:i="${XSI}">1</v>`;
  assert.deepStrictEqual(xmlInfoset(typed), xmlInfoset(renamed));
  assert.deepStrictEqual(xmlInfoset(typed).attributes, { [`{${XSI}}type`]: `{${XSD}}decimal` });
  assert.notDeepStrictEqual(xmlInfoset(typed), xmlInfoset(untyped));
});

test('an unprefixed xsi:type QName takes the default namespace in scope', () => {
  const xml = `<v xmlns:i="${XSI}" xmlns="${XSD}" i:type="decimal">1</v>`;
  assert.deepStrictEqual(xmlInfoset(xml).attributes, { [`{${XSI}}type`]: `{${XSD}}decimal` });
});

test('i:nil is kept as a string attribute', () => {
  const xml = `<v xmlns:i="${XSI}" i:nil="true"/>`;
  assert.deepStrictEqual(xmlInfoset(xml).attributes, { [`{${XSI}}nil`]: 'true' });
});

test('namespace declarations are not attributes', () => {
  assert.deepStrictEqual(xmlInfoset('<a xmlns="urn:x" xmlns:p="urn:y"/>').attributes, {});
});

test('text and entity references are decoded, including numeric references', () => {
  const xml = '<a>x &amp; &lt;&#65;&#x42;&gt; &quot;&apos;</a>';
  assert.deepStrictEqual(xmlInfoset(xml).children, ['x & <AB> "\'']);
  assert.deepStrictEqual(xmlInfoset('<a t="&lt;&amp;&#x20;">z</a>').attributes, { t: '<& ' });
});

test('whitespace-only text between elements is dropped, text inside a leaf is kept exactly', () => {
  const spaced = xmlInfoset('<a>\n  <b/>\n  <c/>\n</a>');
  assert.deepStrictEqual(
    spaced.children.map((node) => node.name),
    ['b', 'c'],
  );
  assert.deepStrictEqual(xmlInfoset('<a>  </a>').children, ['  ']);
  assert.deepStrictEqual(xmlInfoset('<a> x <b/> y </a>').children, [
    ' x ',
    { name: 'b', attributes: {}, children: [] },
    ' y ',
  ]);
});

test('character data split by a comment is one text node, and the comment is skipped', () => {
  assert.deepStrictEqual(xmlInfoset('<?xml version="1.0"?><a>x<!-- c -->y</a>').children, ['xy']);
});

test('element order matters', () => {
  assert.notDeepStrictEqual(xmlInfoset('<a><b/><c/></a>'), xmlInfoset('<a><c/><b/></a>'));
});

test('a CDATA section throws', () => {
  assert.throws(() => xmlInfoset('<a><![CDATA[x]]></a>'), /CDATA sections are not supported/);
});

test('a DOCTYPE, an undeclared prefix and a bare ampersand throw', () => {
  assert.throws(() => xmlInfoset('<!DOCTYPE a><a/>'), /unsupported markup/);
  assert.throws(() => xmlInfoset('<p:a/>'), /undeclared namespace prefix p/);
  assert.throws(() => xmlInfoset('<a>x & y</a>'), /bare &/);
});

test('a prefix inherited from the enclosing document resolves only when it is given', () => {
  const fragment = `<v i:type="c:string">x</v>`;
  assert.throws(() => xmlInfoset(fragment), /undeclared namespace prefix i/);
  const inherited = { i: XSI, c: XSD };
  assert.deepStrictEqual(xmlInfoset(fragment, inherited).attributes, { [`{${XSI}}type`]: `{${XSD}}string` });
  assert.deepStrictEqual(xmlInfoset(fragment, inherited).children, ['x']);
});
