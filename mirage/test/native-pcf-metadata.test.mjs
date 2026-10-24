import test from 'node:test';
import assert from 'node:assert/strict';
import { renderComponent } from '../lib/platform.mjs';

test('native PCF parameters carry typed column metadata and actual binding types independently per field', async () => {
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
  const html = await renderComponent(
    'entityform',
    'create',
    {},
    {
      portal: {
        forms: [{ id: 'create', name: 'Create synthetic row', mode: 100000000 }],
        records: definitions.map((field) => ({
          kind: 'basicformmetadata',
          adx_entityform: 'create',
          adx_attributelogicalname: field.name,
          adx_type: 100000000,
          adx_controlstyle: 756150001,
        })),
        pages: [],
        website: { id: 'site' },
      },
      schemas: { create: { entity: 'synthetic', fields } },
      store: {
        resolveMapping: () => ({ entitySet: 'synthetics', idColumn: 'syntheticid' }),
        query: () => ({ value: [] }),
      },
      codeComponent: async (spec) => {
        captures.push(spec);
        return '<div data-test-component></div>';
      },
    },
  );
  assert.equal(captures.length, 3);
  assert.equal((html.match(/data-pcf-native-field=/g) ?? []).length, 3);
  assert.deepEqual(captures[0].nativeBinding, {
    id: 'amount',
    control: 'decimal',
    properties: ['value'],
    propertyTypes: { value: 'Decimal' },
    attributes: {
      DisplayName: 'Amount',
      LogicalName: 'amount',
      RequiredLevel: 3,
      MinValue: -12.25,
      MaxValue: 400.5,
      Precision: 3,
      PrecisionSource: 2,
    },
  });
  assert.deepEqual(captures[1].nativeBinding.attributes, {
    DisplayName: 'Category',
    LogicalName: 'category',
    RequiredLevel: 0,
    Options: [
      { Label: 'Seven', Value: 7 },
      { Label: 'Nine', Value: 9 },
    ],
    DefaultValue: 9,
  });
  assert.deepEqual(captures[2].nativeBinding.propertyTypes, { value: 'DateAndTime.DateOnly' });
  assert.equal(captures[2].nativeBinding.attributes.RequiredLevel, 2);
  assert.equal(captures[2].nativeBinding.attributes.Behavior, 3);
  assert.equal(Object.hasOwn(captures[0].nativeBinding.attributes, 'Behavior'), false);
  assert.equal(captures[2].args.caption, 'Start');
  assert.notEqual(captures[0].nativeBinding.attributes, captures[1].nativeBinding.attributes);
});
