// @test-kind contract: Mirage's native-field PCF payload (column metadata, binding types, record context) is designed local behaviour exercised with an invented schema
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSyntheticCreateForm } from './support/native-pcf-form.mjs';

test('native PCF payloads carry the column facts and binding types independently per field', async () => {
  const definitions = [
    {
      name: 'amount',
      label: 'Amount',
      dataverseType: 'decimal',
      type: 'number',
      minValue: -12.25,
      maxValue: 400.5,
      precision: 3,
      precisionSource: 2,
      requiredLevel: 'recommended',
      pcfType: 'Decimal',
    },
    {
      name: 'category',
      label: 'Category',
      dataverseType: 'picklist',
      type: 'number',
      options: [
        { value: 7, label: 'Seven' },
        { value: 9, label: 'Nine' },
      ],
      defaultValue: 9,
      requiredLevel: 'none',
      pcfType: 'OptionSet',
    },
    {
      name: 'start',
      label: 'Start',
      dataverseType: 'datetime',
      type: 'date',
      format: 'dateonly',
      dateTimeBehavior: 'TimeZoneIndependent',
      requiredLevel: 'applicationrequired',
      pcfType: 'DateAndTime.DateOnly',
    },
  ];
  const fields = definitions.map((field) => ({
    ...field,
    controlStyle: 756150001,
    codeComponent: {
      name: 'synthetic.Column',
      boundAttributes: [field.name],
      parameters: {
        value: { kind: 'binding', column: field.name, type: field.pcfType },
        caption: { kind: 'static', value: field.label, type: 'SingleLine.Text' },
      },
    },
  }));
  const captures = [];
  const html = await renderSyntheticCreateForm(definitions, fields, async (spec) => {
    captures.push(spec);
    spec.onNativeBinding?.({ properties: ['value'] }, {});
    return '<script src="/__sim-static/pcf-host.js"></script><div data-test-component></div>';
  });
  assert.equal(captures.length, 3);
  // Each mounted field renders the field host markup (lib/pcf-field-host.mjs) with the mount element in its view.
  assert.equal((html.match(/<div id="PcfControl_/g) ?? []).length, 3);
  assert.equal(
    html.split(
      '_ControlView" class="flexbox"><script src="/__sim-static/pcf-host.js"></script><div data-test-component>',
    ).length - 1,
    3,
  );
  // The payload names the column facts; the client derives the captured attribute values from the property type.
  assert.deepEqual(captures[0].nativeBinding, {
    id: 'amount',
    control: 'decimal',
    properties: ['value'],
    propertyTypes: { value: 'Decimal' },
    attributes: { LogicalName: 'amount', Options: null, MaxLength: null, IsSecured: false },
    security: { secured: false, readable: true, editable: true },
    column: { logicalName: 'amount', dataverseType: 'decimal' },
    context: { label: 'Amount', entityId: null, entityTypeName: 'synthetic', entityRecordName: null },
  });
  assert.deepEqual(captures[1].nativeBinding.attributes, {
    LogicalName: 'category',
    MaxLength: null,
    IsSecured: false,
    Options: [
      { Label: 'Seven', Value: 7 },
      { Label: 'Nine', Value: 9 },
    ],
  });
  assert.deepEqual(captures[2].nativeBinding.propertyTypes, { value: 'DateAndTime.DateOnly' });
  assert.deepEqual(captures[2].nativeBinding.column, {
    logicalName: 'start',
    dataverseType: 'datetime',
    dateOnly: true,
  });
  assert.equal(captures[2].args.caption, 'Start');
  assert.notEqual(captures[0].nativeBinding.attributes, captures[1].nativeBinding.attributes);
});
