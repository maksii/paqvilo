// @test-kind contract: Paqvilo's native-field PCF admission diagnostics (type checks before mount, unhosted fields, record context payload), exercised with invented controls and loopback-free render calls
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importCodeComponents, renderCodeComponent, nativeColumnPcfType } from '../lib/code-components.mjs';
import { NATIVE_FIELD_ADMISSION, nativeFieldAdmission } from '../lib/pcf-field-host.mjs';
import { renderComponent, renderQuickForm } from '../lib/platform.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

async function catalogOf(t, properties) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-pcf-admission-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const control = path.join(dir, 'Controls', 'tst_Synthetic.Field');
  await fs.mkdir(control, { recursive: true });
  await fs.writeFile(
    path.join(control, 'ControlManifest.xml'),
    `<manifest><control namespace="Synthetic" constructor="Field" control-type="standard">${properties}<resources><code path="bundle.js"/></resources></control></manifest>`,
  );
  await fs.writeFile(
    path.join(control, 'ControlManifest.xml.data.xml'),
    '<CustomControl><Name>tst_Synthetic.Field</Name></CustomControl>',
  );
  await fs.writeFile(path.join(control, 'bundle.js'), 'ComponentFramework.registerControl("Synthetic.Field",class{});');
  return importCodeComponents([{ dir }]);
}

