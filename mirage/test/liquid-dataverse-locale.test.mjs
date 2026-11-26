// @test-kind contract: the local Liquid reader uses the selected portal language for imported choice labels and the Knowledge language join
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { nativeFormControlIds } from '../lib/native-postback.mjs';
import { makeTemporaryDirectory, ownedFixture } from '../testing/owned-fixture.mjs';

const ITEM = 'ab000000-0000-4000-8000-000000000001';
const ENGLISH = 'ab000000-0000-4000-8000-000000000002';
const FRENCH = 'ab000000-0000-4000-8000-000000000003';
const template = `
{% fetchxml choices %}<fetch><entity name="locale_item"><attribute name="item_choice" alias="localized_choice"/></entity></fetch>{% endfetchxml %}
<section id="fetch">{% for row in choices.results.entities %}{{ row.localized_choice.value }}:{{ row.localized_choice.label }}{% endfor %}</section>
<section id="entity">{{ entities.locale_item["${ITEM}"].item_choice.label }}</section>
{% fetchxml articles %}
  <fetch><entity name="knowledgearticle"><attribute name="title"/>
    <link-entity name="languagelocale" from="languagelocaleid" to="languagelocaleid">
      <filter><condition attribute="code" operator="eq" value="{{ website.selected_language.code }}"/></filter>
    </link-entity>
  </entity></fetch>
{% endfetchxml %}
<section id="articles">{% for row in articles.results.entities %}{{ row.title }}{% endfor %}</section>`;

async function writeLocaleFixture(root, source) {
  const files = {
    'site/website.yml': 'adx_websiteid: site\nadx_name: Localized database\nadx_defaultlanguage: english',
    'site/websitelanguage.yml':
      '- adx_websitelanguageid: english\n  adx_name: English\n  adx_languagecode: en-US\n  adx_lcid: 1033\n' +
      '- adx_websitelanguageid: french\n  adx_name: French\n  adx_languagecode: fr-FR\n  adx_lcid: 1036\n',
    'site/sitesetting.yml': 'adx_name: MultiLanguage/DisplayLanguageCodeInURL\nadx_value: true',
    'site/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: page',
    'site/Home.pagetemplate.yml': 'adx_pagetemplateid: page\nadx_webtemplateid: template',
    'site/Home.webtemplate.yml': 'adx_webtemplateid: template\nadx_name: Home',
    'site/Home.webtemplate.source.html': source,
    'solution/Entities/locale_item/Entity.xml': `<Entity><Name>locale_item</Name><EntityInfo><entity Name="locale_item">
    <EntitySetName>locale_items</EntitySetName><PrimaryIdAttribute>locale_itemid</PrimaryIdAttribute>
    <attributes><attribute PhysicalName="locale_itemid"><Name>locale_itemid</Name><Type>primarykey</Type></attribute>
    <attribute PhysicalName="item_choice"><Name>item_choice</Name><Type>picklist</Type>
    <optionset Name="locale_item_choice"><OptionSetType>picklist</OptionSetType><options>
      <option value="1"><labels><label description="Approved" languagecode="1033"/><label description="Approuvé" languagecode="1036"/></labels></option>
    </options></optionset></attribute></attributes></entity></EntityInfo></Entity>`,
  };
  for (const [relative, contents] of Object.entries(files)) {
    const filename = path.join(root, relative);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, contents);
  }
}

