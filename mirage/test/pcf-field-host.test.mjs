// @test-kind observation: hidden input encodings and saved values of the Power Pages form field host (paqvilo-developer pcf-parity capture r2 edit-full hidden inputs, capture r2 notify-save written outputs, capture r2 submit-save with its Dataverse read-back, capture r4 edit-full static inputs)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nativeFieldHiddenValue,
  nativeFieldHostId,
  nativeFieldPostedValue,
  nativeFieldRefusalSummary,
  nativeStaticValue,
  PcfFieldValueError,
} from '../lib/pcf-field-host.mjs';

test('the server writes the hidden input as the platform renders it', () => {
  const hidden = (control, current, behavior) => nativeFieldHiddenValue({ control, behavior }, current);
  assert.equal(hidden('text', 'Line one\nLine two'), '"Line one\\nLine two"');
  assert.equal(hidden('integer', 34567), '34567');
  assert.equal(hidden('decimal', 1234.5), '1234.5000000000');
  assert.equal(hidden('money', 1234.56), '1234.5600000000');
  assert.equal(hidden('boolean', false), 'false');
  assert.equal(hidden('picklist', 970840001), '{"Value":970840001}');
  assert.equal(hidden('status', 1), '{"Value":1}');
  assert.equal(hidden('multiselect', '970840000,970840002'), '[{"Value":970840000},{"Value":970840002}]');
  assert.equal(hidden('datetime', '2026-03-15', 'DateOnly'), '"2026-03-15T00:00:00"');
  assert.equal(hidden('datetime', '2026-03-15T00:00:00Z', 'UserLocal'), '"2026-03-15T00:00:00Z"');
  assert.equal(hidden('datetime', '2026-03-15T14:05:09Z', 'UserLocal'), '"2026-03-15T14:05:09Z"');
  assert.equal(hidden('datetime', '2026-03-15T14:05:00', 'TimeZoneIndependent'), '"2026-03-15T14:05:00"');
  assert.equal(hidden('text', null), '');
  assert.equal(hidden('datetime', undefined, 'DateOnly'), '');
});

test('a posted hidden input decodes to the value the platform saved', () => {
  const posted = (control, text, behavior) => nativeFieldPostedValue(text, { control, behavior });
  assert.equal(posted('email', '"beta@example.invalid"'), 'beta@example.invalid');
  assert.equal(posted('integer', '4321'), 4321);
  assert.equal(posted('decimal', '2345.75'), 2345.75);
  assert.equal(posted('boolean', 'false'), false);
  assert.equal(
    posted('picklist', '{"Value":970840002,"Label":{"LocalizedLabels":[{"Label":"Blue","LanguageCode":1033}]}}'),
    970840002,
  );
  assert.equal(posted('multiselect', '[{"Value":970840001,"Label":{}}]'), '970840001');
  // A time-zone-independent column saves the UTC clock of the output, a user-local column the instant.
  assert.equal(posted('datetime', '"2026-04-20T09:15:00.000Z"', 'TimeZoneIndependent'), '2026-04-20T09:15:00.0000000');
  assert.equal(posted('datetime', '"2026-04-20T09:15:00.000Z"', 'UserLocal'), '2026-04-20T09:15:00.0000000Z');
  // The untouched server value of a wall-clock column.
  assert.equal(posted('datetime', '"2026-03-15T14:05:00"', 'TimeZoneIndependent'), '2026-03-15T14:05:00.0000000');
  assert.equal(posted('text', ''), null);
});

test('static inputs convert like the platform and an unconvertible Two Options value refuses', () => {
  assert.deepEqual(nativeStaticValue('Caption only', 'SingleLine.Text'), { value: 'Caption only' });
  assert.deepEqual(nativeStaticValue('3', 'Enum'), { value: '3' });
  assert.deepEqual(nativeStaticValue('12', 'Whole.None'), { value: 12 });
  assert.deepEqual(nativeStaticValue('2.5', 'Decimal'), { value: 2.5 });
  assert.deepEqual(nativeStaticValue('true', 'TwoOptions'), { value: true });
  assert.deepEqual(nativeStaticValue('1', 'TwoOptions'), { refused: true });
});

