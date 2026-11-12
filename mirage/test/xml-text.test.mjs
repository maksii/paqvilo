// @test-kind contract: decodeXml is the exported-XML text decoder; CDATA bodies stay literal and entities decode outside them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeXml } from '../lib/xml-text.mjs';

test('CDATA bodies stay literal while entities outside them decode', () => {
  assert.equal(decodeXml('<![CDATA[&lt;script&gt;]]>'), '&lt;script&gt;');
  assert.equal(decodeXml('<![CDATA[a & b <x>]]>'), 'a & b <x>');
  assert.equal(decodeXml('a &amp; b <![CDATA[&lt;i&gt;]]> &lt;end&gt;'), 'a & b &lt;i&gt; <end>');
});

test('a mixed value decodes only the part outside CDATA', () => {
  assert.equal(decodeXml('&amp;<![CDATA[&amp;]]>&amp;'), '&&amp;&');
});

test('malformed CDATA without a closing marker is decoded as text', () => {
  assert.equal(decodeXml('a &amp; <![CDATA[ b &lt;'), 'a & <![CDATA[ b <');
});

test('numeric references above the Unicode range are left as written', () => {
  assert.equal(decodeXml('&#x110000;&#65;'), '&#x110000;A');
});
