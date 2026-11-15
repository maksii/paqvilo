import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRibbonCommands } from '../lib/model-driven/solution.mjs';
import { appCatalogue } from '../lib/model-driven/catalogue.mjs';
import { createModelDrivenMetadataIndex } from '../../lense/model-driven-metadata.mjs';

const xml = `<RibbonDiffXml>
  <Button Id="x.Form.Review" Command="x.Review" LabelText="$LocLabels:x.Review.Label"/>
  <Button Id="x.Form.Literal" Command="x.Review" LabelText="Literal label"/>
  <Button Id="x.Form.Unavailable" Command="x.Review" LabelText="$LocLabels:x.Absent"/>
  <CommandDefinitions><CommandDefinition Id="x.Review"><Actions><JavaScriptFunction Library="$webresource:x_/review.js" FunctionName="Invented.review"/></Actions></CommandDefinition></CommandDefinitions>
  <LocLabels><LocLabel Id="x.Review.Label"><Titles>
    <Title languagecode="1031" description="Prufen"/>
    <Title languagecode="1033" description="Review"/>
    <Title languagecode="1036" description="Reviser"/>
  </Titles></LocLabel></LocLabels>
</RibbonDiffXml>`;

test('classic ribbon labels honor requested LCID, preserve literal labels and retain the exported fallback', () => {
  const localized = parseRibbonCommands(xml, { lcid: 1036 });
  assert.deepEqual(
    localized.map((command) => command.label),
    ['Reviser', 'Literal label', 'x.Form.Unavailable'],
  );
  assert.equal(parseRibbonCommands(xml)[0].label, 'Review');
  assert.equal(parseRibbonCommands(xml, { lcid: '1036' })[0].label, 'Reviser');
  assert.equal(parseRibbonCommands(xml, { lcid: 1049 })[0].label, 'Prufen');
  assert.equal(
    parseRibbonCommands(xml.replace('description="Reviser"', 'description=""'), { lcid: 1036 })[0].label,
    '',
  );
  assert.deepEqual(localized[0].actions, parseRibbonCommands(xml)[0].actions);
  assert.equal(localized[0].supported, true);
});

test('catalogue and lazy source inspector use the same Solution LCID for classic command labels', () => {
  const metadata = { lcid: 1036, modelDrivenRibbonDocuments: [{ entity: 'x_item', xml }] };
  const catalogue = appCatalogue({
    metadata,
    providers: [
      {
        tables: {
          x_item: {
            entity: 'x_item',
            idColumn: 'x_itemid',
            nameColumn: 'x_name',
            fields: { x_name: { type: 'text' } },
          },
        },
      },
    ],
  });
  assert.equal(catalogue.tables.x_item.commands[0].label, 'Reviser');
  const index = createModelDrivenMetadataIndex({ metadata, ribbonDocuments: metadata.modelDrivenRibbonDocuments });
  const commands = index.query({ componentKeys: ['command:x_item:x.form.review'] }).catalogue.commands;
  assert.equal(commands.find((command) => command.id === 'x.Form.Review').label, 'Reviser');
  assert.equal(metadata.modelDrivenRibbonDocuments[0].xml, xml);
});
