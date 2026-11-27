// @test-kind unproven: local model of the legacy NextAction and PreviousAction of a Basic Form with auto-generated steps (Adxstudio FormConfiguration.SetFormActions adds their links only with AutoGenerateSteps; NextActionLink/PreviousActionLink take the action's label and class); no hosted capture of configured step actions
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';
import { renderComponent } from '../lib/platform.mjs';
import { boundedMarkup } from './support/bounded-markup.mjs';

const label = (value) => [{ LCID: 1033, Value: value }];
const tab = (name, field) => ({
  name,
  label: name,
  showLabel: true,
  columns: [{ width: '100%', sections: [{ name, label: name, rows: [[{ name: field }]] }] }],
});

async function render(metadata) {
  const store = await new DataStore({
    state: {
      mappings: {
        sample: {
          entitySet: 'samples',
          idColumn: 'sampleid',
          fields: { title: { dataverseType: 'nvarchar' }, description: { dataverseType: 'memo' } },
        },
      },
      tables: { sample: [] },
      settings: { permissionMode: 'permissive' },
    },
  }).init();
  const options = {
    store,
    portal: {
      forms: [
        { id: 'stepped', name: 'Stepped', mode: 100000000, metadata: { adx_autogeneratesteps: true, ...metadata } },
      ],
      pages: [],
    },
    schemas: {
      stepped: {
        entity: 'sample',
        fields: [
          { name: 'title', type: 'text', label: 'Title' },
          { name: 'description', type: 'textarea', label: 'Description' },
        ],
        layout: [tab('first', 'title'), tab('second', 'description')],
      },
    },
  };
  return renderComponent('entityform', 'Stepped', { identity: {}, request: { params: {} } }, options);
}
const nextButton = (html) => /<input type="submit" name="[^"]*\$NextButton"[^>]*>/.exec(boundedMarkup(html))?.[0] ?? '';

test('a configured NextAction gives the auto-generated Next button its label and class', async () => {
  const button = nextButton(
    await render({
      adx_nextbuttontext: 'Field text',
      adx_settings: JSON.stringify({
        Actions: [{ Type: 'NextAction', ButtonLabel: label('Continue'), ButtonCssClass: 'btn btn-success next' }],
      }),
    }),
  );
  assert.match(button, /value="Continue"/);
  assert.match(button, /class="btn btn-success next form-action-container-left"/);
});

test('without a NextAction the next button fields and then the defaults apply', async () => {
  const fields = nextButton(await render({ adx_nextbuttontext: 'Field text', adx_nextbuttoncssclass: 'btn custom' }));
  assert.match(fields, /value="Field text"/);
  assert.match(fields, /class="btn custom form-action-container-left"/);
  const defaults = nextButton(await render({ adx_settings: JSON.stringify({ Actions: [{ Type: 'NextAction' }] }) }));
  assert.match(defaults, /value="Next"/);
  assert.match(defaults, /class="btn btn-primary form-action-container-left"/);
});