test('the host id and the refusal summary follow the platform markup', () => {
  assert.equal(
    nativeFieldHostId('{9C7F0A11-0001-4000-8000-000185633789}', 'x'),
    'PcfControl_9c7f0a11000140008000000185633789',
  );
  assert.equal(nativeFieldHostId('u-field', 'field'), 'PcfControl_field');
  assert.equal(nativeFieldRefusalSummary('view', []), '');
  assert.equal(
    nativeFieldRefusalSummary('view', [
      {
        message:
          'Lookup data type used by Contact (x_contact) is not supported for use with code components in portals.',
        link: true,
      },
      { message: "Couldn't load code component for Text (x_text) because of an unknown problem.", link: false },
    ]),
    `<div id="FailePcfControlsSummary_view" class="validation-summary alert alert-error alert-danger alert-block"><h2 class='validation-header'><span role='presentation' class='fa fa-info-circle'></span> Couldn't load one or more code components on this form.</h2><ul><li>Lookup data type used by Contact (x_contact) is not supported for use with code components in portals. <a href='https://go.microsoft.com/fwlink/?linkid=2155120 '>Learn more</a></li><li>Couldn't load code component for Text (x_text) because of an unknown problem.</li></ul></div>`,
  );
});

// @test-kind observation: the date-only save stores the UTC calendar date of the posted toISOString() value, so Kyiv local midnight saves the previous day (paqvilo-developer pcf-parity capture r2 submit-save, capture f1|f2 kyiv-save)
test('a date-only hidden instant saves its UTC calendar date', () => {
  const posted = (text) => nativeFieldPostedValue(text, { control: 'datetime', behavior: 'DateOnly' });
  assert.equal(posted('"2026-04-20T04:00:00.000Z"'), '2026-04-20T00:00:00.0000000');
  assert.equal(posted('"2026-04-19T21:00:00.000Z"'), '2026-04-19T00:00:00.0000000');
  assert.equal(posted('"2026-03-15T00:00:00"'), '2026-03-15T00:00:00.0000000');
});

// @test-kind unproven: LOCAL MODEL: exact digits of decimal and currency columns, and the refusal of choices and rich text values no native validator covers; the captured "null" and non-JSON refusals (capture g1, one load) are asserted with them
test('numbers keep their digits, wrong types stay for the validators and malformed values are refused', () => {
  const exact = { $type: 'DataverseNumeric', numericType: 'Decimal', value: '123456789012345.6789' };
  assert.equal(nativeFieldHiddenValue({ control: 'decimal' }, exact), '123456789012345.6789000000');
  assert.equal(nativeFieldHiddenValue({ control: 'money' }, '12.5'), '12.5000000000');
  assert.deepEqual(nativeFieldPostedValue('123456789012345.6789000000', { control: 'decimal' }), {
    $type: 'DataverseNumeric',
    numericType: 'Literal',
    value: '123456789012345.6789',
  });
  // A wrong type stays as posted, so the column's native validators refuse it.
  for (const [control, text, value] of [
    ['text', '42', 42],
    ['integer', '"abc"', 'abc'],
    ['integer', '"5"', '5'],
    ['boolean', '1', 1],
    ['datetime', '"not a date"', 'not a date'],
  ])
    assert.deepEqual(nativeFieldPostedValue(text, { control }), value, `${control} ${text}`);
  for (const [control, text] of [
    ['text', 'null'],
    ['text', 'not json'],
    ['richtext', '{"html":"x"}'],
    ['multiselect', '[[1]]'],
    ['picklist', '"2"'],
  ])
    assert.throws(() => nativeFieldPostedValue(text, { control }), PcfFieldValueError, `${control} ${text}`);
});