const mountedBinding = (html) => {
  const match = /__paqviloPcf\.mount\((\{.*\}), document\.currentScript/.exec(html);
  return match ? JSON.parse(match[1]).nativeBinding : null;
};

function renderBinding(catalog, nativeBinding) {
  const diagnostics = [];
  const html = renderCodeComponent({
    name: 'tst_Synthetic.Field',
    portal: {},
    catalog,
    nativeBinding: { id: 'tst_field', properties: ['value'], ...nativeBinding },
    diagnostic: (entry) => diagnostics.push(entry),
  });
  return { html, diagnostics, binding: mountedBinding(html) };
}

test('native column types follow the control kind, the exported format and the date behaviour', () => {
  const cases = [
    ['text', { Format: 'text' }, 'SingleLine.Text'],
    ['text', { Format: 'Phone' }, 'SingleLine.Phone'],
    ['text', { Format: 'url' }, 'SingleLine.URL'],
    ['text', {}, 'SingleLine.Text'],
    ['email', {}, 'SingleLine.Email'],
    ['textarea', { Format: 'textarea' }, 'SingleLine.TextArea'],
    ['textarea', {}, 'Multiple'],
    ['integer', {}, 'Whole.None'],
    ['integer', { Format: 'duration' }, 'Whole.Duration'],
    ['decimal', {}, 'Decimal'],
    ['double', {}, 'FP'],
    ['money', {}, 'Currency'],
    ['datetime', { Format: 'date' }, 'DateAndTime.DateOnly'],
    ['datetime', { Behavior: 2 }, 'DateAndTime.DateOnly'],
    ['datetime', { Format: 'datetime', Behavior: 1 }, 'DateAndTime.DateAndTime'],
    ['boolean', {}, 'TwoOptions'],
    ['picklist', {}, 'OptionSet'],
    ['multiselect', {}, 'MultiSelectOptionSet'],
    ['lookup', {}, 'Lookup.Simple'],
    ['file', {}, 'File'],
    ['image', {}, 'Image'],
    [undefined, {}, null],
  ];
  for (const [control, attributes, type] of cases)
    assert.equal(nativeColumnPcfType(control, attributes), type, `${control} ${JSON.stringify(attributes)}`);
});

test('native column types use the exported Dataverse type and the native date-only rule when the form sends them', () => {
  const cases = [
    // A memo export (Entity.xml <Type>ntext</Type><Format>text</Format>, or any Format) is Multiple.
    ['textarea', { Format: 'text' }, { dataverseType: 'ntext' }, 'Multiple'],
    ['textarea', { Format: 'textarea' }, { dataverseType: 'memo' }, 'Multiple'],
    ['textarea', { Format: 'textarea' }, { dataverseType: 'nvarchar' }, 'SingleLine.TextArea'],
    ['lookup', {}, { dataverseType: 'lookup' }, 'Lookup.Simple'],
    ['lookup', {}, { dataverseType: 'customer' }, 'Lookup.Customer'],
    ['lookup', {}, { dataverseType: 'owner' }, 'Lookup.Owner'],
    ['text', {}, { dataverseType: 'partylist' }, 'Lookup.PartyList'],
    // A datetime column without an exported Format renders a date-only native box (platform.mjs nativeDateOnly).
    ['datetime', {}, { dataverseType: 'datetime', dateOnly: true }, 'DateAndTime.DateOnly'],
    ['datetime', { Format: 'date' }, { dataverseType: 'datetime', dateOnly: false }, 'DateAndTime.DateAndTime'],
  ];
  for (const [control, attributes, column, type] of cases)
    assert.equal(nativeColumnPcfType(control, attributes, column), type, `${control} ${JSON.stringify(column)}`);
});

// @test-kind observation: the attribute type codes the Power Pages form host admits, from its own server log (warning RTDTPC19 in paqvilo-developer pcf-parity capture r2 edit-full); Owner and PartyList are named by their type codes without a capture
test('the field host admits the platform allow-list of column types and refuses the others', () => {
  assert.deepEqual(NATIVE_FIELD_ADMISSION, [
    'Boolean',
    'DateTime',
    'Decimal',
    'Double',
    'Integer',
    'Memo',
    'Money',
    'Picklist',
    'String',
    'BigInt',
    'Status',
    'State',
    'MultiSelectPicklist',
  ]);
  const cases = [
    ['text', 'nvarchar', 'String', true],
    ['textarea', 'ntext', 'Memo', true],
    ['richtext', 'ntext', 'Memo', true],
    ['integer', 'bigint', 'BigInt', true],
    ['multiselect', 'multiselectpicklist', 'MultiSelectPicklist', true],
    ['state', 'state', 'State', true],
    ['status', 'status', 'Status', true],
    ['lookup', 'lookup', 'Lookup', false],
    ['lookup', 'customer', 'Customer', false],
    ['lookup', 'owner', 'Owner', false],
    ['text', 'partylist', 'PartyList', false],
    ['file', 'file', 'Virtual', false],
    ['image', 'image', 'Virtual', false],
    ['text', 'uniqueidentifier', 'Uniqueidentifier', false],
    ['money', undefined, 'Money', true],
  ];
  for (const [control, dataverseType, typeCode, admitted] of cases)
    assert.deepEqual(
      nativeFieldAdmission(control, dataverseType),
      { typeCode, admitted },
      `${control} ${dataverseType}`,
    );
});

// @test-kind observation: the refusal wording of the form summary (paqvilo-developer pcf-parity capture r2 edit-full, FailePcfControlsSummary)
test('a refused column type answers the platform wording instead of mounting a component', async (t) => {
  const catalog = await catalogOf(t, '<property name="value" of-type="SingleLine.Text" usage="bound"/>');
  for (const [control, dataverseType, typeCode] of [
    ['file', 'file', 'Virtual'],
    ['image', 'image', 'Virtual'],
    ['lookup', 'customer', 'Customer'],
  ]) {
    const { html, diagnostics } = renderBinding(catalog, {
      control,
      column: { logicalName: 'tst_field', dataverseType },
      context: { label: 'Field' },
    });
    assert.doesNotMatch(html, /__paqviloPcf\.mount/);
    assert.match(html, /role="alert"/);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].code, 'PCF_HOST_UNSUPPORTED');
    assert.equal(diagnostics[0].reason, 'PCF_NATIVE_TYPE_UNSUPPORTED');
    assert.equal(diagnostics[0].field, 'tst_field');
    assert.match(
      diagnostics[0].message,
      new RegExp(
        `${typeCode} data type used by Field \\(tst_field\\) is not supported for use with code components in portals\\.`,
      ),
    );
  }
});