for (const liquidFetchExecution of ['eager', 'lazy-query-drop'])
  test(`${liquidFetchExecution} Liquid reads use the request LCID and the exact selected Knowledge locale join`, async (t) => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'liquid-dataverse-locale-'));
    ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
    await writeLocaleFixture(root, template);
    const app = await createSimulator({
      sourceDir: path.join(root, 'site'),
      solutionRoots: [path.join(root, 'solution')],
      projectRoot: root,
      watch: false,
      observed: { liquidFetchExecution, evidence: 'Invented language fixture for local execution in both modes' },
      initial: {
        mappings: {
          knowledgearticle: { entitySet: 'knowledgearticles', idColumn: 'knowledgearticleid', nameColumn: 'title' },
          languagelocale: { entitySet: 'languagelocales', idColumn: 'languagelocaleid', nameColumn: 'code' },
        },
        tables: {
          locale_item: [{ locale_itemid: ITEM, item_choice: 1 }],
          knowledgearticle: [
            { knowledgearticleid: 'article-en', languagelocaleid: ENGLISH, title: 'English article' },
            { knowledgearticleid: 'article-fr', languagelocaleid: FRENCH, title: 'French article' },
          ],
          languagelocale: [
            { languagelocaleid: ENGLISH, code: 'en-US' },
            { languagelocaleid: FRENCH, code: 'fr-FR' },
          ],
        },
        permissions: ['locale_item', 'knowledgearticle'].map((entity) => ({
          id: entity,
          entity,
          scope: 'global',
          operations: ['read'],
        })),
      },
    });
    ownedFixture(t).add(() => app.close());
    assert.equal(app.store.tableRows('locale_item').length, 1, 'the invented item is present before rendering');
    for (const [language, choice, article] of [
      ['en-US', 'Approved', 'English article'],
      ['fr-FR', 'Approuvé', 'French article'],
    ]) {
      const response = await fetch(`${app.url}/${language}/`);
      assert.equal(response.status, 200);
      const html = await response.text();
      const value = (id) => new RegExp(`<section id="${id}">([^<]*)</section>`).exec(html)?.[1];
      assert.equal(value('fetch'), `1:${choice}`, `${language}\n${html.match(/<section[^>]*>[^<]*<\/section>/g)}`);
      assert.equal(value('entity'), choice);
      assert.equal(value('articles'), article);
    }
  });

