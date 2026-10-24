import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortalRenderer } from '../lib/liquid.mjs';

function renderer(observed, options = {}) {
  return createPortalRenderer(
    {
      templates: {},
      snippets: {},
      settings: { 'Fixture/Quantity': '2' },
      pages: [],
      webFiles: [],
      records: [],
      weblinks: {},
      sitemarkers: {},
      website: {},
      pageTemplates: [],
      observed,
    },
    options,
  );
}

test('decimal string multiplication remains the pinned reference unless explicitly observed', async () => {
  const source = "{{ '2' | times: 1.0 }}";
  const expected =
    "Liquid error: The binary operator Multiply is not defined for the types 'System.String' and 'System.Decimal'.";
  assert.equal(await renderer().renderString(source), expected);
  assert.equal(await renderer({ liquidDecimalStringMultiply: 'dotliquid' }).renderString(source), expected);
});

test('observed decimal string multiplication converts literals and source settings through the renderer', async () => {
  const engine = renderer({ liquidDecimalStringMultiply: 'convert' });
  const context = engine.contextForPage({ id: '00000000-0000-4000-8000-000000000001', url: '/', metadata: {} }, '/');
  const source =
    "{{ '2' | times: 1.0 }}|{{ settings['Fixture/Quantity'] | times: 1.0 }}|{{ '2' | decimal | times: 1.0 }}|{{ 2 | times: 1.0 }}";
  assert.equal(await engine.renderString(source, context), '2|2|2|2');
  assert.equal(
    await engine.renderString("{{ 'not-a-number' | times: 1.0 }}"),
    'Liquid error: Input string was not in a correct format.',
  );
});

test('observed conversion does not widen other operators or change null, decimal arithmetic and integer repetition', async () => {
  const engine = renderer({ liquidDecimalStringMultiply: 'convert' });
  assert.equal(
    await engine.renderString('{{ nil | times: 1.0 }}|{{ 10 | times: 2.2 }}|{{ 10.0 | divided_by: 3 }}'),
    '|22|3.3333333333333333333333333333',
  );
  assert.equal(
    await engine.renderString("{% assign repeated = '2' | times: 2 %}{{ repeated | size }}:{{ repeated | join: ',' }}"),
    '2:2,2',
  );
  assert.equal(
    await engine.renderString("{{ '2' | minus: 1.0 }}"),
    "Liquid error: The binary operator Subtract is not defined for the types 'System.String' and 'System.Decimal'.",
  );
  assert.equal(
    await engine.renderString("{{ 2 | times: '2' }}"),
    "Liquid error: The binary operator Multiply is not defined for the types 'System.Int32' and 'System.String'.",
  );
});

test('explicit renderer observations override a portal observation', async () => {
  const engine = renderer(
    { liquidDecimalStringMultiply: 'dotliquid' },
    { observed: { liquidDecimalStringMultiply: 'convert' } },
  );
  assert.equal(await engine.renderString("{{ '2' | times: 1.0 }}"), '2');
});

test('observed times dispatch preserves the verified integer operand and string-array rejection envelopes', async () => {
  const engine = renderer({ liquidTimesDispatch: 'observed' });
  assert.equal(
    await engine.renderString("{{ 2 | times: '2' }}|{{ 2 | times: 'bad' }}"),
    'Liquid error: Parameter count mismatch.|Liquid error: Parameter count mismatch.',
  );
  assert.equal(
    await engine.renderString("{% assign values = 'a,b' | split: ',' %}{{ values | times: 2 }}"),
    'Liquid error: Parameter count mismatch.',
  );
  assert.equal(
    await engine.renderString("{% assign values = 'a,b' | split: ',' %}{{ values | times: 2.0 }}"),
    "Liquid error: Unable to cast object of type 'System.String[]' to type 'System.IConvertible'.",
  );
  assert.equal(
    await engine.renderString(
      "{% assign values = 'abc' | times: 2 %}{{ values }}|{{ values | size }}|{{ values | join: ',' }}",
    ),
    'abcabc|2|abc,abc',
  );
});