// @test-kind observation: the host mounts a number type on a text column and hands it NaN (paqvilo-developer pcf-parity capture r2 edit-full FieldProbe:pqpcf_phone); the warning is Paqvilo's own diagnostic
test('a column type outside the property type family mounts with a warning', async (t) => {
  const catalog = await catalogOf(t, '<property name="value" of-type="Decimal" usage="bound"/>');
  const mismatch = renderBinding(catalog, { control: 'text', attributes: { Format: 'text' } });
  assert.match(mismatch.html, /__paqviloPcf\.mount/);
  assert.deepEqual(
    mismatch.diagnostics.map((entry) => [entry.code, entry.severity, entry.property]),
    [['PCF_NATIVE_TYPE_MISMATCH', 'warning', 'value']],
  );
  assert.match(
    mismatch.diagnostics[0].message,
    /bound as Decimal to native field tst_field, a SingleLine\.Text column/,
  );
  for (const control of ['integer', 'decimal', 'double', 'money']) {
    const accepted = renderBinding(catalog, { control });
    assert.match(accepted.html, /__paqviloPcf\.mount/, control);
    assert.deepEqual(accepted.diagnostics, []);
  }
});

// @test-kind observation: a type-group property resolves to the first type of its group whatever the column and the FormXml type (paqvilo-developer pcf-parity capture r2 edit-full FieldProbe:pqpcf_phone, ManifestPropertyTypes value Currency)
test('type-group bindings take the first type of the group and warn when the FormXml or column type differs', async (t) => {
  const catalog = await catalogOf(
    t,
    '<type-group name="mixed"><type>SingleLine.Text</type><type>Whole.None</type><type>DateAndTime.DateOnly</type></type-group><property name="value" of-type-group="mixed" usage="bound"/>',
  );
  const exported = renderBinding(catalog, { control: 'integer', propertyTypes: { value: 'Whole.None' } });
  assert.match(exported.html, /__paqviloPcf\.mount/);
  assert.deepEqual(exported.binding.propertyTypes, { value: 'SingleLine.Text' });
  assert.deepEqual(
    exported.diagnostics.map((entry) => entry.message),
    [
      'Code component tst_Synthetic.Field property value is exported as Whole.None, but the Power Pages host binds it as SingleLine.Text, the first type of its type-group.',
      'Code component tst_Synthetic.Field property value is bound as SingleLine.Text to native field tst_field, a Whole.None column; the control receives a value it cannot convert.',
    ],
  );
  const text = renderBinding(catalog, { control: 'text' });
  assert.deepEqual(text.binding.propertyTypes, { value: 'SingleLine.Text' });
  assert.deepEqual(text.diagnostics, []);
});

test('a memo column binds a group starting with Multiple without a diagnostic', async (t) => {
  const catalog = await catalogOf(
    t,
    '<type-group name="memo"><type>Multiple</type><type>Whole.None</type></type-group><property name="value" of-type-group="memo" usage="bound"/>',
  );
  const memo = renderBinding(catalog, {
    control: 'textarea',
    attributes: { Format: 'text' },
    column: { dataverseType: 'ntext' },
  });
  assert.deepEqual(memo.diagnostics, []);
  assert.deepEqual(memo.binding.propertyTypes, { value: 'Multiple' });
});

// @test-kind observation: a FormXml binding to an input property mounts and leaves the manifest's bound property without a value (paqvilo-developer pcf-parity capture r2 edit-full LiquidProbe:pqpcf_ticker)
test('a binding to an input property mounts without a dynamic property', async (t) => {
  const catalog = await catalogOf(
    t,
    '<property name="boundText" of-type="SingleLine.Text" usage="bound"/><property name="textValue" of-type="SingleLine.Text" usage="input"/>',
  );
  const result = renderBinding(catalog, { control: 'text', properties: ['textValue'] });
  assert.match(result.html, /__paqviloPcf\.mount/);
  assert.deepEqual(result.binding.properties, []);
  assert.deepEqual(result.binding.columnProperties, ['boundText']);
});