// @test-kind contract: local Liquid, signed grids and native forms use published labels for an API-created global choice column
test('Liquid, a signed grid and native forms use an API-created global choice', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'liquid-global-choice-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const globalChoiceTemplate = `
{% fetchxml choices %}<fetch><entity name="locale_item"><attribute name="new_status_choice" alias="bound_choice"/></entity></fetch>{% endfetchxml %}
<section id="fetch">{% for row in choices.results.entities %}{{ row.bound_choice.value }}:{{ row.bound_choice.label }}{% endfor %}</section>
<section id="entity">{{ entities.locale_item["${ITEM}"].new_status_choice.label }}</section>`;
  await writeLocaleFixture(
    root,
    globalChoiceTemplate +
      `
{% include 'entity_list' key: 'Choice list' %}
{% if request.params.variant == 'override' %}
{% entityform name: 'Override form' %}
{% elsif request.params.variant == 'tags' %}
{% entityform name: 'Tags form' %}
{% else %}
{% entityform name: 'Choice form' %}
{% endif %}
`,
  );
  const choiceForm = 'ac000000-0000-4000-8000-000000000002';
  const overrideForm = 'ac000000-0000-4000-8000-000000000003';
  const tagsForm = 'ac000000-0000-4000-8000-000000000004';
  for (const [name, id] of [
    ['Choice form', choiceForm],
    ['Override form', overrideForm],
    ['Tags form', tagsForm],
  ])
    await fs.writeFile(
      path.join(root, 'site', `${name}.basicform.yml`),
      `adx_entityformid: ${id}\nadx_name: ${name}\nadx_entityname: locale_item\nadx_mode: 100000001`,
    );
  const choiceFilter = {
    entity: {
      name: 'locale_item',
      filters: [
        {
          'adx.id': 'shared',
          'adx.attribute': 'new_status_choice',
          'adx.filtertype': 'dynamicpicklistset',
          'adx.uiselectionmode': 'Dropdown',
        },
        {
          'adx.id': 'tags',
          'adx.attribute': 'new_status_tags',
          'adx.filtertype': 'dynamicpicklistset',
          'adx.uiselectionmode': 'Dropdown',
        },
      ],
    },
  };
  await fs.writeFile(
    path.join(root, 'site', 'Choice.list.yml'),
    [
      'adx_entitylistid: ac000000-0000-4000-8000-000000000001',
      'adx_name: Choice list',
      'adx_entityname: locale_item',
      'adx_filter_enabled: true',
      'adx_filter_definition: |-',
      `  ${JSON.stringify(choiceFilter)}`,
    ].join('\n'),
  );

  const appId = 'ab000000-0000-4000-8000-000000000004';
  const secretVariable = `LIQUID_GLOBAL_CHOICE_${process.pid}`;
  process.env[secretVariable] = 'loopback-global-choice';
  t.after(() => {
    delete process.env[secretVariable];
  });
  const app = await createSimulator({
    sourceDir: path.join(root, 'site'),
    solutionRoots: [path.join(root, 'solution')],
    projectRoot: root,
    watch: false,
    observed: {
      liquidFetchExecution: 'lazy-query-drop',
      nativeFormTransport: 'postback',
      evidence: 'Invented local global choice fixture',
    },
    initial: {
      tables: { locale_item: [{ locale_itemid: ITEM }] },
      simulator: {
        componentSchemas: {
          'Choice list': {
            entity: 'locale_item',
            fields: [
              { name: 'new_status_choice', label: 'Choice' },
              { name: 'new_status_tags', label: 'Tags' },
            ],
          },
          'Choice form': {
            entity: 'locale_item',
            mode: 100000001,
            fields: [{ name: 'new_status_choice', label: 'Choice', dataverseType: 'picklist' }],
          },
          'Tags form': {
            entity: 'locale_item',
            mode: 100000001,
            fields: [{ name: 'new_status_tags', label: 'Tags', dataverseType: 'multiselectpicklist' }],
          },
          'Override form': {
            entity: 'locale_item',
            mode: 100000001,
            fields: [
              {
                name: 'new_status_choice',
                label: 'Choice',
                dataverseType: 'picklist',
                options: [{ value: 100000002, label: 'Choix personnalisé' }],
              },
            ],
          },
        },
      },
      permissions: [{ id: 'read-items', entity: 'locale_item', scope: 'global', operations: ['read', 'update'] }],
    },
    dataverse: {
      enabled: true,
      applications: [
        {
          appId,
          displayName: 'Global choice test application',
          secretEnvironmentVariable: secretVariable,
          roles: ['System Administrator'],
        },
      ],
    },
  });
  ownedFixture(t).add(() => app.close());
  const { origin, tenantId } = app.dataverse;
  const issued = await fetch(`${origin}/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: appId,
      client_secret: 'loopback-global-choice',
      scope: `${origin}/.default`,
    }),
  });
  assert.equal(issued.status, 200);
  const token = (await issued.json()).access_token;
  const write = async (method, target, body, extra = {}) => {
    const response = await fetch(`${origin}/api/data/v9.2${target}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 204, await response.text());
  };
  const label = (translations) => ({
    LocalizedLabels: Object.entries(translations).map(([code, text]) => ({ Label: text, LanguageCode: Number(code) })),
  });
  await write('POST', '/GlobalOptionSetDefinitions', {
    Name: 'new_shared_status',
    Options: [
      { Value: 100000001, Label: label({ 1033: 'Accepted', 1036: 'Accepté' }) },
      { Value: 100000002, Label: label({ 1033: 'Pending' }) },
    ],
  });
  await write('POST', "/EntityDefinitions(LogicalName='locale_item')/Attributes", {
    '@odata.type': '#Microsoft.Dynamics.CRM.PicklistAttributeMetadata',
    SchemaName: 'new_status_choice',
    'GlobalOptionSet@odata.bind': "/GlobalOptionSetDefinitions(Name='new_shared_status')",
  });
  await write('POST', "/EntityDefinitions(LogicalName='locale_item')/Attributes", {
    '@odata.type': '#Microsoft.Dynamics.CRM.MultiSelectPicklistAttributeMetadata',
    SchemaName: 'new_status_tags',
    'GlobalOptionSet@odata.bind': "/GlobalOptionSetDefinitions(Name='new_shared_status')",
  });
  const record = `/locale_items(${ITEM})`;
  await write('PATCH', record, { new_status_choice: 100000001, new_status_tags: '100000001,100000002' });
  const assertLabels = async (language, value, expected) => {
    const page = await fetch(`${app.url}/${language}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    const text = (id) => new RegExp(`<section id="${id}">([^<]*)</section>`).exec(html)?.[1];
    assert.equal(text('fetch'), `${value}:${expected}`, language);
    assert.equal(text('entity'), expected, language);
  };

  await assertLabels('en-US', 100000001, 'Accepted');
  await assertLabels('fr-FR', 100000001, 'Accepté');
  const localizedPage = await (await fetch(`${app.url}/fr-FR/`)).text();
  const encoded = /data-view-layouts="([^"]+)"/.exec(localizedPage)?.[1];
  assert.ok(encoded, 'French page rendered the grid');
  const [layout] = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  const gridRows = async (metaFilter) => {
    const response = await fetch(`${app.url}/_services/entity-grid-data.json/site`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', __RequestVerificationToken: app.portalToken },
      body: JSON.stringify({
        base64SecureConfiguration: layout.Base64SecureConfiguration,
        language: { lcid: 1041 },
        metaFilter,
      }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).Records;
  };
  const row = (await gridRows())[0].Attributes.find(({ Name }) => Name === 'new_status_choice');
  assert.equal(row.DisplayValue, 'Accepté');
  assert.equal(row.Value.Value, 100000001);
  const formUrl = (variant = '') => `${app.url}/fr-FR/?id=${ITEM}${variant ? '&variant=' + variant : ''}`;
  const readOptions = async (variant) => {
    const response = await fetch(formUrl(variant));
    assert.equal(response.status, 200);
    const html = await response.text();
    const field = /<select[^>]*id="new_status_choice"[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1];
    assert.ok(field, 'the authored form field renders as a native picklist');
    return [...field.matchAll(/<option[^>]*value="(\d+)"[^>]*>([^<]*)<\/option>/g)].map(([, value, label]) => [
      Number(value),
      label,
    ]);
  };
  const postChoice = (id, value, variant) => {
    const controls = nativeFormControlIds('entityform', id);
    return fetch(formUrl(variant), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams([
        ['__EVENTTARGET', controls.buttons + 'UpdateButton'],
        ['__EVENTARGUMENT', ''],
        ['__RequestVerificationToken', app.portalToken],
        [controls.names + 'new_status_choice', String(value)],
      ]),
    });
  };
  assert.deepEqual(await readOptions(), [
    [100000001, 'Accepté'],
    [100000002, 'Pending'],
  ]);
  assert.deepEqual(await readOptions('override'), [[100000002, 'Choix personnalisé']]);
  const denied = await postChoice(choiceForm, 100000099);
  assert.equal(denied.status, 500);
  assert.equal(app.store.tableRows('locale_item')[0].new_status_choice, 100000001);
  const overrideDenied = await postChoice(overrideForm, 100000001, 'override');
  assert.equal(overrideDenied.status, 500);
  assert.equal(app.store.tableRows('locale_item')[0].new_status_choice, 100000001);
  await write(
    'POST',
    '/UpdateOptionValue',
    { OptionSetName: 'new_shared_status', Value: 100000001, Label: label({ 1036: 'Confirmé' }) },
    { 'MSCRM.MergeLabels': 'true' },
  );
  await assertLabels('fr-FR', 100000001, 'Confirmé');
  await assertLabels('en-US', 100000001, 'Accepted');
  assert.deepEqual(await readOptions(), [
    [100000001, 'Confirmé'],
    [100000002, 'Pending'],
  ]);
  const saved = await postChoice(choiceForm, 100000002);
  assert.equal(saved.status, 200, await saved.text());
  await assertLabels('fr-FR', 100000002, 'Pending');
  assert.equal(app.store.tableRows('locale_item')[0].new_status_choice, 100000002);

  await t.test('native grid multiselect labels use the signed LCID and retain numeric selections', async () => {
    const tags = (await gridRows())[0].Attributes.find(({ Name }) => Name === 'new_status_tags');
    assert.equal(tags.DisplayValue, 'Confirmé; Pending');
    assert.equal(tags.FormattedValue, 'Pending');
    assert.deepEqual(
      tags.Value.map(({ Value }) => Value),
      [100000001, 100000002],
    );
  });

  await t.test('dynamic list filter shows localized choices and keeps numeric equality conditions', async () => {
    const other = 'ab000000-0000-4000-8000-000000000005';
    await write('POST', '/locale_items', { locale_itemid: other, new_status_choice: 100000001 });
    const selected = 'shared=100000002';
    const response = await fetch(`${app.url}/fr-FR/?mf=${encodeURIComponent(selected)}`);
    assert.equal(response.status, 200);
    const html = await response.text();
    const select = /<select[^>]*name="shared"[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1];
    assert.ok(select, 'authored dynamic choice filter is present');
    assert.match(select, /value="100000001"[^>]*>Confirmé<\/option>/);
    assert.match(select, /value="100000002"[^>]*selected[^>]*>Pending<\/option>/);
    assert.deepEqual(
      (await gridRows(selected)).map(({ Id }) => Id),
      [ITEM],
    );
    assert.deepEqual(
      (await gridRows('shared=100000001')).map(({ Id }) => Id),
      [other],
    );
    assert.deepEqual(
      (await gridRows('shared=100000099')).map(({ Id }) => Id),
      [],
    );
  });

  // @test-kind unproven: local model of a native Basic Form choices (multi-select) field bound to a global choice: the control lists the published options in the page language and a posted value outside them is refused as Dataverse refuses it (PicklistValueOutOfRange); no hosted capture of a bound choices field
  await t.test('native form multiselect uses the bound global choice and refuses unlisted values', async () => {
    const html = await (await fetch(formUrl('tags'))).text();
    // The control's option metadata (the PCF host manifest) lists the bound choice's options in the page language.
    const decoded = html.replaceAll('&quot;', '"');
    const listed = new Map(
      [...decoded.matchAll(/"Value":(\d+),"Label":\{"LocalizedLabels":\[\{"Label":"([^"]*)"/g)].map(
        ([, value, text]) => [Number(value), text],
      ),
    );
    assert.deepEqual(
      [...listed],
      [
        [100000001, 'Confirmé'],
        [100000002, 'Pending'],
      ],
    );
    const postTags = (value) => {
      const controls = nativeFormControlIds('entityform', tagsForm);
      return fetch(formUrl('tags'), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams([
          ['__EVENTTARGET', controls.buttons + 'UpdateButton'],
          ['__EVENTARGUMENT', ''],
          ['__RequestVerificationToken', app.portalToken],
          [controls.names + 'new_status_tags', value],
        ]),
      });
    };
    const before = app.store.tableRows('locale_item').find((row) => row.locale_itemid === ITEM).new_status_tags;
    const refused = await postTags('100000002,100000099');
    assert.notEqual(refused.status, 200);
    assert.match(await refused.text(), /100000099|outside the valid range|PicklistValueOutOfRange/);
    assert.equal(app.store.tableRows('locale_item').find((row) => row.locale_itemid === ITEM).new_status_tags, before);
    const saved = await postTags('100000002');
    assert.equal(saved.status, 200, await saved.text());
    assert.equal(
      String(app.store.tableRows('locale_item').find((row) => row.locale_itemid === ITEM).new_status_tags),
      '100000002',
    );
  });

  // @test-kind unproven: local model of a dynamic list filter on a choices (multi-select) column: Learn documents contain-values as the operator for one of the selected values; the hosted filter's operator is not captured
  await t.test('dynamic list filter on a choices column matches rows holding the selected option', async () => {
    const tagged = 'ab000000-0000-4000-8000-000000000006';
    await write('POST', '/locale_items', { locale_itemid: tagged, new_status_tags: '100000001,100000002' });
    const html = await (await fetch(`${app.url}/fr-FR/?mf=${encodeURIComponent('tags=100000001')}`)).text();
    const select = /<select[^>]*name="tags"[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1];
    assert.ok(select, 'authored dynamic choices filter is present');
    assert.match(select, /value="100000001"[^>]*selected[^>]*>Confirmé<\/option>/);
    assert.deepEqual(
      (await gridRows('tags=100000001')).map(({ Id }) => Id),
      [tagged],
    );
    assert.deepEqual((await gridRows('tags=100000002')).map(({ Id }) => Id).sort(), [ITEM, tagged].sort());
    assert.deepEqual(
      (await gridRows('tags=100000099')).map(({ Id }) => Id),
      [],
    );
  });
});