test('times dispatch is independently opt-in and does not infer unobserved collection or numeric operand types', async () => {
  const original = renderer();
  assert.equal(
    await original.renderString("{{ 2 | times: '2' }}"),
    "Liquid error: The binary operator Multiply is not defined for the types 'System.Int32' and 'System.String'.",
  );
  assert.equal(
    await original.renderString("{% assign values = 'a,b' | split: ',' %}{{ values | times: 2 }}"),
    "Liquid error: The binary operator Multiply is not defined for the types 'System.Object[]' and 'System.Int32'.",
  );
  const observed = renderer({ liquidTimesDispatch: 'observed' });
  assert.equal(
    await observed.renderString("{{ 2.0 | times: '2' }}"),
    "Liquid error: The binary operator Multiply is not defined for the types 'System.Decimal' and 'System.String'.",
  );
  assert.equal(
    await observed.renderString('{{ values | times: 2.0 }}', { values: [1, 'two'] }),
    "Liquid error: The binary operator Multiply is not defined for the types 'System.Object[]' and 'System.Decimal'.",
  );
});

test('observed filter errors preserve the verified invocation and collection envelopes', async () => {
  const engine = renderer({ liquidFilterErrors: 'observed' });
  assert.equal(
    await engine.renderString('a{{ 1 | divided_by: 0 }}b'),
    'aLiquid error: Exception has been thrown by the target of an invocation.b',
  );
  assert.equal(
    await engine.renderString("a{{ 'invalid-number' | minus: 1 }}b"),
    'aLiquid error: Parameter count mismatch.b',
  );
  assert.equal(
    await engine.renderString("{% assign values = 'c,a,b,a' | split: ',' %}a{{ values | batch: 0 | size }}b"),
    'aLiquid error: Value must be positive and non-zero.\r\nParameter name: sizeb',
  );
  assert.equal(
    await engine.renderString("{% assign values = 'c,a,b,a' | split: ',' %}a{{ values | then_by: 'size' | size }}b"),
    "aLiquid error: Object of type 'System.String[]' cannot be converted to type 'System.Linq.IOrderedEnumerable`1[System.Object]'.b",
  );
});

test('filter error observations keep default contracts and unobserved argument shapes', async () => {
  const original = renderer(),
    observed = renderer({ liquidFilterErrors: 'observed' });
  assert.equal(await original.renderString('{{ 1 | divided_by: 0 }}'), 'Liquid error: Attempted to divide by zero.');
  for (const source of ['{{ 1.0 | divided_by: 0 }}', "{{ values | then_by: 'size' }}"])
    assert.equal(
      await observed.renderString(source, { values: [1, 'two'] }),
      await original.renderString(source, { values: [1, 'two'] }),
      source,
    );
  assert.equal(
    await observed.renderString(
      "{% assign values = 'a,b' | split: ',' | order_by: 'size' %}{{ values | then_by: 'size' | join: ',' }}",
    ),
    'a,b',
  );
});

test('observed followups distinguish string math, negative batches and empty collection types', async () => {
  const engine = renderer({ liquidFilterErrors: 'observed' });
  assert.equal(
    await engine.renderString("{{ '2' | minus: 1 }}|{{ 'bad' | minus: 1.0 }}|{{ 1 | divided_by: '0' }}"),
    'Liquid error: Parameter count mismatch.|Liquid error: Input string was not in a correct format.|Liquid error: Parameter count mismatch.',
  );
  assert.equal(
    await engine.renderString('{{ values | batch: -1 }}', { values: [] }),
    'Liquid error: Value must be positive and non-zero.\r\nParameter name: size',
  );
  assert.equal(
    await engine.renderString("{{ values | then_by: 'size' }}", { values: [] }),
    "Liquid error: Object of type 'System.Linq.Enumerable+WhereArrayIterator`1[System.Object]' cannot be converted to type 'System.Linq.IOrderedEnumerable`1[System.Object]'.",
  );
});

test('observed decimal-zero division remains a numeric scalar through verified downstream filters', async () => {
  const engine = renderer({ liquidFilterErrors: 'observed' });
  assert.equal(
    await engine.renderString(
      '{% assign v = 1 | divided_by: 0.0 %}{{ v }}|{{ v | size }}|{{ v | plus: 1 }}|{{ v | times: 2 }}',
    ),
    '∞|0|∞|∞',
  );
  assert.equal(
    await renderer().renderString('{{ 1 | divided_by: 0.0 }}'),
    'Liquid error: Attempted to divide by zero.',
  );
  assert.equal(await engine.renderString('{{ 10.0 | divided_by: 3 }}'), '3.3333333333333333333333333333');
});