// @test-kind observation: static FormXml inputs are converted by the host and an unconvertible Two Options "1" refuses the control (paqvilo-developer pcf-parity capture r4 edit-full)
test('static inputs are converted, and a value the host cannot convert refuses the control', async (t) => {
  const catalog = await catalogOf(
    t,
    '<property name="value" of-type="SingleLine.Text" usage="bound"/><property name="toggle" of-type="TwoOptions" usage="input"/><property name="count" of-type="Whole.None" usage="input"/><property name="ratio" of-type="Decimal" usage="input"/><property name="flavour" of-type="Enum" usage="input"/>',
  );
  const mount = (args) => {
    const diagnostics = [];
    let refused = null;
    const html = renderCodeComponent({
      name: 'tst_Synthetic.Field',
      portal: {},
      catalog,
      args,
      nativeBinding: { id: 'tst_field', properties: ['value'], control: 'text' },
      diagnostic: (entry) => diagnostics.push(entry),
      onNativeRefused: (detail) => {
        refused = detail;
      },
    });
    const match = /__paqviloPcf\.mount\((\{.*\}), document\.currentScript/.exec(html);
    return { args: match ? JSON.parse(match[1]).args : null, refused, diagnostics };
  };
  assert.deepEqual(mount({ toggle: 'true', count: '12', ratio: '2.5', flavour: '3' }).args, {
    toggle: true,
    count: 12,
    ratio: 2.5,
    flavour: '3',
  });
  const refused = mount({ toggle: '1' });
  assert.equal(refused.args, null);
  assert.deepEqual(refused.refused, { reason: 'PCF_NATIVE_STATIC_UNCONVERTIBLE', property: 'toggle' });
  assert.equal(refused.diagnostics[0].reason, 'PCF_NATIVE_STATIC_UNCONVERTIBLE');
});

function fieldComponent(name, extra = {}, type = 'SingleLine.Text') {
  return {
    codeComponent: {
      name: 'synthetic.Column',
      sourceFile: 'row-form.xml',
      boundAttributes: [name],
      parameters: { value: { kind: 'binding', column: name, ...(type ? { type } : {}) } },
    },
    ...extra,
  };
}

function formOptions({
  fields,
  metadataStyle = 756150001,
  records = [],
  captures,
  diagnostics,
  mode = 100000000,
  ...extra
}) {
  return {
    ...extra,
    portal: {
      forms: [{ id: 'create', name: 'Create synthetic row', mode }],
      records: fields.map((field) => ({
        kind: 'basicformmetadata',
        adx_entityform: 'create',
        adx_attributelogicalname: field.name,
        adx_type: 100000000,
        adx_controlstyle: metadataStyle,
      })),
      pages: [],
      website: { id: 'site' },
    },
    schemas: { create: { entity: 'synthetic', fields } },
    store: {
      resolveMapping: () => ({ entitySet: 'synthetics', idColumn: 'syntheticid', nameColumn: 'title' }),
      query: () => ({ value: records }),
    },
    readProvider: {
      get: async (_entity, id) => records.find((record) => record.syntheticid === String(id).toLowerCase()) ?? null,
      query: async () => ({ value: records }),
    },
    codeComponent: async (spec) => {
      captures.push(spec);
      return '<div data-test-component></div>';
    },
    diagnostic: (entry) => diagnostics.push(entry),
  };
}

// @test-kind observation: a hidden field renders no cell and a rich text column mounts the component, not the editor (paqvilo-developer pcf-parity capture r2 edit-full pqpcf_hidden, pqpcf_richtext)
test('a hidden field is reported and omitted, and a rich text field mounts its component', async () => {
  const captures = [],
    diagnostics = [];
  const fields = [
    {
      name: 'hidden_title',
      label: 'Hidden title',
      dataverseType: 'nvarchar',
      hidden: true,
      ...fieldComponent('hidden_title'),
    },
    {
      name: 'notes',
      label: 'Notes',
      dataverseType: 'ntext',
      richText: { name: 'MscrmControls.RichTextEditor.RichTextEditorControl' },
      ...fieldComponent('notes'),
    },
    // The platform's own rich text enablement (code-component style, rich text editor binding only) is no finding.
    {
      name: 'body',
      label: 'Body',
      dataverseType: 'ntext',
      richText: { name: 'MscrmControls.RichTextEditor.RichTextEditorControl' },
    },
  ];
  const html = await renderComponent('entityform', 'create', {}, formOptions({ fields, captures, diagnostics }));
  assert.deepEqual(
    captures.map((spec) => spec.nativeBinding.id),
    ['notes'],
  );
  assert.doesNotMatch(String(html.html ?? html), /hidden_title/);
  assert.deepEqual(
    diagnostics
      .filter((entry) => entry.code === 'PCF_NATIVE_BINDING_UNSUPPORTED' && entry.reason)
      .map((entry) => [entry.field, entry.reason, entry.sourceFile ?? null]),
    [['hidden_title', 'PCF_NATIVE_HIDDEN_FIELD', 'row-form.xml']],
  );
});

test('a skipped field component is reported once per loaded portal sources', async () => {
  const captures = [],
    diagnostics = [];
  const hidden = {
    name: 'hidden_title',
    label: 'Hidden title',
    dataverseType: 'nvarchar',
    hidden: true,
    ...fieldComponent('hidden_title'),
  };
  const options = formOptions({ fields: [hidden], captures, diagnostics });
  await renderComponent('entityform', 'create', {}, options);
  const skips = () => diagnostics.filter((entry) => entry.reason === 'PCF_NATIVE_HIDDEN_FIELD');
  assert.equal(skips().length, 1);
  assert.match(skips()[0].message, /Mirage renders neither the cell nor an input for it/);
  // Later renders of the same sources (page loads, quick view reloads) do not repeat it.
  await renderComponent('entityform', 'create', {}, options);
  await renderComponent('entityform', 'create', {}, options);
  assert.equal(skips().length, 1);
  // Reloaded sources (a new portal) report it again.
  await renderComponent('entityform', 'create', {}, { ...options, portal: { ...options.portal } });
  assert.equal(skips().length, 2);
});

test('a datetime column without an exported Format sends its date-only column facts, and its group takes the first type', async (t) => {
  const catalog = await catalogOf(
    t,
    '<type-group name="dates"><type>DateAndTime.DateAndTime</type><type>DateAndTime.DateOnly</type></type-group><property name="value" of-type-group="dates" usage="bound"/>',
  );
  const captures = [];
  await renderComponent(
    'entityform',
    'create',
    {},
    formOptions({
      fields: [{ name: 'day', label: 'Day', dataverseType: 'datetime', ...fieldComponent('day', {}, null) }],
      captures,
      diagnostics: [],
    }),
  );
  assert.deepEqual(captures[0].nativeBinding.column, { logicalName: 'day', dataverseType: 'datetime', dateOnly: true });
  const result = renderBinding(catalog, {
    control: captures[0].nativeBinding.control,
    attributes: captures[0].nativeBinding.attributes,
    column: captures[0].nativeBinding.column,
  });
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.binding.propertyTypes, { value: 'DateAndTime.DateAndTime' });
});

test('a native field component receives its label and the form record context', async () => {
  const id = 'a0000000-0000-4000-8000-000000000001';
  const captures = [],
    diagnostics = [];
  const fields = [{ name: 'title', label: 'Title', dataverseType: 'nvarchar', ...fieldComponent('title') }];
  const records = [{ syntheticid: id, title: 'Existing row' }];
  await renderComponent(
    'entityform',
    'create',
    { request: { params: { id: id.toUpperCase() } } },
    formOptions({ fields, captures, diagnostics, records, mode: 100000001 }),
  );
  assert.equal(captures.length, 1, JSON.stringify(diagnostics));
  assert.deepEqual(captures[0].nativeBinding.context, {
    label: 'Title',
    entityId: id,
    entityTypeName: 'synthetic',
    entityRecordName: 'Existing row',
  });
  const insert = [];
  await renderComponent('entityform', 'create', {}, formOptions({ fields, captures: insert, diagnostics }));
  assert.deepEqual(insert[0].nativeBinding.context, {
    label: 'Title',
    entityId: null,
    entityTypeName: 'synthetic',
    entityRecordName: null,
  });
});

// @test-kind security: the record context a component receives never carries a name the form does not show the visitor, nor posted text
test('the record name is sent only when the form shows the name column readably, and never the posted text', async () => {
  const id = 'a0000000-0000-4000-8000-000000000003';
  const records = [{ syntheticid: id, title: 'Saved name', code: 'X' }];
  const code = { name: 'code', label: 'Code', dataverseType: 'nvarchar', ...fieldComponent('code') };
  const render = async (fields, extra = {}) => {
    const captures = [];
    await renderComponent(
      'entityform',
      'create',
      { request: { params: { id } } },
      formOptions({ fields, captures, diagnostics: [], records, mode: 100000001, ...extra }),
    );
    return captures[0].nativeBinding.context.entityRecordName;
  };
  const title = { name: 'title', label: 'Title', dataverseType: 'nvarchar' };
  assert.equal(await render([title, code]), 'Saved name');
  // The name column is not on the form, is hidden or is column-secured.
  assert.equal(await render([code]), null);
  assert.equal(await render([{ ...title, hidden: true }, code]), null);
  assert.equal(await render([{ ...title, isSecured: true }, code]), null);
  assert.equal(
    await render([title, code], { metadata: { entities: { synthetic: { fields: { title: { isSecured: true } } } } } }),
    null,
  );
  // A failed postback re-renders the visitor's unsaved text; the context keeps the saved name.
  assert.equal(
    await render([title, code], {
      nativePostbackState: { kind: 'entityform', formId: 'create', values: { title: 'Unsaved text', code: 'Y' } },
    }),
    'Saved name',
  );
});