test('observed filter registration preserves unknown-filter passthrough and required currency parameter names', async () => {
  const engine = renderer({ liquidFilterRegistration: 'observed' });
  assert.equal(
    await engine.renderString(
      "{{ '<b>x</b>' | json }}|{% assign v = 'c,a,b,a' | split: ',' %}{{ v | json | join: ',' }}|{{ v | sort_natural | join: ',' }}",
    ),
    '<b>x</b>|c,a,b,a|c,a,b,a',
  );
  assert.equal(
    await engine.renderString("{{ 1234.5 | currency }}|{{ 1234.5 | currency: 'amount' }}"),
    "Liquid syntax error: Error - Filter 'currency' does not have a default value for 'record' and no value was supplied|Liquid syntax error: Error - Filter 'currency' does not have a default value for 'attribute' and no value was supplied",
  );
  assert.equal(
    await renderer().renderString("{{ '<b>x</b>' | json }}|{{ 1234.5 | currency: 'en-US' }}"),
    '"<b>x</b>"|$1,234.50',
  );
});

test('observed HTML void serialization preserves sanitized attributes and independently gates input elements', async () => {
  const engine = renderer({ liquidHtmlVoidSerialization: 'html' });
  assert.equal(await renderer().renderString("{{ '<img src=x>' | html_safe_escape }}"), '<img src="x" />');
  assert.equal(
    await engine.renderString('{{ \'<img src=x alt="value/>suffix"><br><hr>\' | html_safe_escape }}'),
    '<img src="x" alt="value/>suffix"><br><hr>',
  );
  assert.equal(
    await engine.renderString(
      "{{ '<b onclick=alert(1)>label</b><img src=javascript:alert(1) onerror=alert(1)><script>alert(1)</script>' | html_safe_escape }}",
    ),
    '<b>label</b><img>',
  );
  assert.equal(await engine.renderString("{{ '<input type=text value=probe disabled>' | html_safe_escape }}"), '');
  const inputs = renderer({ liquidHtmlVoidSerialization: 'html', liquidHtmlSafeInput: 'observed' });
  assert.equal(
    await inputs.renderString(
      "{{ '<input type=text value=probe disabled onclick=alert(1) formaction=javascript:alert(1)>' | html_safe_escape }}",
    ),
    '<input type="text" value="probe" disabled="">',
  );
});

test('observed newline serialization changes generated breaks while preserving user text', async () => {
  const source = '{% capture v %}first\nsecond{% endcapture %}{{ v | newline_to_br }}|{{ v | text_to_html }}';
  assert.equal(await renderer().renderString(source), 'first<br />\nsecond|<p>first<br />second</p>');
  assert.equal(
    await renderer({ liquidHtmlVoidSerialization: 'html' }).renderString(source),
    'first<br>\nsecond|<p>first<br>second</p>',
  );
});

test('observed path_and_query includes fragments in a present query without changing other URL filters', async () => {
  const engine = renderer({ liquidPathAndQueryFragment: 'query' });
  const source = "{{ 'https://example.test:8443/path?existing=one#fragment' | path_and_query }}";
  assert.equal(await renderer().renderString(source), '/path?existing=one');
  assert.equal(await engine.renderString(source), '/path?existing=one%23fragment');
  assert.equal(
    await engine.renderString("{{ '/path?existing=one#fragment#two' | path_and_query }}"),
    '/path?existing=one%23fragment%23two',
  );
  assert.equal(
    await engine.renderString("{{ 'https://example.test/path?existing=one%23fragment' | path_and_query }}"),
    '/path?existing=one%23fragment',
  );
  assert.equal(
    await engine.renderString(
      "{{ 'https://example.test/path#fragment' | path_and_query }}|{{ '#fragment' | path_and_query }}|{{ 'https://example.test/path?x=1#fragment' | path }}",
    ),
    '/path||/path',
  );
});