test('a quick view with an exported field component renders the native control without an alert and records why', async () => {
  const id = 'a0000000-0000-4000-8000-000000000002';
  const diagnostics = [];
  const quickFields = [{ name: 'title', label: 'Title', dataverseType: 'nvarchar', ...fieldComponent('title') }];
  const html = await renderQuickForm({
    portal: { forms: [], records: [], pages: [], website: { id: 'site' } },
    schemas: {
      host: {
        entity: 'host',
        fields: [],
        layout: [
          {
            name: 'general',
            columns: [
              {
                sections: [
                  {
                    name: 'main',
                    rows: [
                      [
                        {
                          type: 'quickform',
                          id: 'quick_control',
                          entity: 'synthetic',
                          schema: { entity: 'synthetic', fields: quickFields, formName: 'Quick' },
                        },
                      ],
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    },
    store: { resolveMapping: () => ({ entitySet: 'synthetics', idColumn: 'syntheticid', nameColumn: 'title' }) },
    readProvider: { get: async () => ({ syntheticid: id, title: 'Quick row' }) },
    identity: null,
    params: { entityname: 'synthetic', entityid: id, controlid: 'quick_control' },
    diagnostic: (entry) => diagnostics.push(entry),
  });
  assert.doesNotMatch(html, /role="alert" data-mirage-component="codecomponent"/);
  assert.doesNotMatch(html, /requires its solution control sources/);
  assert.match(html, /Quick row/);
  assert.deepEqual(
    diagnostics.filter((entry) => entry.code === 'PCF_NATIVE_BINDING_UNSUPPORTED').map((entry) => entry.reason),
    ['PCF_NATIVE_REFERENCE_FORM'],
  );
});
